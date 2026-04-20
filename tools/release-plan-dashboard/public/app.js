(function () {
  "use strict";

  const AUTO_REFRESH_INTERVAL = 60 * 60; // seconds (1 hour)
  let refreshCountdown = AUTO_REFRESH_INTERVAL;
  let countdownTimer = null;
  let allPlans = [];

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ── Load user info ────────────────────────────────────────────
  async function loadUserInfo() {
    try {
      const res = await fetch("/auth/me");
      const user = await res.json();
      const el = $("#user-info");
      if (user && el) {
        el.innerHTML = `<span class="user-name">${esc(user.name)}</span> <a href="/auth/logout" class="logout-link">Logout</a>`;
      }
    } catch { /* ignore */ }
  }
  loadUserInfo();

  // ── Fetch data ──────────────────────────────────────────────
  async function fetchPlans() {
    showLoading(true);
    hideError();
    try {
      const params = new URLSearchParams(window.location.search);
      const planId = params.get("releasePlan") || params.get("releaseplan");
      let url = "/api/release-plans";
      if (planId) url += `?releasePlan=${encodeURIComponent(planId)}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to load release plans (${res.status}).`);
      }
      const data = await res.json();
      allPlans = data.plans || [];

      // Apply URL filter param if present
      const urlFilter = params.get("filter") || "";
      if (urlFilter) {
        const searchBox = $("#search-box");
        if (searchBox) searchBox.value = urlFilter;
      }

      render(allPlans);
      updateTimestamp(data.fetchedAt);
    } catch (err) {
      showError(err.message);
    } finally {
      showLoading(false);
      resetCountdown();
    }
  }

  // ── Classify plane ─────────────────────────────────────────
  function classifyPlane(p) {
    // A plan can be both; we put it in mgmt if mgmt, data if data, mgmt as fallback
    if (p.mgmtScope === "Yes") return "mgmt";
    if (p.dataScope === "Yes") return "data";
    return "mgmt"; // default bucket
  }

  // A language is excluded only when ReleaseExclusionStatus is Approved or Requested
  function isLangExcluded(exclusionStatus) {
    const val = (exclusionStatus || "").toLowerCase().trim();
    return val === "approved" || val === "requested";
  }

  // ── Compute current step and action for a release plan ───────
  function computeCurrentStep(p) {
    const rt = (p.releaseType || "").toLowerCase();
    const isPrivatePreview = rt.includes("private");
    if (p.state === "Finished") {
      if (isPrivatePreview) return { status: "Completed", action: "", statusClass: "step-released" };
      return { status: "Released", action: "", statusClass: "step-released" };
    }

    const specPrUrl = (p.apiSpec && p.apiSpec.specPrUrl) || "";
    const apiReady = (p.apiReadiness || "").toLowerCase();

    // Step 1: API Spec checks
    if (!specPrUrl) return { status: "API Spec Not Available", action: "Service Team", statusClass: "step-blocked" };
    if (apiReady !== "completed") return { status: "API Spec In Progress", action: "Spec PR Reviewer", statusClass: "step-inprogress" };

    // API spec is merged — check SDK status across non-excluded languages
    const langs = p.languages || {};
    const langKeys = Object.keys(langs);
    const activeLangs = langKeys.filter(k => !isLangExcluded(langs[k].exclusionStatus));
    if (!activeLangs.length) return { status: "No Active Languages", action: "", statusClass: "step-blocked" };

    // Check generation status
    const genFailed = activeLangs.some(k => {
      const gs = (langs[k].generationStatus || "").toLowerCase();
      return gs.includes("failed") || gs.includes("error");
    });
    if (genFailed) return { status: "SDK Generation Failed", action: "Service Team", statusClass: "step-failed" };

    // Check if any SDK PRs exist
    const langsWithPr = activeLangs.filter(k => langs[k].sdkPrUrl);
    if (!langsWithPr.length) return { status: "SDK To Be Generated", action: "Service Team", statusClass: "step-pending" };

    // Check PR statuses (use GitHub status if available, fall back to DevOps)
    const prStatuses = langsWithPr.map(k => {
      const l = langs[k];
      return (l.sdkPrGitHubStatus || l.prStatus || "").toLowerCase();
    });
    const allMerged = prStatuses.every(s => s.includes("merged") || s.includes("completed"));
    const allApproved = langsWithPr.every(k => {
      const d = langs[k].prDetails;
      return d && d.isApproved;
    });

    // Check release statuses
    const releaseStatuses = activeLangs.map(k => (langs[k].releaseStatus || "").toLowerCase());
    const allReleased = releaseStatuses.every(s => s.includes("completed") || s.includes("released"));

    if (allMerged && allReleased) return { status: "Released", action: "", statusClass: "step-released" };
    if (allMerged) return { status: "SDK Ready To Be Released", action: "Service Team", statusClass: "step-ready" };
    if (allApproved) return { status: "SDK To Be Merged", action: "Service Team", statusClass: "step-pending" };

    // Some PRs not yet approved/merged
    return { status: "SDK Review In Progress", action: "SDK PR Reviewer", statusClass: "step-inprogress" };
  }

  // ── Classify release status ─────────────────────────────────
  // Returns "partial" if at least one language is released/completed
  // but not all non-excluded languages are released.
  function isPartiallyReleased(p) {
    const langs = p.languages || {};
    const langKeys = Object.keys(langs);
    if (!langKeys.length) return false;

    let releasedCount = 0;
    let excludedCount = 0;
    for (const lang of langKeys) {
      const l = langs[lang];
      const rel = (l.releaseStatus || "").toLowerCase();
      if (isLangExcluded(l.exclusionStatus)) excludedCount++;
      if (rel.includes("completed") || rel.includes("released")) releasedCount++;
    }
    const nonExcluded = langKeys.length - excludedCount;
    return releasedCount > 0 && releasedCount < nonExcluded;
  }

  // Parse "MMMM yyyy" into a sortable Date (or far future if unparseable)
  function parseReleaseMonth(str) {
    if (!str) return new Date(9999, 0);
    const d = new Date(str + " 1");
    return isNaN(d.getTime()) ? new Date(9999, 0) : d;
  }

  function isPastDue(p) {
    if (p.state === "Finished") return false;
    if (!p.releaseMonth) return false;
    const target = parseReleaseMonth(p.releaseMonth);
    if (target.getFullYear() === 9999) return false;
    // Past due if the target month is strictly before this month
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    return target < thisMonth;
  }

  // ── Detect possible duplicate release plans ──────────────────
  function detectDuplicates(plans) {
    plans.forEach(p => { delete p._duplicateOf; });

    // Group by plane + product name + release type
    const groups = new Map();
    for (const p of plans) {
      if (p.state === "Finished") continue;
      const product = (p.productName || "").toLowerCase().trim();
      const rt = (p.releaseType || "").toLowerCase().trim();
      if (!product) continue;
      const plane = classifyPlane(p);
      const key = `${plane}|${product}|${rt}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    for (const [, group] of groups) {
      if (group.length < 2) continue;

      let main = null;

      // Prefer one with SDK PRs linked
      const withPr = group.filter(p => {
        const langs = p.languages || {};
        return Object.values(langs).some(l => l.sdkPrUrl && !isLangExcluded(l.exclusionStatus));
      });
      const withoutPr = group.filter(p => {
        const langs = p.languages || {};
        return !Object.values(langs).some(l => l.sdkPrUrl && !isLangExcluded(l.exclusionStatus));
      });

      if (withPr.length >= 1 && withoutPr.length >= 1) {
        main = withPr[0];
        for (const dup of withoutPr) {
          dup._duplicateOf = main.releasePlanId || main.title;
        }
        continue;
      }

      // Prefer In Progress over New/Not Started
      const inProg = group.filter(p => p.state === "In Progress");
      const newOnes = group.filter(p => p.state === "New" || p.state === "Not Started");
      if (inProg.length >= 1 && newOnes.length >= 1) {
        main = inProg[0];
        for (const dup of newOnes) {
          dup._duplicateOf = main.releasePlanId || main.title;
        }
      }
    }
  }

  // ── Render ──────────────────────────────────────────────────
  function render(plans) {
    detectDuplicates(plans);
    const filter = ($("#search-box").value || "").toLowerCase();
    const filtered = filter
      ? plans.filter(
          (p) =>
            p.title.toLowerCase().includes(filter) ||
            (p.productName || "").toLowerCase().includes(filter) ||
            (p.ownerPM || "").toLowerCase().includes(filter) ||
            (p.submittedBy || "").toLowerCase().includes(filter) ||
            String(p.releasePlanId).includes(filter)
        )
      : plans;

    const mgmt = filtered.filter((p) => classifyPlane(p) === "mgmt");
    const data = filtered.filter((p) => classifyPlane(p) === "data");

    function sortByReleaseMonth(a, b) {
      return parseReleaseMonth(a.releaseMonth) - parseReleaseMonth(b.releaseMonth);
    }

    function splitByState(arr) {
      const partial = [];
      const inProgress = [];
      const newItems = [];
      const finished = [];

      for (const p of arr) {
        if (p.state === "Finished") {
          finished.push(p);
        } else if (p.state === "New" || p.state === "Not Started") {
          newItems.push(p);
        } else if (isPartiallyReleased(p)) {
          partial.push(p);
        } else {
          inProgress.push(p);
        }
      }

      inProgress.sort(sortByReleaseMonth);
      partial.sort(sortByReleaseMonth);
      newItems.sort(sortByReleaseMonth);
      // Filter finished: only this month or last month, max 20
      const now = new Date();
      const thisMonthKey = `${now.toLocaleString("en-US", { month: "long" })} ${now.getFullYear()}`.toLowerCase();
      const lastDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonthKey = `${lastDate.toLocaleString("en-US", { month: "long" })} ${lastDate.getFullYear()}`.toLowerCase();
      const recentFinished = finished.filter(p => {
        const rm = (p.releaseMonth || "").toLowerCase();
        return rm.includes(thisMonthKey) || rm.includes(lastMonthKey);
      });
      recentFinished.sort(sortByReleaseMonth);
      const cappedFinished = recentFinished.slice(0, 20);

      return { inProgress, partial, newItems, finished: cappedFinished };
    }

    const mgmtSplit = splitByState(mgmt);
    const dataSplit = splitByState(data);

    renderList("list-mgmt-inprogress", mgmtSplit.inProgress);
    renderList("list-mgmt-partial", mgmtSplit.partial);
    renderList("list-mgmt-new", mgmtSplit.newItems);
    renderList("list-mgmt-finished", mgmtSplit.finished);

    renderList("list-data-inprogress", dataSplit.inProgress);
    renderList("list-data-partial", dataSplit.partial);
    renderList("list-data-new", dataSplit.newItems);
    renderList("list-data-finished", dataSplit.finished);

    updateCount("section-mgmt-inprogress", mgmtSplit.inProgress.length);
    updateCount("section-mgmt-partial", mgmtSplit.partial.length);
    updateCount("section-mgmt-new", mgmtSplit.newItems.length);
    updateCount("section-mgmt-finished", mgmtSplit.finished.length);

    updateCount("section-data-inprogress", dataSplit.inProgress.length);
    updateCount("section-data-partial", dataSplit.partial.length);
    updateCount("section-data-new", dataSplit.newItems.length);
    updateCount("section-data-finished", dataSplit.finished.length);

    // Detect if filtering is active
    const params = new URLSearchParams(window.location.search);
    const singlePlan = params.get("releasePlan") || params.get("releaseplan");
    const isFiltering = !!(filter || singlePlan);

    // Hide empty sections when filtering; show all when not filtering
    const sectionCounts = {
      "section-mgmt-inprogress": mgmtSplit.inProgress.length,
      "section-mgmt-partial": mgmtSplit.partial.length,
      "section-mgmt-new": mgmtSplit.newItems.length,
      "section-mgmt-finished": mgmtSplit.finished.length,
      "section-data-inprogress": dataSplit.inProgress.length,
      "section-data-partial": dataSplit.partial.length,
      "section-data-new": dataSplit.newItems.length,
      "section-data-finished": dataSplit.finished.length,
    };
    for (const [id, count] of Object.entries(sectionCounts)) {
      const sec = document.getElementById(id);
      if (sec) sec.style.display = (isFiltering && count === 0) ? "none" : "";
    }

    // Hide plane headings when single releasePlan param or when plane has no items
    const mgmtHeading = $(".plane-heading-mgmt");
    const dataHeading = $(".plane-heading-data");
    if (singlePlan) {
      if (mgmtHeading) mgmtHeading.style.display = mgmt.length ? "" : "none";
      if (dataHeading) dataHeading.style.display = data.length ? "" : "none";
    } else {
      if (mgmtHeading) mgmtHeading.style.display = "";
      if (dataHeading) dataHeading.style.display = "";
    }

    // Stats
    const totalInProgress = mgmtSplit.inProgress.length + dataSplit.inProgress.length;
    const totalPartial = mgmtSplit.partial.length + dataSplit.partial.length;
    const totalNew = mgmtSplit.newItems.length + dataSplit.newItems.length;
    const totalFinished = mgmtSplit.finished.length + dataSplit.finished.length;

    $("#stat-total").textContent = filtered.length;
    $("#stat-inprogress").textContent = totalInProgress;
    $("#stat-partial").textContent = totalPartial;
    $("#stat-new").textContent = totalNew;
    $("#stat-finished").textContent = totalFinished;
    $("#stat-mgmt").textContent = `(${mgmt.length})`;
    $("#stat-data").textContent = `(${data.length})`;
    $("#stats-bar").hidden = !!singlePlan;
    $("#content").hidden = false;
    bindSectionHeaders();
  }

  function renderList(containerId, plans) {
    const container = document.getElementById(containerId);
    if (!plans.length) {
      container.innerHTML =
        '<p style="padding:8px;color:#605e5c;font-size:.88rem;">No items.</p>';
      return;
    }
    container.innerHTML = plans.map(cardHTML).join("");
    // Store plan data references on cards for step recomputation
    container.querySelectorAll(".plan-card").forEach((cardEl) => {
      const planId = parseInt(cardEl.dataset.planId, 10);
      const plan = plans.find(p => p.id === planId);
      if (plan) cardEl._planData = plan;
    });
    // Attach collapse/expand handlers for cards (with lazy PR detail loading)
    container.querySelectorAll(".card-summary").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        const details = el.nextElementSibling;
        const opening = !details.classList.contains("open");
        details.classList.toggle("open");
        el.classList.toggle("expanded");
        if (opening && !el.dataset.prLoaded) {
          el.dataset.prLoaded = "1";
          const card = el.closest(".plan-card");
          lazyLoadPrDetails(details, card);
        }
      });
    });
    // Attach product toggle handlers
    container.querySelectorAll(".product-toggle").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        e.stopPropagation();
        const details = el.nextElementSibling;
        const caret = el.querySelector(".product-caret");
        if (details.style.display === "none") {
          details.style.display = "";
          if (caret) caret.innerHTML = "&#9660;";
        } else {
          details.style.display = "none";
          if (caret) caret.innerHTML = "&#9654;";
        }
      });
    });
  }

  function updateCount(sectionId, count) {
    const sec = document.getElementById(sectionId);
    const span = sec.querySelector(".section-count");
    span.textContent = `(${count})`;
  }

  // ── Card HTML ───────────────────────────────────────────────
  function apiReadinessBadge(p) {
    if (p.apiReadiness === "completed") {
      return '<span class="badge badge-api-completed">API Ready</span>';
    }
    if (p.apiReadiness === "pending") {
      return '<span class="badge badge-api-pending">API Pending</span>';
    }
    return "";
  }

  function cardHTML(p) {
    const pastDue = isPastDue(p);
    const cardClass = pastDue ? "plan-card past-due" : "plan-card";
    const step = computeCurrentStep(p);
    const copilotBadge = (p.createdUsing || "").toLowerCase() === "copilot"
      ? '<span class="badge badge-created-using">Copilot</span>'
      : "";
    const rt = (p.releaseType || "").toLowerCase();
    const sdkTypeBadge = rt.includes("beta") || rt.includes("preview")
      ? '<span class="badge badge-sdk-beta">Beta</span>'
      : rt.includes("ga") || rt.includes("stable")
        ? '<span class="badge badge-sdk-stable">Stable</span>'
        : "";
    const isTerminal = step.status === "Released" || step.status === "Completed";
    const finishedBadge = (p.state === "Finished")
      ? `<span class="badge badge-finished-indicator">✔ ${esc(step.status)}</span>`
      : "";
    const stepHTML = (step.status && !isTerminal)
      ? `<span class="step-badge ${step.statusClass}">${esc(step.status)}</span>`
      : "";
    const actionHTML = (step.action && !isTerminal)
      ? `<span class="action-badge">Action required from: ${esc(step.action)}</span>`
      : "";
    const dupHTML = p._duplicateOf
      ? `<span class="badge badge-duplicate">⚠️ Duplicate of ${esc(String(p._duplicateOf))}</span>`
      : "";
    return `
    <div class="${cardClass}" data-plan-id="${p.id}">
      <div class="card-summary">
        <span class="card-chevron">&#9654;</span>
        <div class="card-title">
          ${esc(p.title)} ${copilotBadge} ${sdkTypeBadge}
        </div>
        <div class="card-meta">
          ${p.releaseMonth ? `<span>${esc(p.releaseMonth)}</span>` : ""}
          ${p.submittedBy ? `<span class="card-submitter">${esc(p.submittedBy)}</span>` : ""}
          ${stepHTML}${actionHTML}${finishedBadge}${dupHTML}
          ${apiReadinessBadge(p)}
          ${pastDue ? '<span class="badge badge-pastdue">Past Due</span>' : ""}
        </div>
      </div>
      <div class="card-details">${detailHTML(p)}</div>
    </div>`;
  }

  // ── PR detail labels (checks, approval, mergeable) ──────────
  function prDetailLabels(l) {
    if (!l.prDetails) return "";
    const d = l.prDetails;
    const isMerged = (l.sdkPrGitHubStatus || l.prStatus || "").toLowerCase().includes("merged");
    let labels = "";
    if (d.failedChecks && d.failedChecks.length) {
      const tipText = esc(d.failedChecks.join(", "));
      labels += `<span class="pr-label pr-label-failed" title="${tipText}">${d.failedChecks.length} check(s) failed</span>`;
    }
    if (!isMerged && d.isApproved && d.approvedBy && d.approvedBy.length) {
      const tipText = "Approved by: " + esc(d.approvedBy.join(", "));
      labels += `<span class="pr-label pr-label-approved" title="${tipText}">Approved</span>`;
    }
    if (d.mergeable && d.mergeableState === "clean") {
      labels += '<span class="pr-label pr-label-mergeable">Ready to merge</span>';
    }
    return labels;
  }

  function detailHTML(p) {
    const specPath = p.specProjectPath || p.typeSpecPath || "";
    const step = computeCurrentStep(p);
    let html = '<div class="detail-meta">';
    // Current step highlight (hide for completed/released)
    const detailTerminal = step.status === "Released" || step.status === "Completed";
    if (step.status && !detailTerminal) {
      html += `<div class="detail-row detail-step-highlight">
        <strong>Current stage:</strong> <span class="step-badge ${step.statusClass}">${esc(step.status)}</span>`;
      if (step.action) html += ` <strong>Action required from:</strong> <span class="action-badge">${esc(step.action)}</span>`;
      html += `</div>`;
    }
    if (specPath) html += `<div class="detail-row"><strong>Spec Project Path:</strong> ${esc(specPath)}</div>`;
    // Work item link
    if (p.releasePlanId) {
      const wiUrl = `https://dev.azure.com/azure-sdk/Release/_workitems/edit/${p.id}`;
      html += `<div class="detail-row"><strong>Release Plan:</strong> <a href="${esc(wiUrl)}" target="_blank" rel="noopener">#${esc(String(p.releasePlanId))}</a> <span class="wi-warning">⚠️ Do not modify directly — use the <a href="https://aka.ms/azsdk/agent" target="_blank" rel="noopener">azsdk agent</a></span></div>`;
    }
    if (p.typeSpecPath && p.specProjectPath && p.typeSpecPath !== p.specProjectPath) {
      html += `<div class="detail-row" style="font-size:.8rem;color:#605e5c;"><em>DevOps TypeSpec Path: ${esc(p.typeSpecPath)}</em></div>`;
    }
    if (p.submittedBy) html += `<div class="detail-row"><strong>Submitted By:</strong> ${esc(p.submittedBy)}</div>`;
    if (p.releaseMonth) html += `<div class="detail-row"><strong>Release Month:</strong> ${esc(p.releaseMonth)}</div>`;
    if (p.releaseType) html += `<div class="detail-row"><strong>SDK Release Type:</strong> ${esc(p.releaseType)}</div>`;
    html += "</div>";

    // Expandable Product Details section
    if (p.productName) {
      html += `<div class="detail-group product-collapsible">
        <h4 class="product-toggle" style="cursor:pointer;user-select:none;">
          <span class="product-caret">&#9654;</span> Product: ${esc(p.productName)}
        </h4>
        <div class="product-details" style="display:none;">`;
      if (p.serviceName) html += `<div class="detail-row"><strong>Service Name:</strong> ${esc(p.serviceName)}</div>`;
      if (p.productId) {
        const treeUrl = `https://microsoftservicetree.com/products/${encodeURIComponent(p.productId)}`;
        html += `<div class="detail-row"><strong>Product ID:</strong> <a href="${esc(treeUrl)}" target="_blank" rel="noopener">${esc(p.productId)}</a></div>`;
      }
      if (p.productLifecycle) html += `<div class="detail-row"><strong>Product Lifecycle:</strong> ${esc(p.productLifecycle)}</div>`;
      if (p.ownerPM) html += `<div class="detail-row"><strong>Owner / PM:</strong> ${esc(p.ownerPM)}</div>`;
      html += `</div></div>`;
    }

    // SDK Languages table (hide for private preview)
    {
      const rpType = (p.releaseType || "").toLowerCase();
      const isPrivPrev = rpType.includes("private");
      if (isPrivPrev) {
        html += `<div class="detail-group private-preview-notice"><p>SDKs are not generated or released for private preview release plans.</p></div>`;
      } else {
      const langs = p.languages || {};
      const langKeys = Object.keys(langs);
      if (langKeys.length) {
        html += `<div class="detail-group"><h4>SDK Details</h4>
        <table class="sdk-table"><thead><tr>
          <th>Language</th><th>Package</th><th>SDK PR</th><th>PR Status</th>
          <th>Release Status</th>
        </tr></thead><tbody>`;
        for (const lang of langKeys) {
          const l = langs[lang];
          const excluded = isLangExcluded(l.exclusionStatus);
          const rowClass = excluded ? ' class="row-excluded"' : "";
          const prLink = l.sdkPrUrl
            ? `<a href="${esc(l.sdkPrUrl)}" target="_blank" rel="noopener">PR</a>`
            : "—";
          const prLabels = l.sdkPrUrl ? prDetailLabels(l) : "";
          const releaseDisplay = excluded ? "Excluded" : (l.releaseStatus || "");

          // Package labels: version (hide if released) + namespace approval + new package + API review
          let pkgLabels = "";
          const isReleased = (l.releaseStatus || "").toLowerCase().includes("released");
          if (l.pkgVersion && !isReleased) {
            pkgLabels += `<span class="pr-label pr-label-version">${esc(l.pkgVersion)}</span>`;
          }
          if (l.isNewPackage) {
            pkgLabels += '<span class="pr-label pr-label-new">New</span>';
            if (l.namespaceApproval && l.namespaceApproval.toLowerCase() !== "approved") {
              pkgLabels += `<span class="pr-label pr-label-ns-pending" title="Namespace: ${esc(l.namespaceApproval)}">${esc(l.namespaceApproval)}</span>`;
            }
          }
          if (l.apiReviewStatus && l.apiReviewStatus.toLowerCase() !== "pending") {
            const arLower = l.apiReviewStatus.toLowerCase();
            const arClass = arLower === "approved" ? "pr-label-approved" : "pr-label-api-pending";
            pkgLabels += `<span class="pr-label ${arClass}">API: ${esc(l.apiReviewStatus)}</span>`;
          }

          html += `<tr${rowClass}>
            <td><strong>${esc(lang)}</strong></td>
            <td>${esc(l.packageName) || "—"} ${pkgLabels}</td>
            <td>${prLink} ${prLabels}</td>
            <td>${statusSpan(l.sdkPrGitHubStatus || l.prStatus)}</td>
            <td>${statusSpan(releaseDisplay)}</td>
          </tr>`;
        }
        html += "</tbody></table></div>";
      }
      } // end else (not private preview)
    }

    // API Spec
    if (p.apiSpec) {
      const s = p.apiSpec;
      html += `<div class="detail-group"><h4>API Spec</h4>`;
      if (s.specPrUrl)
        html += `<div class="detail-row"><strong>Spec PR:</strong> <a href="${esc(s.specPrUrl)}" target="_blank" rel="noopener">${esc(s.specPrUrl)}</a></div>`;
      if (s.apiVersion)
        html += `<div class="detail-row"><strong>API Version:</strong> ${esc(s.apiVersion)}</div>`;
      html += "</div>";
    }

    // Spec Approval — derived from GitHub PR status
    if (p.apiReadiness && p.apiReadiness !== "unknown") {
      const approvalLabel = p.apiReadiness === "completed" ? "Approved (PR Merged)" : "Pending (PR Open)";
      const approvalCls = p.apiReadiness === "completed" ? "status-completed" : "status-inprogress";
      html += `<div class="detail-row"><strong>Spec Approval:</strong> <span class="${approvalCls}">${approvalLabel}</span></div>`;
    } else if (p.specApprovalStatus) {
      html += `<div class="detail-row"><strong>Spec Approval:</strong> ${statusSpan(p.specApprovalStatus)}</div>`;
    }
    if (p.sdkLanguages) {
      html += `<div class="detail-row"><strong>SDK Languages:</strong> ${esc(p.sdkLanguages)}</div>`;
    }

    return html;
  }

  // ── Lazy load PR details on card expand ─────────────────────
  async function lazyLoadPrDetails(detailsEl, cardEl) {
    // Collect all SDK PR links within this card's details
    const prLinks = detailsEl.querySelectorAll("td a[href*='github.com']");
    const urls = [...new Set([...prLinks].map(a => a.href).filter(Boolean))];
    if (!urls.length) return;

    try {
      const res = await fetch("/api/pr-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const details = data.details || {};
      const plan = cardEl && cardEl._planData;

      // Update each PR row with GitHub status and detail labels
      for (const link of prLinks) {
        const info = details[link.href];
        if (!info) continue;
        const row = link.closest("tr");
        if (!row) continue;

        // Update PR Status column (4th td, index 3)
        if (info.gitHubStatus) {
          const statusTd = row.children[3];
          if (statusTd) statusTd.innerHTML = statusSpan(info.gitHubStatus);
          // Update plan data for step recomputation
          if (plan) {
            const langName = row.children[0] && row.children[0].textContent.trim();
            const langData = langName && plan.languages && plan.languages[langName];
            if (langData) langData.sdkPrGitHubStatus = info.gitHubStatus;
          }
        }

        // Append detail labels (checks, approval, mergeable) next to PR link
        if (info.prDetails) {
          const d = info.prDetails;
          // Update plan data for step recomputation
          if (plan) {
            const langName = row.children[0] && row.children[0].textContent.trim();
            const langData = langName && plan.languages && plan.languages[langName];
            if (langData) langData.prDetails = d;
          }
          let labels = "";
          const lazyMerged = (info.gitHubStatus || "").toLowerCase().includes("merged");
          if (d.failedChecks && d.failedChecks.length) {
            const tipText = esc(d.failedChecks.join(", "));
            labels += `<span class="pr-label pr-label-failed" title="${tipText}">${d.failedChecks.length} check(s) failed</span>`;
          }
          if (!lazyMerged && d.isApproved && d.approvedBy && d.approvedBy.length) {
            const tipText = "Approved by: " + esc(d.approvedBy.join(", "));
            labels += `<span class="pr-label pr-label-approved" title="${tipText}">Approved</span>`;
          }
          if (d.mergeable && d.mergeableState === "clean") {
            labels += '<span class="pr-label pr-label-mergeable">Ready to merge</span>';
          }
          if (labels) {
            const prTd = link.closest("td");
            if (prTd) prTd.insertAdjacentHTML("beforeend", " " + labels);
          }
        }
      }

      // Recompute step badges after PR details are loaded
      if (plan && cardEl) {
        const step = computeCurrentStep(plan);
        // Update summary badges (now in .card-meta)
        cardEl.querySelectorAll(".card-meta .step-badge").forEach(el => {
          el.className = `step-badge ${step.statusClass}`;
          el.textContent = step.status;
        });
        cardEl.querySelectorAll(".card-meta .action-badge").forEach(el => {
          el.textContent = step.action || "";
          el.style.display = step.action ? "" : "none";
        });
        // Update detail step highlight
        detailsEl.querySelectorAll(".detail-step-highlight .step-badge").forEach(el => {
          el.className = `step-badge ${step.statusClass}`;
          el.textContent = step.status;
        });
        detailsEl.querySelectorAll(".detail-step-highlight .action-badge").forEach(el => {
          el.textContent = step.action || "";
          el.style.display = step.action ? "" : "none";
        });
      }
    } catch (err) {
      console.warn("Failed to load PR details:", err);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────
  function badgeFor(state, plan) {
    if (plan && isPartiallyReleased(plan)) return "badge-partial";
    if (state === "In Progress") return "badge-inprogress";
    if (state === "Finished") return "badge-finished";
    return "badge-new";
  }

  function statusSpan(val) {
    if (!val) return "—";
    const lower = val.toLowerCase().replace(/\s+/g, "");
    let cls = "";
    if (
      lower.includes("completed") ||
      lower.includes("released") ||
      lower.includes("approved") ||
      lower.includes("merged")
    )
      cls = "status-completed";
    else if (
      lower.includes("inprogress") ||
      lower.includes("pending") ||
      lower.includes("active")
    )
      cls = "status-inprogress";
    else if (
      lower.includes("failed") ||
      lower.includes("excluded") ||
      lower.includes("blocked")
    )
      cls = "status-failed";
    else if (lower.includes("notstarted")) cls = "status-notstarted";
    return `<span class="${cls}">${esc(val)}</span>`;
  }

  function esc(s) {
    if (!s) return "";
    const el = document.createElement("span");
    el.textContent = s;
    return el.innerHTML;
  }

  function showLoading(show) {
    $("#loading").style.display = show ? "" : "none";
  }

  function showError(msg) {
    const el = $("#error-banner");
    el.textContent = msg;
    el.hidden = false;
  }

  function hideError() {
    $("#error-banner").hidden = true;
  }

  function updateTimestamp(iso) {
    if (!iso) return;
    const d = new Date(iso);
    $("#last-updated").textContent = "Updated " + d.toLocaleTimeString();
  }

  // ── Countdown ───────────────────────────────────────────────
  function resetCountdown() {
    refreshCountdown = AUTO_REFRESH_INTERVAL;
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      refreshCountdown--;
      const m = Math.floor(refreshCountdown / 60);
      const s = refreshCountdown % 60;
      $("#refresh-timer").textContent = `Next refresh ${m}:${String(s).padStart(2, "0")}`;
      if (refreshCountdown <= 0) {
        fetchPlans();
      }
    }, 1000);
  }

  // ── Section collapse (event delegation) ─────────────────────
  // Use a CSS class instead of the hidden attribute for reliability
  function toggleSection(header) {
    const targetId = header.getAttribute("data-target");
    if (!targetId) return;
    const target = document.getElementById(targetId);
    if (!target) return;
    const section = header.parentElement;
    const caret = header.querySelector(".caret");
    const isCollapsed = section.classList.contains("collapsed");
    if (isCollapsed) {
      target.style.display = "";
      target.removeAttribute("hidden");
      section.classList.remove("collapsed");
      if (caret) caret.innerHTML = "&#9660;";
    } else {
      target.style.display = "none";
      target.setAttribute("hidden", "");
      section.classList.add("collapsed");
      if (caret) caret.innerHTML = "&#9654;";
    }
  }

  // Bind click handlers directly to each section header
  function bindSectionHeaders() {
    document.querySelectorAll(".section-header").forEach((header) => {
      // Avoid binding twice
      if (header.dataset.bound) return;
      header.dataset.bound = "1";
      header.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSection(header);
      });
    });
  }

  // Also use event delegation as a fallback
  document.addEventListener("click", (e) => {
    const header = e.target.closest(".section-header");
    if (!header) return;
    toggleSection(header);
  });

  // ── Search ──────────────────────────────────────────────────
  let searchTimeout = null;
  $("#search-box").addEventListener("input", () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => render(allPlans), 250);
  });

  // ── Init ────────────────────────────────────────────────────
  fetchPlans();
})();
