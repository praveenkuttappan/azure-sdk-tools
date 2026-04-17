// Release Plan Dashboard — Express server with GitHub OAuth and live API data.
// DevOps + spec PR data fetched on page load; SDK PR details lazy-loaded on expand.
const express = require("express");
const session = require("express-session");
const https = require("https");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Config ────────────────────────────────────────────────────
const GITHUB_CLIENT_ID = process.env.GITHUB_APP_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_APP_CLIENT_SECRET || "";
const REQUIRED_ORGS = ["microsoft", "Azure"];
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const AUTH_ENABLED = true;
if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
  console.error("ERROR: GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET must be set.");
  process.exit(1);
}

const DEVOPS_ORG = "https://dev.azure.com/azure-sdk";
const DEVOPS_PROJECT = "Release";
const API_VERSION = "7.1";
const BATCH_SIZE = 200;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── In-memory caches ──────────────────────────────────────────
const cache = {
  releasePlans: { data: null, fetchedAt: null, updatedAt: 0, refreshing: false },
  prDetails: new Map(), // url -> { data, updatedAt }
};

const LANGUAGES = ["Dotnet", "JavaScript", "Python", "Java", "Go"];
const LANGUAGE_DISPLAY = {
  Dotnet: ".NET", JavaScript: "JavaScript", Python: "Python", Java: "Java", Go: "Go",
};
const LANGUAGE_PACKAGE_WI = {
  ".NET": ".NET", JavaScript: "JavaScript", Python: "Python", Java: "Java", Go: "Go",
};

// ── Generic HTTPS helper (for OAuth) ──────────────────────────
function httpsReq(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ statusCode: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// ── OAuth helpers ─────────────────────────────────────────────
async function exchangeCodeForToken(code) {
  const postData = JSON.stringify({
    client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code,
  });
  const res = await httpsReq({
    hostname: "github.com", path: "/login/oauth/access_token", method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "release-plan-dashboard" },
  }, postData);
  return res.body && res.body.access_token ? res.body.access_token : null;
}

async function getGitHubUser(token) {
  const res = await httpsReq({
    hostname: "api.github.com", path: "/user", method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "release-plan-dashboard" },
  });
  return res.statusCode === 200 ? res.body : null;
}

async function isMemberOfAnyOrg(token, username, orgs) {
  // Use public endpoint to list user's orgs (no scope needed)
  const lowerOrgs = orgs.map(o => o.toLowerCase());
  let page = 1;
  while (true) {
    const res = await httpsReq({
      hostname: "api.github.com", path: `/users/${username}/orgs?per_page=100&page=${page}`, method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "release-plan-dashboard" },
    });
    console.log(`Org check page ${page}: status=${res.statusCode}, orgs=${Array.isArray(res.body) ? res.body.map(o => o.login).join(", ") : JSON.stringify(res.body)}`);
    if (res.statusCode !== 200 || !Array.isArray(res.body) || !res.body.length) break;
    for (const org of res.body) {
      if (lowerOrgs.includes((org.login || "").toLowerCase())) return true;
    }
    if (res.body.length < 100) break;
    page++;
  }
  return false;
}

function escapeHtml(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function getBaseUrl(req) {
  const host = req.hostname || req.get("host") || "";
  if (host === "localhost" || host === "127.0.0.1") {
    return `http://${req.get("host")}`;
  }
  return process.env.REDIRECT_URL || "https://releaseplan-dashboard.azurewebsites.net";
}

// ── Session + Auth middleware ─────────────────────────────────
app.use(session({
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === "production", httpOnly: true, maxAge: 24*60*60*1000 },
}));
app.use(express.json());

function requireAuth(req, res, next) {
  if (["/auth/github","/auth/github/callback","/auth/logout","/login"].includes(req.path)) return next();
  if (req.session && req.session.user) return next();
  res.redirect("/login");
}
app.use(requireAuth);

// ── Login page ────────────────────────────────────────────────
app.get("/login", (req, res) => {
  if (req.session && req.session.user) return res.redirect("/");
  const errorMsg = req.query.error ? `<div class="error">${escapeHtml(req.query.error)}</div>` : "";
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f3f2f1}.login-box{background:#fff;padding:2.5rem;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.12);text-align:center;max-width:400px}h1{font-size:1.4rem;margin:0 0 .5rem;color:#323130}p{color:#605e5c;margin:0 0 1.5rem;font-size:.9rem}.btn{display:inline-block;padding:.7rem 1.5rem;background:#24292f;color:#fff;text-decoration:none;border-radius:6px;font-size:1rem}.btn:hover{background:#32383f}.error{color:#a4262c;background:#fde7e9;padding:.6rem 1rem;border-radius:4px;margin-bottom:1rem;font-size:.85rem}</style></head><body><div class="login-box"><h1>Release Plan Dashboard</h1><p>Sign in with GitHub. You must be a member of the <strong>Microsoft</strong> or <strong>Azure</strong> org.</p>${errorMsg}<a class="btn" href="/auth/github">Sign in with GitHub</a></div></body></html>`);
});

// ── OAuth routes ──────────────────────────────────────────────
app.get("/auth/github", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  const baseUrl = getBaseUrl(req);
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${baseUrl}/auth/github/callback`,
    scope: "", state,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get("/auth/github/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.session.oauthState)
    return res.redirect("/login?error=Invalid+OAuth+state.");
  delete req.session.oauthState;
  try {
    const token = await exchangeCodeForToken(code);
    if (!token) return res.redirect("/login?error=Failed+to+get+access+token.");
    const user = await getGitHubUser(token);
    if (!user) return res.redirect("/login?error=Failed+to+get+GitHub+user+info.");
    console.log(`Authenticated user: ${user.login} (${user.name || "no name"})`);
    const isMember = await isMemberOfAnyOrg(token, user.login, REQUIRED_ORGS);
    if (!isMember) return res.redirect(`/login?error=You+must+be+an+active+member+of+the+Microsoft+or+Azure+GitHub+org.`);
    req.session.user = { login: user.login, name: user.name || user.login, avatar: user.avatar_url || "" };
    res.redirect("/");
  } catch (err) {
    console.error("OAuth error:", err);
    res.redirect("/login?error=Authentication+failed.");
  }
});

app.get("/auth/logout", (req, res) => { req.session.destroy(() => res.redirect("/login")); });
app.get("/auth/me", (req, res) => { res.json(req.session && req.session.user ? req.session.user : null); });

// ══════════════════════════════════════════════════════════════
// ── GitHub API helpers (for release plan data) ────────────────
// ══════════════════════════════════════════════════════════════

function githubRequest(apiPath, _retryCount = 0) {
  const pat = process.env.GITHUB_PAT_RELEASE_PLAN;
  if (!pat) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com", path: apiPath, method: "GET",
      headers: { Authorization: `token ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "release-plan-dashboard" },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        } else if ((res.statusCode === 403 || res.statusCode === 429) && _retryCount < 2) {
          const retryAfter = parseInt(res.headers["retry-after"] || "0", 10);
          const resetEpoch = parseInt(res.headers["x-ratelimit-reset"] || "0", 10);
          let waitMs = retryAfter ? retryAfter * 1000 : 0;
          if (!waitMs && resetEpoch) waitMs = Math.max(0, resetEpoch * 1000 - Date.now()) + 1000;
          waitMs = Math.min(waitMs || 5000, 60000);
          console.warn(`GitHub rate limited (${res.statusCode}) ${apiPath}, retry in ${waitMs}ms`);
          setTimeout(() => githubRequest(apiPath, _retryCount + 1).then(resolve, reject), waitMs);
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

async function getGitHubPrStatus(prUrl) {
  const pr = parseGitHubPrUrl(prUrl);
  if (!pr) return null;
  const data = await githubRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`);
  if (!data) return null;
  if (data.merged_at || data.merged) return "merged";
  return data.state || "unknown";
}

async function getGitHubPrDetails(prUrl) {
  const pr = parseGitHubPrUrl(prUrl);
  if (!pr) return null;
  const [prData, reviews] = await Promise.all([
    githubRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`),
    githubRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`),
  ]);
  if (!prData) return null;
  const result = { mergeable: prData.mergeable || false, mergeableState: prData.mergeable_state || "", isApproved: false, approvedBy: [], failedChecks: [] };
  if (Array.isArray(reviews)) {
    const approvers = new Set();
    for (const r of reviews) { if (r.state === "APPROVED" && r.user) approvers.add(r.user.login); }
    result.isApproved = approvers.size > 0;
    result.approvedBy = [...approvers];
  }
  const headSha = prData.head && prData.head.sha;
  if (headSha) {
    try {
      const checks = await githubRequest(`/repos/${pr.owner}/${pr.repo}/commits/${headSha}/check-runs?per_page=100`);
      if (checks && Array.isArray(checks.check_runs)) {
        for (const cr of checks.check_runs) {
          if (cr.status === "completed" && cr.conclusion && !["success","skipped","neutral"].includes(cr.conclusion))
            result.failedChecks.push(cr.name);
        }
      }
    } catch { /* ignore */ }
  }
  return result;
}

async function throttledMap(items, fn, { concurrency = 5, delayMs = 200 } = {}) {
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
  if (!unique.length || !process.env.GITHUB_PAT_RELEASE_PLAN) return m;
  await throttledMap(unique, async (url) => {
    try { m.set(url, await getGitHubPrStatus(url)); } catch { m.set(url, null); }
  }, { concurrency: 5, delayMs: 300 });
  return m;
}

async function batchFetchPrDetails(urls) {
  const unique = [...new Set(urls.filter(Boolean))];
  const m = new Map();
  if (!unique.length || !process.env.GITHUB_PAT_RELEASE_PLAN) return m;
  await throttledMap(unique, async (url) => {
    try { m.set(url, await getGitHubPrDetails(url)); } catch { m.set(url, null); }
  }, { concurrency: 5, delayMs: 300 });
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
  if (!unique.length || !process.env.GITHUB_PAT_RELEASE_PLAN) return m;
  await throttledMap(unique, async (url) => {
    try { const files = await getGitHubPrFiles(url); m.set(url, deriveSpecProjectPath(files)); } catch { m.set(url, ""); }
  }, { concurrency: 5, delayMs: 300 });
  return m;
}

// ══════════════════════════════════════════════════════════════
// ── Azure DevOps helpers ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════

const RELEASE_PLAN_FIELDS = [
  "System.Id","System.Title","System.State","System.CreatedDate","System.ChangedDate","System.CreatedBy",
  "Custom.SDKReleasemonth","Custom.SDKtypetobereleased","Custom.ReleasePlanID","Custom.ReleasePlanLink",
  "Custom.ReleasePlanSubmittedby","Custom.PrimaryPM","Custom.ApiSpecProjectPath",
  "Custom.MgmtScope","Custom.DataScope","Custom.SDKLanguages","Custom.APISpecApprovalStatus",
  "Custom.ProductName","Custom.ProductLifecycle","Custom.ServiceName",
  "Custom.CreatedUsing","Custom.ProductServiceTreeID","Custom.ProductServiceTreeLink",
];
for (const lang of LANGUAGES) {
  RELEASE_PLAN_FIELDS.push(
    `Custom.SDKGenerationPipelineFor${lang}`, `Custom.SDKPullRequestFor${lang}`,
    `Custom.${lang}PackageName`, `Custom.GenerationStatusFor${lang}`,
    `Custom.ReleaseStatusFor${lang}`, `Custom.SDKPullRequestStatusFor${lang}`,
    `Custom.ReleaseExclusionStatusFor${lang}`
  );
}

const API_SPEC_FIELDS = [
  "System.Id","System.Title","System.WorkItemType",
  "Custom.ActiveSpecPullRequestUrl","Custom.APISpecversion","Custom.APISpecDefinitionType",
];

const PACKAGE_FIELDS = [
  "System.Id","System.ChangedDate","Custom.Package","Custom.Language",
  "Custom.PackageVersion","Custom.APIReviewStatus","Custom.PackageNameApprovalStatus",
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
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return "";
  return cleaned;
}

function mapReleasePlan(wi, apiSpecMap) {
  const f = wi.fields || {};
  const id = f["System.Id"];
  const languages = {};
  for (const lang of LANGUAGES) {
    languages[LANGUAGE_DISPLAY[lang]] = {
      packageName: f[`Custom.${lang}PackageName`] || "",
      sdkPrUrl: f[`Custom.SDKPullRequestFor${lang}`] || "",
      prStatus: f[`Custom.SDKPullRequestStatusFor${lang}`] || "",
      releaseStatus: f[`Custom.ReleaseStatusFor${lang}`] || "",
      exclusionStatus: f[`Custom.ReleaseExclusionStatusFor${lang}`] || "",
      generationStatus: f[`Custom.GenerationStatusFor${lang}`] || "",
    };
  }
  const childIds = extractChildIds(wi);
  let apiSpec = null;
  for (const cid of childIds) {
    const specWi = apiSpecMap[cid];
    if (specWi) {
      const sf = specWi.fields || {};
      apiSpec = { id: cid, specPrUrl: sf["Custom.ActiveSpecPullRequestUrl"] || "", apiVersion: sf["Custom.APISpecversion"] || "", definitionType: sf["Custom.APISpecDefinitionType"] || "" };
      break;
    }
  }
  const createdBy = f["System.CreatedBy"];
  const createdByName = typeof createdBy === "object" ? createdBy.displayName || "" : "";
  return {
    id, title: f["System.Title"] || "", state: f["System.State"] || "",
    createdDate: f["System.CreatedDate"] || "", changedDate: f["System.ChangedDate"] || "",
    createdBy: stripEmail(createdByName),
    releaseMonth: f["Custom.SDKReleasemonth"] || "", releaseType: f["Custom.SDKtypetobereleased"] || "",
    releasePlanId: f["Custom.ReleasePlanID"] || "", releasePlanLink: f["Custom.ReleasePlanLink"] || "",
    submittedBy: stripEmail(f["Custom.ReleasePlanSubmittedby"] || ""),
    ownerPM: stripEmail(f["Custom.PrimaryPM"] || ""),
    typeSpecPath: f["Custom.ApiSpecProjectPath"] || "",
    mgmtScope: f["Custom.MgmtScope"] || "", dataScope: f["Custom.DataScope"] || "",
    sdkLanguages: f["Custom.SDKLanguages"] || "",
    specApprovalStatus: f["Custom.APISpecApprovalStatus"] || "",
    productName: f["Custom.ProductName"] || "", productLifecycle: f["Custom.ProductLifecycle"] || "",
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

// ══════════════════════════════════════════════════════════════
// ── API endpoints ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

// Core function: fetches and enriches all release plans from DevOps.
async function fetchAllReleasePlans() {
  const wiqlQuery = `SELECT [System.Id] FROM WorkItems
    WHERE [System.TeamProject] = 'Release'
      AND [System.WorkItemType] = 'Release Plan'
      AND [System.Tags] NOT CONTAINS 'Release Planner App Test'
      AND (
        [System.State] IN ('In Progress','Not Started','New')
        OR ([System.State] = 'Finished' AND [System.ChangedDate] >= @Today - 10)
      )
    ORDER BY [System.ChangedDate] DESC`;

  console.log("Running WIQL query...");
  const ids = await runWiql(wiqlQuery);
  console.log(`Found ${ids.length} release plan work items.`);
  if (!ids.length) return { plans: [], fetchedAt: new Date().toISOString() };

  const workItems = await fetchWorkItemsBatch(ids);

  const allChildIds = [];
  for (const wi of workItems) allChildIds.push(...extractChildIds(wi));
  const apiSpecMap = {};
  if (allChildIds.length) {
    const uniqueChildIds = [...new Set(allChildIds)];
    const childItems = await fetchWorkItemsBatch(uniqueChildIds, API_SPEC_FIELDS);
    for (const child of childItems) {
      if (getField(child, "System.WorkItemType") === "API Spec") apiSpecMap[child.id] = child;
    }
  }

  let plans = workItems.map(wi => mapReleasePlan(wi, apiSpecMap)).filter(p => {
    const defType = (p.apiSpec && p.apiSpec.definitionType) || "";
    if (defType.toLowerCase() === "openapi") return false;
    const rt = (p.releaseType || "").toLowerCase();
    if (rt.includes("private")) return false;
    const lc = (p.productLifecycle || "").toLowerCase();
    if (lc.includes("private") || lc.includes("in dev")) return false;
    return true;
  });

  if (process.env.GITHUB_PAT_RELEASE_PLAN) {
    const specPrUrls = [];
    for (const p of plans) {
      const specUrl = (p.apiSpec && p.apiSpec.specPrUrl) || "";
      if (specUrl) specPrUrls.push(specUrl);
    }
    const [statusMap, specPathMap] = await Promise.all([
      batchFetchPrStatuses(specPrUrls),
      batchFetchSpecProjectPaths(specPrUrls),
    ]);
    for (const p of plans) {
      const specUrl = (p.apiSpec && p.apiSpec.specPrUrl) || "";
      if (specUrl && statusMap.has(specUrl)) {
        const st = statusMap.get(specUrl);
        p.apiReadiness = st === "merged" ? "completed" : st === "open" ? "pending" : st || "unknown";
      } else { p.apiReadiness = "unknown"; }
      if (specUrl && specPathMap.has(specUrl)) { const d = specPathMap.get(specUrl); if (d) p.specProjectPath = d; }
      if (!p.specProjectPath) p.specProjectPath = p.typeSpecPath || "";
    }
  } else {
    plans.forEach(p => { p.apiReadiness = "unknown"; p.specProjectPath = p.typeSpecPath || ""; });
  }

  try {
    const pkgLangPairs = [];
    for (const p of plans) {
      for (const [ld, li] of Object.entries(p.languages || {})) {
        if (li.packageName) pkgLangPairs.push({ pkg: li.packageName, lang: LANGUAGE_PACKAGE_WI[ld] || ld });
      }
    }
    const [pkgMap, azureSdkPage] = await Promise.all([fetchPackageWorkItems(pkgLangPairs), fetchAzureSdkPackageList()]);
    for (const p of plans) {
      for (const [ld, li] of Object.entries(p.languages || {})) {
        if (!li.packageName) continue;
        const key = `${li.packageName}|${LANGUAGE_PACKAGE_WI[ld] || ld}`;
        const pkgData = pkgMap.get(key);
        if (pkgData) {
          li.pkgVersion = pkgData.version;
          li.namespaceApproval = pkgData.namespaceApproval;
          if (isGAVersion(pkgData.version)) li.apiReviewStatus = pkgData.apiReviewStatus;
        }
        li.isNewPackage = !isKnownPackage(li.packageName, azureSdkPage);
      }
    }
  } catch (err) { console.warn("Package enrichment error:", err.message); }

  const fetchedAt = new Date().toISOString();
  console.log(`Fetched ${plans.length} release plans.`);
  return { plans, fetchedAt };
}

// Refresh the release plans cache (called on interval and on first request).
async function refreshReleasePlansCache() {
  if (cache.releasePlans.refreshing) return;
  cache.releasePlans.refreshing = true;
  try {
    const result = await fetchAllReleasePlans();
    cache.releasePlans.data = result;
    cache.releasePlans.fetchedAt = result.fetchedAt;
    cache.releasePlans.updatedAt = Date.now();
    console.log(`Release plans cache refreshed at ${result.fetchedAt}`);
  } catch (err) {
    console.error("Cache refresh error:", err.message);
  } finally {
    cache.releasePlans.refreshing = false;
  }
}

// Get cached release plans, refreshing if stale.
async function getCachedReleasePlans() {
  const age = Date.now() - cache.releasePlans.updatedAt;
  if (!cache.releasePlans.data || age > CACHE_TTL_MS) {
    await refreshReleasePlansCache();
  }
  return cache.releasePlans.data || { plans: [], fetchedAt: new Date().toISOString() };
}

// Main endpoint: serves cached release plans.
// Supports ?releasePlan=<id> to filter to a specific plan (bypasses cache).
app.get("/api/release-plans", async (req, res) => {
  try {
    const filterPlanId = req.query.releasePlan || "";

    if (filterPlanId) {
      // Single-plan lookup bypasses cache
      const wiqlQuery = `SELECT [System.Id] FROM WorkItems
        WHERE [System.TeamProject] = 'Release'
          AND [System.WorkItemType] = 'Release Plan'
          AND [Custom.ReleasePlanID] = '${filterPlanId.replace(/'/g, "''")}'`;
      const ids = await runWiql(wiqlQuery);
      if (!ids.length) return res.json({ plans: [], fetchedAt: new Date().toISOString() });
      const workItems = await fetchWorkItemsBatch(ids);
      const allChildIds = [];
      for (const wi of workItems) allChildIds.push(...extractChildIds(wi));
      const apiSpecMap = {};
      if (allChildIds.length) {
        const uniqueChildIds = [...new Set(allChildIds)];
        const childItems = await fetchWorkItemsBatch(uniqueChildIds, API_SPEC_FIELDS);
        for (const child of childItems) {
          if (getField(child, "System.WorkItemType") === "API Spec") apiSpecMap[child.id] = child;
        }
      }
      const plans = workItems.map(wi => mapReleasePlan(wi, apiSpecMap));
      return res.json({ plans, fetchedAt: new Date().toISOString() });
    }

    const result = await getCachedReleasePlans();
    res.json(result);
  } catch (err) {
    console.error("Error fetching release plans:", err);
    res.status(500).json({ error: err.message });
  }
});

// Force-refresh endpoint.
app.post("/api/refresh", async (req, res) => {
  try {
    await refreshReleasePlansCache();
    cache.prDetails.clear();
    res.json({ ok: true, fetchedAt: cache.releasePlans.fetchedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lazy-load endpoint: fetch SDK PR details + statuses with per-URL caching.
app.post("/api/pr-details", async (req, res) => {
  try {
    const urls = (req.body && req.body.urls) || [];
    if (!urls.length || !process.env.GITHUB_PAT_RELEASE_PLAN) return res.json({ details: {} });
    const unique = [...new Set(urls.filter(Boolean))];
    const now = Date.now();

    // Separate cached vs uncached URLs
    const cached = {};
    const toFetch = [];
    for (const url of unique) {
      const entry = cache.prDetails.get(url);
      if (entry && (now - entry.updatedAt) < CACHE_TTL_MS) {
        cached[url] = entry.data;
      } else {
        toFetch.push(url);
      }
    }

    // Fetch only uncached URLs
    if (toFetch.length) {
      const [statusMap, detailMap] = await Promise.all([batchFetchPrStatuses(toFetch), batchFetchPrDetails(toFetch)]);
      for (const url of toFetch) {
        const d = detailMap.get(url) || null;
        const result = {
          gitHubStatus: statusMap.get(url) || null,
          prDetails: d ? { mergeable: d.mergeable, mergeableState: d.mergeableState, isApproved: d.isApproved, approvedBy: d.approvedBy, failedChecks: d.failedChecks } : null,
        };
        cache.prDetails.set(url, { data: result, updatedAt: now });
        cached[url] = result;
      }
    }

    res.json({ details: cached });
  } catch (err) {
    console.error("PR details error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Static files (behind auth) ───────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── Start server + background cache refresh ──────────────────
app.listen(PORT, () => {
  console.log(`Release Plan Dashboard running on http://localhost:${PORT}`);
  console.log(`GitHub OAuth enabled (orgs: ${REQUIRED_ORGS.join(", ")})`);
  if (!process.env.DEVOPS_RELEASE_PLAN_PAT) console.warn("WARNING: DEVOPS_RELEASE_PLAN_PAT not set.");
  if (!process.env.GITHUB_PAT_RELEASE_PLAN) console.warn("WARNING: GITHUB_PAT_RELEASE_PLAN not set.");

  // Pre-warm cache on startup
  refreshReleasePlansCache().catch(err => console.error("Initial cache warm-up failed:", err.message));

  // Refresh cache hourly in the background
  setInterval(() => {
    console.log("Hourly cache refresh triggered.");
    refreshReleasePlansCache().catch(err => console.error("Scheduled cache refresh failed:", err.message));
  }, CACHE_TTL_MS);
});