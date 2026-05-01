import { Octokit } from "@octokit/rest";

// ══════════════════════════════════════════════════════════════
// ── GitHub API helpers (for release plan data) ────────────────
// ══════════════════════════════════════════════════════════════

function getOctokit(token) {
  const auth = token || process.env.GITHUB_PAT_RELEASE_PLAN || process.env.GH_TOKEN;
  if (!auth) return null;
  return new Octokit({
    auth,
    userAgent: "release-plan-dashboard",
    request: { timeout: 30000 },
    retry: { enabled: true, retries: 2 },
    throttle: { enabled: false },
  });
}

async function githubRequest(apiPath) {
  const pat = process.env.GITHUB_PAT_RELEASE_PLAN || process.env.GH_TOKEN;
  if (!pat) return null;
  try {
    const response = await fetch(`https://api.github.com${apiPath}`, {
      headers: { Authorization: `token ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "release-plan-dashboard" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      console.warn(`GitHub ${apiPath} returned ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.warn(`GitHub error ${apiPath}:`, err.message);
    return null;
  }
}

async function githubRequestWithToken(bearerToken, apiPath) {
  if (!bearerToken) return null;
  try {
    const response = await fetch(`https://api.github.com${apiPath}`, {
      headers: { Authorization: `Bearer ${bearerToken}`, Accept: "application/vnd.github+json", "User-Agent": "release-plan-dashboard" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      console.warn(`GitHub ${apiPath} returned ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.warn(`GitHub error ${apiPath}:`, err.message);
    return null;
  }
}

function parseGitHubPrUrl(url) {
  if (!url) return null;
  const m = url.match(/^https?:\/\/(www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[2], repo: m[3], number: m[4] } : null;
}

function _extractPrStatus(data) {
  if (!data) return null;
  if (data.merged_at || data.merged) return "merged";
  if (data.state === "closed") return "closed";
  if (data.draft) return "draft";
  return data.state || "unknown";
}

async function getGitHubPrStatus(prUrl) {
  const pr = parseGitHubPrUrl(prUrl);
  if (!pr) return null;
  const octokit = getOctokit();
  if (!octokit) return null;
  try {
    const { data } = await octokit.pulls.get({ owner: pr.owner, repo: pr.repo, pull_number: Number(pr.number) });
    return _extractPrStatus(data);
  } catch (err) {
    console.warn(`GitHub PR status error ${prUrl}:`, err.message);
    return null;
  }
}

async function getGitHubPrDetails(prUrl) {
  const pr = parseGitHubPrUrl(prUrl);
  if (!pr) return null;
  const octokit = getOctokit();
  if (!octokit) return null;
  try {
    const [{ data: prData }, { data: reviews }] = await Promise.all([
      octokit.pulls.get({ owner: pr.owner, repo: pr.repo, pull_number: Number(pr.number) }),
      octokit.pulls.listReviews({ owner: pr.owner, repo: pr.repo, pull_number: Number(pr.number) }),
    ]);
    if (!prData) return null;
    return _buildPrDetailsResult(prData, reviews, pr, octokit);
  } catch (err) {
    console.warn(`GitHub PR details error ${prUrl}:`, err.message);
    return null;
  }
}

async function _buildPrDetailsResult(prData, reviews, pr, octokit) {
  const result = {
    mergeable: prData.mergeable || false, mergeableState: prData.mergeable_state || "",
    isApproved: false, approvedBy: [], failedChecks: [], apiViewUrl: "",
    title: prData.title || "", requestedReviewers: [], latestComment: null,
    updatedAt: prData.updated_at || "",
  };
  if (Array.isArray(prData.requested_reviewers)) {
    result.requestedReviewers = prData.requested_reviewers.map(r => r.login).filter(Boolean);
  }
  if (Array.isArray(reviews)) {
    const approvers = new Set();
    for (const r of reviews) { if (r.state === "APPROVED" && r.user) approvers.add(r.user.login); }
    result.isApproved = approvers.size > 0;
    result.approvedBy = [...approvers];
  }
  const headSha = prData.head && prData.head.sha;
  if (headSha) {
    try {
      const { data: checks } = await octokit.checks.listForRef({ owner: pr.owner, repo: pr.repo, ref: headSha, per_page: 100 });
      if (checks && Array.isArray(checks.check_runs)) {
        for (const cr of checks.check_runs) {
          if (cr.status === "completed" && cr.conclusion && !["success", "skipped", "neutral", "cancelled"].includes(cr.conclusion))
            result.failedChecks.push(cr.name);
        }
      }
    } catch { /* ignore */ }
  }

  // Extract APIView link and latest comment from PR comments
  try {
    const { data: comments } = await octokit.issues.listComments({ owner: pr.owner, repo: pr.repo, issue_number: Number(pr.number), per_page: 100 });
    if (Array.isArray(comments)) {
      for (let i = comments.length - 1; i >= 0; i--) {
        const c = comments[i];
        const login = (c.user && c.user.login) || "";
        const isBot = login.includes("[bot]") || login.includes("bot") || (c.user && c.user.type === "Bot");
        if (!isBot && c.body) {
          result.latestComment = { author: login, body: c.body.substring(0, 300), createdAt: c.created_at || "" };
          break;
        }
      }
      for (const c of comments) {
        const body = c.body || "";
        if (body.includes("API Change Check") || body.includes("APIView") || body.includes("apiview")) {
          const urlMatch = body.match(/https:\/\/(?:spa\.)?apiview\.dev\/[^\s)\]"<>]+/);
          if (urlMatch) { result.apiViewUrl = urlMatch[0]; break; }
        }
      }
    }
  } catch (commentErr) { console.warn("APIView comment fetch error:", commentErr.message); }

  return result;
}

async function throttledMap(items, fn, { concurrency = 10, delayMs = 50 } = {}) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    results.push(...await Promise.all(chunk.map(fn)));
    if (i + concurrency < items.length) await new Promise(r => setTimeout(r, delayMs));
  }
  return results;
}

async function batchFetchPrStatuses(urls) {
  const unique = [...new Set(urls.filter(Boolean))];
  const m = new Map();
  if (!unique.length || !(process.env.GITHUB_PAT_RELEASE_PLAN || process.env.GH_TOKEN)) return m;
  await throttledMap(unique, async (url) => {
    try { m.set(url, await getGitHubPrStatus(url)); } catch { m.set(url, null); }
  }, { concurrency: 10, delayMs: 50 });
  return m;
}

async function batchFetchPrDetails(urls) {
  const unique = [...new Set(urls.filter(Boolean))];
  const m = new Map();
  if (!unique.length || !(process.env.GITHUB_PAT_RELEASE_PLAN || process.env.GH_TOKEN)) return m;
  await throttledMap(unique, async (url) => {
    try { m.set(url, await getGitHubPrDetails(url)); } catch { m.set(url, null); }
  }, { concurrency: 10, delayMs: 50 });
  return m;
}

async function getGitHubPrFiles(prUrl) {
  const pr = parseGitHubPrUrl(prUrl);
  if (!pr) return [];
  const octokit = getOctokit();
  if (!octokit) return [];
  try {
    const files = await octokit.paginate(octokit.pulls.listFiles, {
      owner: pr.owner, repo: pr.repo, pull_number: Number(pr.number), per_page: 100,
    }, response => response.data.map(f => f.filename));
    return files;
  } catch (err) {
    console.warn(`GitHub PR files error ${prUrl}:`, err.message);
    return [];
  }
}

function deriveSpecProjectPath(files) {
  if (!files || !files.length) return "";
  const markers = ["tspconfig.yaml", "main.tsp", "client.tsp"];
  for (const mk of markers) {
    const match = files.find(f => f.endsWith("/" + mk) || f === mk);
    if (match) { const idx = match.lastIndexOf("/"); return idx >= 0 ? match.substring(0, idx) : ""; }
  }
  const dirs = files.map(f => { const i = f.lastIndexOf("/"); return i >= 0 ? f.substring(0, i) : ""; }).filter(Boolean);
  if (!dirs.length) return "";
  let common = dirs[0];
  for (let i = 1; i < dirs.length; i++) {
    while (common && !dirs[i].startsWith(common)) { const idx = common.lastIndexOf("/"); common = idx >= 0 ? common.substring(0, idx) : ""; }
    if (!common) break;
  }
  return common;
}

async function batchFetchSpecProjectPaths(urls) {
  const unique = [...new Set(urls.filter(Boolean))];
  const m = new Map();
  if (!unique.length || !(process.env.GITHUB_PAT_RELEASE_PLAN || process.env.GH_TOKEN)) return m;
  await throttledMap(unique, async (url) => {
    try { const files = await getGitHubPrFiles(url); m.set(url, deriveSpecProjectPath(files)); } catch { m.set(url, ""); }
  }, { concurrency: 10, delayMs: 50 });
  return m;
}

export {
  githubRequest,
  githubRequestWithToken,
  parseGitHubPrUrl,
  getGitHubPrStatus,
  getGitHubPrDetails,
  batchFetchPrStatuses,
  batchFetchPrDetails,
  batchFetchSpecProjectPaths,
  throttledMap,
  _extractPrStatus,
};
