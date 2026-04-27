// Release Plan Dashboard — Express server with GitHub OAuth and cached API data.
// DevOps + GitHub PR data fetched and cached every 30 minutes using PAT.
const express = require("express");
const session = require("express-session");
const https = require("https");
const crypto = require("crypto");
const path = require("path");

// ── GitHub App token minting via Azure Key Vault ──────────────
// Mints a GitHub App installation access token by signing a JWT
// with a non-exportable RSA key in Azure Key Vault.
const KEYVAULT_NAME = process.env.KEYVAULT_NAME || "azuresdkengkeyvault";
const KEYVAULT_KEY_NAME = process.env.KEYVAULT_KEY_NAME || "azure-sdk-automation";
const GITHUB_APP_ID = process.env.GITHUB_APP_NUMERIC_ID || "1086291";
const GITHUB_INSTALL_OWNER = process.env.GITHUB_INSTALL_OWNER || "Azure";
const GH_TOKEN_REFRESH_MS = 50 * 60 * 1000; // refresh every 50 min (token valid ~1 hr)

let _mintedGhToken = null;
let _ghTokenMintedAt = 0;

function base64UrlEncode(buffer) {
  const b64 = (Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)).toString("base64");
  return b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function mintGitHubAppToken() {
  try {
    const { DefaultAzureCredential } = require("@azure/identity");
    const { CryptographyClient, KeyClient } = require("@azure/keyvault-keys");

    const credential = new DefaultAzureCredential();
    const vaultUrl = `https://${KEYVAULT_NAME}.vault.azure.net`;
    const keyClient = new KeyClient(vaultUrl, credential);
    const key = await keyClient.getKey(KEYVAULT_KEY_NAME);
    const cryptoClient = new CryptographyClient(key.id, credential);

    // Build JWT header & payload
    const header = JSON.stringify({ alg: "RS256", typ: "JWT" });
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ iat: nowSec - 10, exp: nowSec + 600, iss: GITHUB_APP_ID });
    const unsignedToken = `${base64UrlEncode(header)}.${base64UrlEncode(payload)}`;

    // Sign with Key Vault (RS256)
    const digest = crypto.createHash("sha256").update(unsignedToken, "ascii").digest();
    const signResult = await cryptoClient.sign("RS256", digest);
    if (!signResult.result) throw new Error("Key Vault sign returned no result.");
    const jwt = `${unsignedToken}.${base64UrlEncode(Buffer.from(signResult.result))}`;

    // Get installation ID for the owner
    const apiHeaders = {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "release-plan-dashboard",
    };
    const instRes = await fetch("https://api.github.com/app/installations", { headers: apiHeaders });
    if (!instRes.ok) throw new Error(`GitHub installations API ${instRes.status}: ${await instRes.text()}`);
    const installations = await instRes.json();
    const match = installations.find(i => i.account.login.toLowerCase() === GITHUB_INSTALL_OWNER.toLowerCase());
    if (!match) throw new Error(`No GitHub App installation found for owner "${GITHUB_INSTALL_OWNER}".`);

    // Exchange JWT for installation access token
    const tokenRes = await fetch(`https://api.github.com/app/installations/${match.id}/access_tokens`, {
      method: "POST", headers: apiHeaders,
    });
    if (!tokenRes.ok) throw new Error(`GitHub token exchange ${tokenRes.status}: ${await tokenRes.text()}`);
    const tokenData = await tokenRes.json();
    if (!tokenData.token) throw new Error("GitHub token exchange returned no token.");

    _mintedGhToken = tokenData.token;
    _ghTokenMintedAt = Date.now();
    process.env.GH_TOKEN = _mintedGhToken;
    console.log(`GitHub App installation token minted successfully (owner: ${GITHUB_INSTALL_OWNER}).`);
    return _mintedGhToken;
  } catch (err) {
    console.warn(`GitHub App token minting failed: ${err.message}`);
    console.warn("Falling back to GITHUB_PAT_RELEASE_PLAN or pre-set GH_TOKEN.");
    return null;
  }
}

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
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour for release plans + basic PR status
const PR_DETAIL_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes for on-demand SDK PR details

// ── In-memory caches ──────────────────────────────────────────
const cache = {
  releasePlans: { data: null, fetchedAt: null, updatedAt: 0, refreshing: false },
  prDetails: new Map(), // url -> { data, updatedAt }
  prStatuses: new Map(), // url -> { data, updatedAt } — basic status (open/merged/closed/draft)
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
  // Save original URL so we can redirect back after login
  if (req.session) req.session.returnTo = req.originalUrl;
  res.redirect("/login");
}
app.use(requireAuth);

// ── Login page ────────────────────────────────────────────────
app.get("/login", (req, res) => {
  if (req.session && req.session.user) return res.redirect("/");
  const errorMsg = req.query.error ? `<div class="error">${escapeHtml(req.query.error)}</div>` : "";
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f3f2f1}.login-box{background:#fff;padding:2.5rem;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.12);text-align:center;max-width:400px}h1{font-size:1.4rem;margin:0 0 .5rem;color:#323130}p{color:#605e5c;margin:0 0 1.5rem;font-size:.9rem}.btn{display:inline-block;padding:.7rem 1.5rem;background:#24292f;color:#fff;text-decoration:none;border-radius:6px;font-size:1rem}.btn:hover{background:#32383f}.error{color:#a4262c;background:#fde7e9;padding:.6rem 1rem;border-radius:4px;margin-bottom:1rem;font-size:.85rem}.note{color:#605e5c;font-size:.8rem;margin-top:1rem}</style></head><body><div class="login-box"><h1>Release Plan Dashboard</h1><p>Sign in with GitHub. You must be a public member of the <strong>Microsoft</strong> or <strong>Azure</strong> org.</p>${errorMsg}<a class="btn" href="/auth/github">Sign in with GitHub</a><p class="note">If login fails, ensure your membership in the Microsoft or Azure GitHub org is set to <strong>Public</strong> in your GitHub profile settings.</p></div></body></html>`);
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
    if (!isMember) return res.redirect(`/login?error=You+must+be+a+public+member+of+the+Microsoft+or+Azure+GitHub+org.+Please+ensure+your+org+membership+is+set+to+Public+in+your+GitHub+profile.`);
    req.session.user = { login: user.login, name: user.name || user.login, avatar: user.avatar_url || "" };
    req.session.githubToken = token;
    const returnTo = req.session.returnTo || "/";
    delete req.session.returnTo;
    res.redirect(returnTo);
  } catch (err) {
    console.error("OAuth error:", err);
    res.redirect("/login?error=Authentication+failed.");
  }
});

app.get("/auth/logout", (req, res) => { req.session.destroy(() => res.redirect("/login")); });
app.get("/auth/me", (req, res) => {
  const user = req.session && req.session.user ? req.session.user : null;
  if (user) {
    const pmList = (process.env.RELEASE_PLAN_DASHBOARD_PM_USERS || "").split(",").map(u => u.trim().toLowerCase()).filter(Boolean);
    user.isPM = pmList.includes((user.login || "").toLowerCase());
  }
  res.json(user);
});

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
          // Don't retry SAML SSO or permission errors — they won't resolve with retries
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

async function getGitHubPrStatus(prUrl) {
  const pr = parseGitHubPrUrl(prUrl);
  if (!pr) return null;
  const data = await githubRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`);
  if (!data) return null;
  if (data.merged_at || data.merged) return "merged";
  if (data.draft) return "draft";
  return data.state || "unknown";
}

async function getGitHubPrStatusWithToken(token, prUrl) {
  const pr = parseGitHubPrUrl(prUrl);
  if (!pr) return null;
  const data = await githubRequestWithToken(token, `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`);
  if (!data) return null;
  if (data.merged_at || data.merged) return "merged";
  if (data.draft) return "draft";
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
  return _buildPrDetailsResult(prData, reviews, pr);
}

async function getGitHubPrDetailsWithToken(token, prUrl) {
  const pr = parseGitHubPrUrl(prUrl);
  if (!pr) return null;
  const [prData, reviews] = await Promise.all([
    githubRequestWithToken(token, `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`),
    githubRequestWithToken(token, `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`),
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
  // Requested reviewers from PR data
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
          if (cr.status === "completed" && cr.conclusion && !["success","skipped","neutral"].includes(cr.conclusion))
            result.failedChecks.push(cr.name);
        }
      }
    } catch { /* ignore */ }
  }

  // Extract APIView link from PR comments (look for "API Change Check" comment)
  try {
    const fetchComments = bearerToken
      ? githubRequestWithToken(bearerToken, `/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments?per_page=100`)
      : githubRequest(`/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments?per_page=100`);
    const comments = await fetchComments;
    if (Array.isArray(comments)) {
      // Latest non-bot comment (skip APIView / check bots)
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
          // Match spa.apiview.dev or apiview.dev URLs
          const urlMatch = body.match(/https:\/\/(?:spa\.)?apiview\.dev\/[^\s)\]"<>]+/);
          if (urlMatch) {
            result.apiViewUrl = urlMatch[0];
            console.log(`APIView URL found for PR ${pr.number}: ${result.apiViewUrl}`);
            break;
          }
        }
      }
      if (!result.apiViewUrl) {
        console.log(`No APIView URL found in ${comments.length} comments for ${pr.owner}/${pr.repo}#${pr.number}`);
      }
    } else {
      console.log(`Comments fetch returned non-array for ${pr.owner}/${pr.repo}#${pr.number}`);
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

// ══════════════════════════════════════════════════════════════
// ── Azure DevOps helpers ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════

const RELEASE_PLAN_FIELDS = [
  "System.Id","System.Title","System.State","System.CreatedDate","System.ChangedDate","System.CreatedBy",
  "Custom.SDKReleasemonth","Custom.SDKtypetobereleased","Custom.ReleasePlanID","Custom.ReleasePlanLink",
  "Custom.ReleasePlanSubmittedby","Custom.PrimaryPM","Custom.ApiSpecProjectPath",
  "Custom.MgmtScope","Custom.DataScope","Custom.SDKLanguages","Custom.APISpecApprovalStatus",
  "Custom.ProductName","Custom.ProductLifecycle","Custom.ServiceName","Custom.ReleasePlanType",
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
  "Custom.ActiveSpecPullRequestUrl","Custom.RESTAPIReviews","Custom.APISpecversion","Custom.APISpecDefinitionType",
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

// Like devopsRequest but also returns response headers (for pagination).
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
  // Remove <email> patterns but keep the name part
  let cleaned = val.replace(/<[^>]*@[^>]*>/g, "").trim();
  // If what's left is a bare email, extract the name part before @
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
    };
  }
  const childIds = extractChildIds(wi);
  let apiSpec = null;
  for (const cid of childIds) {
    const specWi = apiSpecMap[cid];
    if (specWi) {
      const sf = specWi.fields || {};
      let specPrUrl = (sf["Custom.ActiveSpecPullRequestUrl"] || "").trim().replace(/\/+$/, "");
      // Extract ALL spec PR URLs from REST API Reviews HTML field
      const reviewsHtml = sf["Custom.RESTAPIReviews"] || "";
      const allSpecPrUrls = [];
      const hrefRegex = /href="([^"]+)"/g;
      let hm;
      while ((hm = hrefRegex.exec(reviewsHtml)) !== null) {
        const u = hm[1].trim().replace(/\/+$/, "");
        if (/github\.com\/.*\/pull\/\d+/.test(u) && !allSpecPrUrls.includes(u)) allSpecPrUrls.push(u);
      }
      // Fallback: if no active spec PR URL, use first from reviews
      if (!specPrUrl && allSpecPrUrls.length) specPrUrl = allSpecPrUrls[0];
      // Previous spec PRs = all except the active one
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
        OR ([System.State] = 'Finished' AND [System.ChangedDate] >= @Today - 60)
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
    return true;
  });

  await enrichPlans(plans);

  const fetchedAt = new Date().toISOString();
  console.log(`Fetched ${plans.length} release plans.`);
  return { plans, fetchedAt };
}

// Shared enrichment: adds apiReadiness, specProjectPath, package details to plans.
async function enrichPlans(plans) {
  if (process.env.GITHUB_PAT_RELEASE_PLAN || process.env.GH_TOKEN) {
    const specPrUrls = [];
    const specPrUrlsForPath = []; // only fetch files if plan lacks a spec path
    for (const p of plans) {
      const specUrl = (p.apiSpec && p.apiSpec.specPrUrl) || "";
      if (specUrl) {
        specPrUrls.push(specUrl);
        if (!p.typeSpecPath) specPrUrlsForPath.push(specUrl);
      }
    }
    const [statusMap, specPathMap] = await Promise.all([
      batchFetchPrStatuses(specPrUrls),
      batchFetchSpecProjectPaths(specPrUrlsForPath),
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

  // Fetch SDK PR status only (open/merged/closed) — details fetched on-demand when card is expanded
  if (process.env.GITHUB_PAT_RELEASE_PLAN || process.env.GH_TOKEN) {
    const sdkPrUrls = [];
    for (const p of plans) {
      for (const [, li] of Object.entries(p.languages || {})) {
        if (li.sdkPrUrl) sdkPrUrls.push(li.sdkPrUrl);
      }
    }
    const uniqueSdkPrUrls = [...new Set(sdkPrUrls.filter(Boolean))];
    if (uniqueSdkPrUrls.length) {
      console.log(`Fetching SDK PR statuses for ${uniqueSdkPrUrls.length} unique PRs...`);
      const statusMap = await batchFetchPrStatuses(uniqueSdkPrUrls);
      const now = Date.now();
      for (const p of plans) {
        for (const [, li] of Object.entries(p.languages || {})) {
          if (!li.sdkPrUrl) continue;
          const st = statusMap.get(li.sdkPrUrl);
          if (st) {
            li.sdkPrGitHubStatus = st;
            cache.prStatuses.set(li.sdkPrUrl, { data: st, updatedAt: now });
          }
        }
      }
      console.log(`SDK PR statuses fetched and cached for ${uniqueSdkPrUrls.length} PRs.`);
    }
  }

  // Compute lastActivity for each plan: latest of plan changedDate
  for (const p of plans) {
    let latest = p.changedDate ? new Date(p.changedDate).getTime() : 0;
    p.lastActivity = latest ? new Date(latest).toISOString() : "";
  }
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
  if (!cache.releasePlans.data && cache.releasePlans.refreshing) {
    // Cache is still warming up from startup
    return { plans: [], fetchedAt: null, loading: true };
  }
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
    const filterPlanId = req.query.releasePlan || req.query.releaseplan || "";

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
      await enrichPlans(plans);
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
    cache.prStatuses.clear();
    res.json({ ok: true, fetchedAt: cache.releasePlans.fetchedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Refresh a single release plan: re-fetches from DevOps, enriches, and updates cache.
app.post("/api/refresh-plan/:id", async (req, res) => {
  try {
    const wiId = parseInt(req.params.id, 10);
    if (!wiId) return res.status(400).json({ error: "Invalid work item ID" });

    // Fetch the single work item with full expand (includes relations for child IDs)
    const wiUrl = `${DEVOPS_ORG}/_apis/wit/workitems?ids=${wiId}&$expand=All&api-version=${API_VERSION}`;
    const wiResult = await devopsRequest(wiUrl, "GET");
    const workItems = wiResult.value || [];
    if (!workItems.length) return res.status(404).json({ error: "Work item not found" });
    const wi = workItems[0];

    // Fetch API Spec child work items
    const childIds = extractChildIds(wi);
    const apiSpecMap = {};
    if (childIds.length) {
      const childItems = await fetchWorkItemsBatch(childIds, API_SPEC_FIELDS);
      for (const c of childItems) {
        if ((c.fields["System.WorkItemType"] || "") === "API Spec") apiSpecMap[c.id] = c;
      }
    }

    // Map to plan object
    const plan = mapReleasePlan(wi, apiSpecMap);

    // Enrich: fetch spec PR status, SDK PR status, package info
    await enrichPlans([plan]);

    // Invalidate PR detail caches for this plan's SDK PRs so expansion fetches fresh data
    for (const [, li] of Object.entries(plan.languages || {})) {
      if (li.sdkPrUrl) {
        cache.prDetails.delete(li.sdkPrUrl);
        cache.prStatuses.delete(li.sdkPrUrl);
      }
    }

    // Update the plan in the global release plans cache
    if (cache.releasePlans.data && cache.releasePlans.data.plans) {
      const idx = cache.releasePlans.data.plans.findIndex(p => p.id === wiId);
      if (idx >= 0) {
        cache.releasePlans.data.plans[idx] = plan;
      } else {
        cache.releasePlans.data.plans.push(plan);
      }
    }

    res.json({ plan });
  } catch (err) {
    console.error("Refresh plan error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Fetch previous SDK PRs from work item updates history (on-demand per plan).
app.get("/api/previous-sdk-prs/:id", async (req, res) => {
  try {
    const wiId = parseInt(req.params.id, 10);
    if (!wiId) return res.status(400).json({ error: "Invalid work item ID" });
    const sdkPrFields = LANGUAGES.map(l => `Custom.SDKPullRequestFor${l}`);
    const previousPrs = {};
    for (const lang of LANGUAGES) previousPrs[LANGUAGE_DISPLAY[lang]] = [];
    let continuationToken = null;
    do {
      const tokenParam = continuationToken ? `&continuationToken=${encodeURIComponent(continuationToken)}` : "";
      const url = `${DEVOPS_ORG}/${DEVOPS_PROJECT}/_apis/wit/workitems/${wiId}/updates?api-version=${API_VERSION}${tokenParam}`;
      const { body: result, headers } = await devopsRequestWithHeaders(url, "GET");
      const updates = result.value || [];
      for (const upd of updates) {
        if (!upd.fields) continue;
        for (const lang of LANGUAGES) {
          const fieldName = `Custom.SDKPullRequestFor${lang}`;
          const change = upd.fields[fieldName];
          if (!change) continue;
          const oldVal = (change.oldValue || "").trim().replace(/\/+$/, "");
          if (oldVal && /github\.com\/.*\/pull\/\d+/.test(oldVal)) {
            const displayLang = LANGUAGE_DISPLAY[lang];
            if (!previousPrs[displayLang].includes(oldVal)) previousPrs[displayLang].push(oldVal);
          }
        }
      }
      continuationToken = headers["x-ms-continuationtoken"] || null;
    } while (continuationToken);
    // Remove any values that match the current PR (from cached plan data)
    if (cache.releasePlans.data) {
      const plan = cache.releasePlans.data.plans.find(p => p.id === wiId);
      if (plan && plan.languages) {
        for (const [lang, l] of Object.entries(plan.languages)) {
          if (l.sdkPrUrl && previousPrs[lang]) {
            previousPrs[lang] = previousPrs[lang].filter(u => u !== l.sdkPrUrl);
          }
        }
      }
    }
    res.json({ previousPrs });
  } catch (err) {
    console.error("Previous SDK PRs error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Batch PR status endpoint — returns just open/draft/merged/closed for multiple URLs.
// Uses server-side prStatuses cache (1-hour TTL, populated during enrichPlans).
app.post("/api/pr-statuses", async (req, res) => {
  try {
    const urls = (req.body && req.body.urls) || [];
    const hasGhToken = !!(process.env.GITHUB_PAT_RELEASE_PLAN || process.env.GH_TOKEN);
    if (!urls.length || !hasGhToken) return res.json({ statuses: {} });
    const unique = [...new Set(urls.filter(Boolean))];
    const result = {};
    const now = Date.now();
    const toFetch = [];
    for (const url of unique) {
      const entry = cache.prStatuses.get(url);
      if (entry && (now - entry.updatedAt) < CACHE_TTL_MS) {
        result[url] = entry.data;
      } else {
        toFetch.push(url);
      }
    }
    if (toFetch.length) {
      const statusMap = await batchFetchPrStatuses(toFetch);
      for (const url of toFetch) {
        const st = statusMap.get(url) || null;
        if (st) cache.prStatuses.set(url, { data: st, updatedAt: now });
        result[url] = st;
      }
    }
    res.json({ statuses: result });
  } catch (err) {
    console.error("PR statuses error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Lazy-load endpoint: fetch SDK PR details + statuses.
// Uses prDetails cache (15-min TTL). Also updates prStatuses global cache with fresh status.
app.post("/api/pr-details", async (req, res) => {
  try {
    const urls = (req.body && req.body.urls) || [];
    const hasGhToken = !!(process.env.GITHUB_PAT_RELEASE_PLAN || process.env.GH_TOKEN);
    if (!urls.length || !hasGhToken) return res.json({ details: {} });
    const unique = [...new Set(urls.filter(Boolean))];
    const result = {};

    const now = Date.now();
    const toFetch = [];
    for (const url of unique) {
      const entry = cache.prDetails.get(url);
      if (entry && (now - entry.updatedAt) < PR_DETAIL_CACHE_TTL_MS) {
        result[url] = entry.data;
      } else {
        toFetch.push(url);
      }
    }
    if (toFetch.length) {
      const [statusMap, detailMap] = await Promise.all([batchFetchPrStatuses(toFetch), batchFetchPrDetails(toFetch)]);
      for (const url of toFetch) {
        const d = detailMap.get(url) || null;
        const st = statusMap.get(url) || null;
        const r = {
          gitHubStatus: st,
          prDetails: d ? { mergeable: d.mergeable, mergeableState: d.mergeableState, isApproved: d.isApproved, approvedBy: d.approvedBy, failedChecks: d.failedChecks, apiViewUrl: d.apiViewUrl || "", title: d.title || "", requestedReviewers: d.requestedReviewers || [], latestComment: d.latestComment || null, updatedAt: d.updatedAt || "" } : null,
        };
        cache.prDetails.set(url, { data: r, updatedAt: now });
        // Also update the global basic status cache with fresh data
        if (st) cache.prStatuses.set(url, { data: st, updatedAt: now });
        result[url] = r;
      }
    }

    res.json({ details: result });
  } catch (err) {
    console.error("PR details error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Static files (behind auth) ───────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── Start server + background cache refresh ──────────────────
app.listen(PORT, async () => {
  console.log(`Release Plan Dashboard running on http://localhost:${PORT}`);
  console.log(`GitHub OAuth enabled (orgs: ${REQUIRED_ORGS.join(", ")})`);
  if (!process.env.DEVOPS_RELEASE_PLAN_PAT) console.warn("WARNING: DEVOPS_RELEASE_PLAN_PAT not set.");

  // Mint GitHub App token via Key Vault (falls back to PAT/GH_TOKEN if unavailable)
  await mintGitHubAppToken();

  if (!process.env.GITHUB_PAT_RELEASE_PLAN && !process.env.GH_TOKEN) {
    console.log("WARNING: Neither GITHUB_PAT_RELEASE_PLAN nor GH_TOKEN is set and token minting failed — GitHub PR details and spec PR enrichment will be unavailable.");
  }

  // Pre-warm cache on startup
  refreshReleasePlansCache().catch(err => console.error("Initial cache warm-up failed:", err.message));

  // Refresh GitHub App token every 50 minutes (token valid ~1 hr)
  setInterval(() => {
    console.log("Scheduled GitHub App token refresh triggered.");
    mintGitHubAppToken().catch(err => console.warn("Token refresh failed:", err.message));
  }, GH_TOKEN_REFRESH_MS);

  // Refresh cache every hour in the background
  setInterval(() => {
    console.log("Scheduled cache refresh triggered.");
    refreshReleasePlansCache().catch(err => console.error("Scheduled cache refresh failed:", err.message));
  }, CACHE_TTL_MS);
});
