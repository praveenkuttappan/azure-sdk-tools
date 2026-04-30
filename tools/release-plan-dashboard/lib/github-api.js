"use strict";

const https = require("https");

// ══════════════════════════════════════════════════════════════
// ── GitHub API helpers (for release plan data) ────────────────
// ══════════════════════════════════════════════════════════════

function githubRequest(apiPath, _retryCount = 0) {
  const pat = process.env.GITHUB_PAT_RELEASE_PLAN || process.env.GH_TOKEN;
  if (!pat) return Promise.resolve(null);
  return _githubRequestWithAuth(`token ${pat}`, apiPath, _retryCount);
}

function githubRequestWithToken(bearerToken, apiPath, _retryCount = 0) {
  if (!bearerToken) return Promise.resolve(null);
  return _githubRequestWithAuth(`Bearer ${bearerToken}`, apiPath, _retryCount);
}

function _githubRequestWithAuth(authHeader, apiPath, _retryCount = 0) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com", path: apiPath, method: "GET",
      headers: { Authorization: authHeader, Accept: "application/vnd.github+json", "User-Agent": "release-plan-dashboard" },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        } else if ((res.statusCode === 403 || res.statusCode === 429) && _retryCount < 2) {
          const isSamlOrAuth = data.includes("SAML enforcement") || data.includes("organization has enabled") || data.includes("Resource protected");
          if (res.statusCode === 403 && isSamlOrAuth) {
            console.warn(`GitHub SAML/SSO error (403) ${apiPath}: ${data.substring(0, 200)}`);
            resolve(null);
          } else {
            const retryAfter = parseInt(res.headers["retry-after"] || "0", 10);
            const resetEpoch = parseInt(res.headers["x-ratelimit-reset"] || "0", 10);
            let waitMs = retryAfter ? retryAfter * 1000 : 0;
            if (!waitMs && resetEpoch) waitMs = Math.max(0, resetEpoch * 1000 - Date.now()) + 1000;
            waitMs = Math.min(waitMs || 5000, 60000);
            console.warn(`GitHub rate limited (${res.statusCode}) ${apiPath}, retry in ${waitMs}ms`);
            setTimeout(() => _githubRequestWithAuth(authHeader, apiPath, _retryCount + 1).then(resolve, reject), waitMs);
          }
        } else {
          console.warn(`GitHub ${apiPath} returned ${res.statusCode}: ${data.substring(0, 200)}`);
          resolve(null);
        }
      });
    });
    req.on("error", (err) => { console.warn(`GitHub error ${apiPath}:`, err.message); resolve(null); });
    req.end();
  });
}

function parseGitHubPrUrl(url) {
  if (!url) return null;
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], number: m[3] } : null;
}

function _extractPrStatus(data) {
  if (!data) return null;
  if (data.merged_at || data.merged) return "merged";
  if (data.state === "closed") return "closed";
  if (data.draft) return "draft";
  return data.state || "unknown";
}

async function getGitHubPrStatus(prUrl, token) {
  const pr = parseGitHubPrUrl(prUrl);
  if (!pr) return null;
  const fetchFn = token ? githubRequestWithToken : githubRequest;
  const args = token ? [token, `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`] : [`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`];
  const data = await fetchFn(...args);
  return _extractPrStatus(data);
}

async function getGitHubPrDetails(prUrl, token) {
  const pr = parseGitHubPrUrl(prUrl);
  if (!pr) return null;
  const fetchFn = token ? githubRequestWithToken : githubRequest;
  const args = (path) => token ? [token, path] : [path];
  const [prData, reviews] = await Promise.all([
    fetchFn(...args(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`)),
    fetchFn(...args(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`)),
  ]);
  if (!prData) return null;
  return _buildPrDetailsResult(prData, reviews, pr, token);
}

async function _buildPrDetailsResult(prData, reviews, pr, bearerToken) {
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
      const fetchFn = bearerToken
        ? githubRequestWithToken(bearerToken, `/repos/${pr.owner}/${pr.repo}/commits/${headSha}/check-runs?per_page=100`)
        : githubRequest(`/repos/${pr.owner}/${pr.repo}/commits/${headSha}/check-runs?per_page=100`);
      const checks = await fetchFn;
      if (checks && Array.isArray(checks.check_runs)) {
        for (const cr of checks.check_runs) {
          if (cr.status === "completed" && cr.conclusion && !["success", "skipped", "neutral", "cancelled"].includes(cr.conclusion))
            result.failedChecks.push(cr.name);
        }
      }
    } catch { /* ignore */ }
  }

  // Extract APIView link from PR comments
  try {
    const fetchComments = bearerToken
      ? githubRequestWithToken(bearerToken, `/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments?per_page=100`)
      : githubRequest(`/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments?per_page=100`);
    const comments = await fetchComments;
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
  let files = [];
  for (let page = 1; page <= 3; page++) {
    const data = await githubRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files?per_page=100&page=${page}`);
    if (!data || !Array.isArray(data) || !data.length) break;
    files.push(...data.map(f => f.filename));
    if (data.length < 100) break;
  }
  return files;
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

module.exports = {
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
