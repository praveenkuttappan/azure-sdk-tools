// Release Plan Dashboard — Express server with GitHub OAuth and cached API data.

import express from "express";
import session from "express-session";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { mintGitHubAppToken, exchangeCodeForToken, getGitHubUser, isMemberOfAnyOrg, getBaseUrl } from "./lib/auth.js";
import { createRateLimiter } from "./lib/rate-limit.js";
import { CACHE_TTL_MS } from "./lib/cache.js";
import apiRoutes from "./routes/api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  ["GITHUB_APP_CLIENT_ID", process.env.GITHUB_APP_CLIENT_ID],
  ["GITHUB_APP_CLIENT_SECRET", process.env.GITHUB_APP_CLIENT_SECRET],
].filter(([, v]) => !v).map(([k]) => k);

if (MISSING_TOKEN_VARS.length) {
  console.error(`ERROR: Missing required environment variables: ${MISSING_TOKEN_VARS.join(", ")}`);
  process.exit(1);
}

const GITHUB_CLIENT_ID = process.env.GITHUB_APP_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_APP_CLIENT_SECRET;

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
  res.sendFile(path.join(__dirname, "public", "login.html"));
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
  let responseUser = user;
  if (user) {
    const pmList = (process.env.RELEASE_PLAN_DASHBOARD_PM_USERS || "").split(",").map(u => u.trim().toLowerCase()).filter(Boolean);
    responseUser = { ...user, isPM: pmList.includes((user.login || "").toLowerCase()) };
  }
  res.json(responseUser);
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
async function start() {
  // Mint GitHub App token before accepting requests
  await mintGitHubAppToken();

  if (!process.env.GITHUB_PAT_RELEASE_PLAN && !process.env.GH_TOKEN) {
    console.warn("WARNING: Neither GITHUB_PAT_RELEASE_PLAN nor GH_TOKEN is set — GitHub PR enrichment will be unavailable.");
  }

  // Pre-warm cache before listening
  try {
    await apiRoutes.refreshReleasePlansCache();
  } catch (err) {
    console.error("Initial cache warm-up failed:", err.message);
  }

  app.listen(PORT, () => {
    console.log(`Release Plan Dashboard running on http://localhost:${PORT}`);
    console.log(`GitHub OAuth enabled (orgs: ${REQUIRED_ORGS.join(", ")})`);
  });

  // Refresh GitHub App token every 50 minutes
  setInterval(() => {
    mintGitHubAppToken().catch(err => console.warn("Token refresh failed:", err.message));
  }, GH_TOKEN_REFRESH_MS);

  // Refresh cache every hour in the background
  setInterval(() => {
    apiRoutes.refreshReleasePlansCache().catch(err => console.error("Scheduled cache refresh failed:", err.message));
  }, CACHE_TTL_MS);
}

start().catch(err => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
