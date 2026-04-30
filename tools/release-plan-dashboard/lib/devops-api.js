"use strict";

const https = require("https");

// ══════════════════════════════════════════════════════════════
// ── Azure DevOps helpers ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════

const DEVOPS_ORG = "https://dev.azure.com/azure-sdk";
const DEVOPS_PROJECT = "Release";
const API_VERSION = "7.1";
const BATCH_SIZE = 200;

const LANGUAGES = ["Dotnet", "JavaScript", "Python", "Java", "Go"];
const LANGUAGE_DISPLAY = {
  Dotnet: ".NET", JavaScript: "JavaScript", Python: "Python", Java: "Java", Go: "Go",
};
const LANGUAGE_PACKAGE_WI = {
  ".NET": ".NET", JavaScript: "JavaScript", Python: "Python", Java: "Java", Go: "Go",
};

const RELEASE_PLAN_FIELDS = [
  "System.Id", "System.Title", "System.State", "System.CreatedDate", "System.ChangedDate", "System.CreatedBy",
  "Custom.SDKReleasemonth", "Custom.SDKtypetobereleased", "Custom.ReleasePlanID", "Custom.ReleasePlanLink",
  "Custom.ReleasePlanSubmittedby", "Custom.PrimaryPM", "Custom.ApiSpecProjectPath",
  "Custom.MgmtScope", "Custom.DataScope", "Custom.SDKLanguages", "Custom.APISpecApprovalStatus",
  "Custom.ProductName", "Custom.ProductLifecycle", "Custom.ServiceName", "Custom.ReleasePlanType",
  "Custom.CreatedUsing", "Custom.ProductServiceTreeID", "Custom.ProductServiceTreeLink",
];
for (const lang of LANGUAGES) {
  RELEASE_PLAN_FIELDS.push(
    `Custom.SDKGenerationPipelineFor${lang}`, `Custom.SDKPullRequestFor${lang}`,
    `Custom.${lang}PackageName`, `Custom.GenerationStatusFor${lang}`,
    `Custom.ReleaseStatusFor${lang}`, `Custom.SDKPullRequestStatusFor${lang}`,
    `Custom.ReleaseExclusionStatusFor${lang}`, `Custom.ReleasedVersionFor${lang}`
  );
}

const API_SPEC_FIELDS = [
  "System.Id", "System.Title", "System.WorkItemType",
  "Custom.ActiveSpecPullRequestUrl", "Custom.RESTAPIReviews", "Custom.APISpecversion", "Custom.APISpecDefinitionType",
];

const PACKAGE_FIELDS = [
  "System.Id", "System.ChangedDate", "Custom.Package", "Custom.Language",
  "Custom.PackageVersion", "Custom.APIReviewStatus", "Custom.PackageNameApprovalStatus",
];

function getAuthHeader() {
  const pat = process.env.DEVOPS_RELEASE_PLAN_PAT;
  if (!pat) throw new Error("DEVOPS_RELEASE_PLAN_PAT is not set.");
  return "Basic " + Buffer.from(":" + pat).toString("base64");
}

function devopsRequest(urlPath, method, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath);
    const options = {
      hostname: url.hostname, path: url.pathname + url.search, method: method || "GET",
      headers: { Authorization: getAuthHeader(), "Content-Type": "application/json", Accept: "application/json" },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else { reject(new Error(`DevOps ${res.statusCode}: ${data.substring(0, 500)}`)); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function devopsRequestWithHeaders(urlPath, method, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath);
    const options = {
      hostname: url.hostname, path: url.pathname + url.search, method: method || "GET",
      headers: { Authorization: getAuthHeader(), "Content-Type": "application/json", Accept: "application/json" },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve({ body: JSON.parse(data), headers: res.headers }); } catch { resolve({ body: data, headers: res.headers }); }
        } else { reject(new Error(`DevOps ${res.statusCode}: ${data.substring(0, 500)}`)); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runWiql(query) {
  const url = `${DEVOPS_ORG}/${DEVOPS_PROJECT}/_apis/wit/wiql?api-version=${API_VERSION}`;
  const result = await devopsRequest(url, "POST", { query });
  return result.workItems ? result.workItems.map(wi => wi.id) : [];
}

async function fetchWorkItemsBatch(ids, fields) {
  if (!ids.length) return [];
  const allItems = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const fieldsParam = fields ? `&fields=${fields.join(",")}` : "";
    const expand = fields ? "" : "&$expand=All";
    const url = `${DEVOPS_ORG}/_apis/wit/workitems?ids=${batch.join(",")}${expand}${fieldsParam}&api-version=${API_VERSION}`;
    const result = await devopsRequest(url, "GET");
    if (result.value) allItems.push(...result.value);
  }
  return allItems;
}

function extractChildIds(wi) {
  const ids = [];
  if (wi.relations) {
    for (const r of wi.relations) {
      if (r.rel === "System.LinkTypes.Hierarchy-Forward" && r.url) {
        const m = r.url.match(/\/workItems\/(\d+)$/);
        if (m) ids.push(parseInt(m[1], 10));
      }
    }
  }
  return ids;
}

function getField(wi, name) { return wi.fields ? wi.fields[name] : undefined; }

function stripEmail(val) {
  if (!val) return "";
  let cleaned = val.replace(/<[^>]*@[^>]*>/g, "").trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
    return cleaned.split("@")[0].replace(/[._]/g, " ");
  }
  return cleaned;
}

function mapReleasePlan(wi, apiSpecMap) {
  const f = wi.fields || {};
  const id = wi.id || f["System.Id"];
  const languages = {};
  for (const lang of LANGUAGES) {
    languages[LANGUAGE_DISPLAY[lang]] = {
      packageName: f[`Custom.${lang}PackageName`] || "",
      sdkPrUrl: (f[`Custom.SDKPullRequestFor${lang}`] || "").trim().replace(/\/+$/, ""),
      prStatus: f[`Custom.SDKPullRequestStatusFor${lang}`] || "",
      releaseStatus: f[`Custom.ReleaseStatusFor${lang}`] || "",
      exclusionStatus: f[`Custom.ReleaseExclusionStatusFor${lang}`] || "",
      generationStatus: f[`Custom.GenerationStatusFor${lang}`] || "",
      releasedVersion: f[`Custom.ReleasedVersionFor${lang}`] || "",
    };
  }
  const childIds = extractChildIds(wi);
  let apiSpec = null;
  for (const cid of childIds) {
    const specWi = apiSpecMap[cid];
    if (specWi) {
      const sf = specWi.fields || {};
      let specPrUrl = (sf["Custom.ActiveSpecPullRequestUrl"] || "").trim().replace(/\/+$/, "");
      const reviewsHtml = sf["Custom.RESTAPIReviews"] || "";
      const allSpecPrUrls = [];
      const hrefRegex = /href="([^"]+)"/g;
      let hm;
      while ((hm = hrefRegex.exec(reviewsHtml)) !== null) {
        const u = hm[1].trim().replace(/\/+$/, "");
        if (/github\.com\/.*\/pull\/\d+/.test(u) && !allSpecPrUrls.includes(u)) allSpecPrUrls.push(u);
      }
      if (!specPrUrl && allSpecPrUrls.length) specPrUrl = allSpecPrUrls[0];
      const previousSpecPrUrls = allSpecPrUrls.filter(u => u !== specPrUrl);
      apiSpec = { id: cid, specPrUrl, previousSpecPrUrls, apiVersion: sf["Custom.APISpecversion"] || "", definitionType: sf["Custom.APISpecDefinitionType"] || "" };
      break;
    }
  }
  const createdBy = f["System.CreatedBy"];
  const createdByName = typeof createdBy === "object" ? createdBy.displayName || "" : "";
  const rawSubmittedBy = f["Custom.ReleasePlanSubmittedby"];
  const submittedByName = typeof rawSubmittedBy === "object" && rawSubmittedBy
    ? rawSubmittedBy.displayName || rawSubmittedBy.uniqueName || ""
    : (rawSubmittedBy || "");
  return {
    id, title: f["System.Title"] || "", state: f["System.State"] || "",
    createdDate: f["System.CreatedDate"] || "", changedDate: f["System.ChangedDate"] || "",
    createdBy: stripEmail(createdByName),
    releaseMonth: f["Custom.SDKReleasemonth"] || "", releaseType: f["Custom.SDKtypetobereleased"] || "",
    releasePlanId: f["Custom.ReleasePlanID"] || "", releasePlanLink: f["Custom.ReleasePlanLink"] || "",
    submittedBy: (submittedByName || createdByName),
    ownerPM: stripEmail(f["Custom.PrimaryPM"] || ""),
    typeSpecPath: f["Custom.ApiSpecProjectPath"] || "",
    mgmtScope: f["Custom.MgmtScope"] || "", dataScope: f["Custom.DataScope"] || "",
    sdkLanguages: f["Custom.SDKLanguages"] || "",
    specApprovalStatus: f["Custom.APISpecApprovalStatus"] || "",
    productName: f["Custom.ProductName"] || "", productLifecycle: f["Custom.ProductLifecycle"] || "",
    releasePlanType: f["Custom.ReleasePlanType"] || "",
    serviceName: f["Custom.ServiceName"] || "",
    createdUsing: f["Custom.CreatedUsing"] || "",
    productId: f["Custom.ProductServiceTreeID"] || "",
    productServiceTreeLink: f["Custom.ProductServiceTreeLink"] || "",
    languages, apiSpec,
  };
}

// ── Package work item helpers ─────────────────────────────────

async function fetchPackageWorkItems(pkgLangPairs) {
  if (!pkgLangPairs.length) return new Map();
  const uniquePkgs = [...new Set(pkgLangPairs.map(p => p.pkg))].filter(Boolean);
  if (!uniquePkgs.length) return new Map();
  const resultMap = new Map();
  const WIQL_BATCH = 50;
  for (let i = 0; i < uniquePkgs.length; i += WIQL_BATCH) {
    const batch = uniquePkgs.slice(i, i + WIQL_BATCH);
    const conds = batch.map(p => `[Custom.Package] = '${p.replace(/'/g, "''")}'`).join(" OR ");
    const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Release' AND [System.WorkItemType] = 'Package' AND [System.State] NOT IN ('Closed','Duplicate','Abandoned') AND (${conds}) ORDER BY [System.ChangedDate] DESC`;
    try {
      const ids = await runWiql(query);
      if (!ids.length) continue;
      const items = await fetchWorkItemsBatch(ids, PACKAGE_FIELDS);
      for (const item of items) {
        const f = item.fields || {};
        const key = `${f["Custom.Package"] || ""}|${f["Custom.Language"] || ""}`;
        const existing = resultMap.get(key);
        const changedDate = new Date(f["System.ChangedDate"] || 0);
        if (!existing || changedDate > existing._changedDate) {
          resultMap.set(key, { _changedDate: changedDate, version: f["Custom.PackageVersion"] || "", apiReviewStatus: f["Custom.APIReviewStatus"] || "", namespaceApproval: f["Custom.PackageNameApprovalStatus"] || "" });
        }
      }
    } catch (err) { console.warn("Package WI error:", err.message); }
  }
  return resultMap;
}

function fetchAzureSdkPackageList() {
  return new Promise(resolve => {
    https.get("https://azure.github.io/azure-sdk/", res => {
      if (res.statusCode !== 200) { resolve(""); res.resume(); return; }
      let d = ""; res.on("data", c => (d += c)); res.on("end", () => resolve(d));
    }).on("error", () => resolve(""));
  });
}

function isKnownPackage(name, page) { return name && page && page.toLowerCase().includes(name.toLowerCase()); }

function isGAVersion(v) {
  if (!v) return false;
  const l = v.toLowerCase();
  return !l.includes("beta") && !l.includes("alpha") && !l.includes("preview") && !l.includes("rc") && !/[-.]b\d/.test(l);
}

module.exports = {
  DEVOPS_ORG,
  DEVOPS_PROJECT,
  API_VERSION,
  LANGUAGES,
  LANGUAGE_DISPLAY,
  LANGUAGE_PACKAGE_WI,
  RELEASE_PLAN_FIELDS,
  API_SPEC_FIELDS,
  PACKAGE_FIELDS,
  devopsRequest,
  devopsRequestWithHeaders,
  runWiql,
  fetchWorkItemsBatch,
  extractChildIds,
  getField,
  mapReleasePlan,
  fetchPackageWorkItems,
  fetchAzureSdkPackageList,
  isKnownPackage,
  isGAVersion,
};
