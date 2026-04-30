// Release Plan Dashboard — Express server with GitHub OAuth and cached API data.
"use strict";

const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const path = require("path");

const { mintGitHubAppToken, exchangeCodeForToken, getGitHubUser, isMemberOfAnyOrg, escapeHtml, getBaseUrl } = require("./lib/auth");
const { createRateLimiter } = require("./lib/rate-limit");
const { CACHE_TTL_MS } = require("./lib/cache");
const apiRoutes = require("./routes/api");

// ── Validate required env vars ────────────────────────────────
const KEYVAULT_NAME = process.env.KEYVAULT_NAME;
const KEYVAULT_KEY_NAME = process.env.KEYVAULT_KEY_NAME;
const GITHUB_APP_ID = process.env.GITHUB_APP_NUMERIC_ID;
const GITHUB_INSTALL_OWNER = process.env.GITHUB_INSTALL_OWNER;
const GH_TOKEN_REFRESH_MS = 50 * 60 * 1000;

const MISSING_TOKEN_VARS = [
  ["KEYVAULT_NAME", KEYVAULT_NAME],
  ["KEYVAULT_KEY_NAME", KEYVAULT_KEY_NAME],
  ["GITHUB_APP_NUMERIC_ID", GITHUB_APP_ID],
  ["GITHUB_INSTALL_OWNER", GITHUB_INSTALL_OWNER],
].filter(([, v]) => !v).map(([k]) => k);

if (MISSING_TOKEN_VARS.length) {
  console.error(`ERROR: Missing required environment variables for GitHub App token signing: ${MISSING_TOKEN_VARS.join(", ")}`);
  process.exit(1);
}

const GITHUB_CLIENT_ID = process.env.GITHUB_APP_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_APP_CLIENT_SECRET || "";
if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
  console.error("ERROR: GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET must be set.");
  process.exit(1);
}

const REQUIRED_ORGS = ["microsoft", "Azure"];
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const PORT = process.env.PORT || 3000;

// ── App setup ─────────────────────────────────────────────────
const app = express();

// Trust the reverse proxy (Azure App Service / front-door)
app.set("trust proxy", 1);

// Session
app.use(session({
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === "production", httpOnly: true, sameSite: "lax", maxAge: 24 * 60 * 60 * 1000 },
}));
app.use(express.json());

// ── CSRF protection for state-changing requests ───────────────
function csrfProtection(req, res, next) {
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "DELETE") return next();
  const origin = req.get("origin") || "";
  const referer = req.get("referer") || "";
  const host = req.get("host") || "";
  if (origin && new URL(origin).host === host) return next();
  if (!origin && referer) {
    try { if (new URL(referer).host === host) return next(); } catch { /* invalid referer */ }
  }
  if (!origin && !referer) return next();
  return res.status(403).json({ error: "Forbidden: cross-origin request blocked." });
}
app.use(csrfProtection);

// ── Health check (unauthenticated) ────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "healthy", uptime: process.uptime() });
});

// ── Authentication middleware ─────────────────────────────────
function requireAuth(req, res, next) {
  if (["/auth/github", "/auth/github/callback", "/auth/logout", "/login", "/health", "/favicon.ico"].includes(req.path)) return next();
  if (req.session && req.session.user) return next();
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
    const token = await exchangeCodeForToken(GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, code);
    if (!token) return res.redirect("/login?error=Failed+to+get+access+token.");
    const user = await getGitHubUser(token);
    if (!user) return res.redirect("/login?error=Failed+to+get+GitHub+user+info.");
    console.log(`User authenticated: ${user.login}`);
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

// ── Rate limiting for API endpoints ───────────────────────────
const apiRateLimiter = createRateLimiter({ windowMs: 60 * 1000, maxRequests: 30 });
app.use("/api", apiRateLimiter);

// ── API routes ────────────────────────────────────────────────
app.use(apiRoutes);

// ── Favicon (no file needed) ──────────────────────────────────
app.get("/favicon.ico", (_req, res) => res.status(204).end());

// ── Static files (behind auth) ────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── Start server + background cache refresh ──────────────────
app.listen(PORT, async () => {
  console.log(`Release Plan Dashboard running on http://localhost:${PORT}`);
  console.log(`GitHub OAuth enabled (orgs: ${REQUIRED_ORGS.join(", ")})`);
  if (!process.env.DEVOPS_RELEASE_PLAN_PAT) console.warn("WARNING: DEVOPS_RELEASE_PLAN_PAT not set.");

  // Mint GitHub App token via Key Vault
  await mintGitHubAppToken();

  if (!process.env.GITHUB_PAT_RELEASE_PLAN && !process.env.GH_TOKEN) {
    console.log("WARNING: Neither GITHUB_PAT_RELEASE_PLAN nor GH_TOKEN is set — GitHub PR enrichment will be unavailable.");
  }

  // Pre-warm cache on startup
  try {
    await apiRoutes.refreshReleasePlansCache();
  } catch (err) {
    console.error("Initial cache warm-up failed:", err.message);
  }

  // Refresh GitHub App token every 50 minutes
  setInterval(() => {
    mintGitHubAppToken().catch(err => console.warn("Token refresh failed:", err.message));
  }, GH_TOKEN_REFRESH_MS);

  // Refresh cache every hour in the background
  setInterval(() => {
    apiRoutes.refreshReleasePlansCache().catch(err => console.error("Scheduled cache refresh failed:", err.message));
  }, CACHE_TTL_MS);
});
