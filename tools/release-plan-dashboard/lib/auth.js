"use strict";

const https = require("https");
const crypto = require("crypto");

// ── GitHub App token minting via Azure Key Vault ──────────────
const KEYVAULT_NAME = process.env.KEYVAULT_NAME;
const KEYVAULT_KEY_NAME = process.env.KEYVAULT_KEY_NAME;
const GITHUB_APP_ID = process.env.GITHUB_APP_NUMERIC_ID;
const GITHUB_INSTALL_OWNER = process.env.GITHUB_INSTALL_OWNER;

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
async function exchangeCodeForToken(clientId, clientSecret, code) {
  const postData = JSON.stringify({
    client_id: clientId, client_secret: clientSecret, code,
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
  const lowerOrgs = orgs.map(o => o.toLowerCase());
  let page = 1;
  while (true) {
    const res = await httpsReq({
      hostname: "api.github.com", path: `/users/${username}/orgs?per_page=100&page=${page}`, method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "release-plan-dashboard" },
    });
    console.log(`Org check page ${page}: status=${res.statusCode}, count=${Array.isArray(res.body) ? res.body.length : 0}`);
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
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getBaseUrl(req) {
  const host = req.hostname || req.get("host") || "";
  if (host === "localhost" || host === "127.0.0.1") {
    return `http://${req.get("host")}`;
  }
  return process.env.REDIRECT_URL || "https://releaseplan-dashboard.azurewebsites.net";
}

module.exports = {
  mintGitHubAppToken,
  exchangeCodeForToken,
  getGitHubUser,
  isMemberOfAnyOrg,
  escapeHtml,
  getBaseUrl,
};
