"use strict";

// Tests for routes/api.js input validation and caching behavior
// These test the route handlers' input validation without making real API calls.

process.env.KEYVAULT_NAME = "test-vault";
process.env.KEYVAULT_KEY_NAME = "test-key";
process.env.GITHUB_APP_NUMERIC_ID = "12345";
process.env.GITHUB_INSTALL_OWNER = "TestOrg";
process.env.GITHUB_APP_CLIENT_ID = "test-client-id";
process.env.GITHUB_APP_CLIENT_SECRET = "test-client-secret";
process.env.DEVOPS_RELEASE_PLAN_PAT = "test-pat";

// Mock external API calls
jest.mock("../lib/devops-api", () => {
  const original = jest.requireActual("../lib/devops-api");
  return {
    ...original,
    devopsRequest: jest.fn().mockResolvedValue({ workItems: [], value: [] }),
    devopsRequestWithHeaders: jest.fn().mockResolvedValue({ body: { value: [] }, headers: {} }),
    runWiql: jest.fn().mockResolvedValue([]),
    fetchWorkItemsBatch: jest.fn().mockResolvedValue([]),
    fetchPackageWorkItems: jest.fn().mockResolvedValue(new Map()),
    fetchAzureSdkPackageList: jest.fn().mockResolvedValue(""),
  };
});

jest.mock("../lib/github-api", () => ({
  parseGitHubPrUrl: (url) => {
    if (!url) return null;
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return m ? { owner: m[1], repo: m[2], number: m[3] } : null;
  },
  batchFetchPrStatuses: jest.fn().mockResolvedValue(new Map()),
  batchFetchPrDetails: jest.fn().mockResolvedValue(new Map()),
  batchFetchSpecProjectPaths: jest.fn().mockResolvedValue(new Map()),
}));

const express = require("express");
const http = require("http");
const session = require("express-session");

let app, server;

beforeAll((done) => {
  app = express();
  app.use(session({ secret: "test", resave: false, saveUninitialized: false }));
  app.use(express.json());

  // Inject a fake authenticated session
  app.use((req, res, next) => {
    req.session.user = { login: "testuser" };
    next();
  });

  const apiRoutes = require("../routes/api");
  app.use(apiRoutes);

  server = app.listen(0, done);
});

afterAll((done) => {
  server.close(done);
});

function getPort() { return server.address().port; }

function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "localhost", port: getPort(), path, method,
      headers: { "Content-Type": "application/json" },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe("API routes", () => {
  describe("GET /api/release-plans", () => {
    test("returns plans structure (empty on first call)", async () => {
      const res = await httpRequest("GET", "/api/release-plans");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("plans");
      expect(res.body).toHaveProperty("fetchedAt");
    });
  });

  describe("POST /api/pr-statuses", () => {
    test("returns 400 if urls is not an array", async () => {
      const res = await httpRequest("POST", "/api/pr-statuses", { urls: "not-array" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("array");
    });

    test("returns empty statuses for empty urls", async () => {
      const res = await httpRequest("POST", "/api/pr-statuses", { urls: [] });
      expect(res.status).toBe(200);
      expect(res.body.statuses).toEqual({});
    });

    test("filters out invalid URLs", async () => {
      const res = await httpRequest("POST", "/api/pr-statuses", {
        urls: ["not-a-url", "https://example.com", "https://github.com/org/repo/pull/1"],
      });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/pr-details", () => {
    test("returns 400 if urls is not an array", async () => {
      const res = await httpRequest("POST", "/api/pr-details", { urls: 123 });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("array");
    });

    test("returns empty details for empty urls", async () => {
      const res = await httpRequest("POST", "/api/pr-details", { urls: [] });
      expect(res.status).toBe(200);
      expect(res.body.details).toEqual({});
    });

    test("accepts valid PR URLs", async () => {
      const res = await httpRequest("POST", "/api/pr-details", {
        urls: ["https://github.com/Azure/azure-sdk-for-net/pull/123"],
      });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("details");
    });
  });

  describe("GET /api/previous-sdk-prs/:id", () => {
    test("returns 400 for non-numeric ID", async () => {
      const res = await httpRequest("GET", "/api/previous-sdk-prs/abc");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid");
    });

    test("returns previous PRs structure for valid ID", async () => {
      const res = await httpRequest("GET", "/api/previous-sdk-prs/12345");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("previousPrs");
    });
  });

  describe("POST /api/refresh-plan/:id", () => {
    test("returns 400 for non-numeric ID", async () => {
      const res = await httpRequest("POST", "/api/refresh-plan/invalid", {});
      expect(res.status).toBe(400);
    });
  });
});
