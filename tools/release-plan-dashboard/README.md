# Release Plan Dashboard

A single-page web dashboard for viewing Azure SDK Release Plan work items from Azure DevOps. It provides a real-time overview of release plans across all Azure SDK languages, grouped by status and plane type.

## Features

- **Live Azure DevOps integration** — queries Release Plan work items (In Progress, New, Not Started, and recently Finished) from the `azure-sdk` org's `Release` project
- **Management / Data Plane split** — release plans categorized by plane type, displayed in separate columns
- **Status grouping** — In Progress, Partially Released, New/Not Started, and Recently Finished sections
- **Expandable detail cards** — click a release plan card to see full details:
  - Per-language SDK pull request status (PR checks, approvals, merge status)
  - API Spec PR link and status
  - Spec project / TypeSpec path
  - Package version, namespace approval, API review status
  - Product details with Service Tree link
- **Current stage tracking** — each release plan shows its progression stage (API Spec In Progress → SDK To Be Generated → SDK Review In Progress → SDK Ready To Be Released, etc.)
- **Action required indicator** — shows who needs to act (Spec PR Reviewer, SDK PR Reviewer, or Service Team)
- **Duplicate detection** — identifies potentially duplicate release plans and annotates them
- **SDK type badges** — highlights Beta vs Stable releases
- **Search & filter** — filter by title, product name, owner, or release plan ID
- **URL parameters** — `?releasePlan=<id>` to view a single plan, `?filter=<keyword>` to pre-filter
- **Server-side caching** — release plan data cached with 1-hour TTL to avoid rate limiting; PR details cached per-URL
- **GitHub OAuth authentication** — restricts access to Microsoft or Azure GitHub org members
- **Lazy-loaded PR details** — SDK PR details fetched on demand when a card is expanded

## Architecture

**`server.js`** is a Node.js + Express server that:
- Queries Azure DevOps WIQL API for release plan work items and their child API Spec items
- Enriches data with GitHub PR status (spec PRs, SDK PRs) via the GitHub API
- Caches all release plan data server-side (1-hour TTL, pre-warmed on startup)
- Serves a REST API (`/api/release-plans`, `/api/pr-details`) consumed by the frontend
- Handles GitHub OAuth login flow

**`public/`** contains the frontend (HTML, CSS, JS) that renders the dashboard from API data.

**`fetch-data.js`** is a standalone offline data-fetching script (optional, for batch/cron use).

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- An Azure DevOps Personal Access Token (PAT) with read access to work items in the `azure-sdk` organization

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Set environment variables:

   ```bash
   # Linux / macOS
   export DEVOPS_RELEASE_PLAN_PAT="your-pat-here"
   export GITHUB_PAT_RELEASE_PLAN="your-github-pat-here"  # optional, for PR details

   # Windows (PowerShell)
   $env:DEVOPS_RELEASE_PLAN_PAT = "your-pat-here"
   $env:GITHUB_PAT_RELEASE_PLAN = "your-github-pat-here"  # optional
   ```

3. Start the server:

   ```bash
   npm start
   ```

4. Open <http://localhost:3000> in your browser.

## Configuration

| Environment Variable | Description | Required |
|---|---|---|
| `DEVOPS_RELEASE_PLAN_PAT` | Azure DevOps PAT for work item access | Yes |
| `GITHUB_PAT_RELEASE_PLAN` | GitHub PAT for spec/SDK PR status | No (degrades gracefully) |
| `GITHUB_APP_CLIENT_ID` | GitHub OAuth App client ID | **Yes** |
| `GITHUB_APP_CLIENT_SECRET` | GitHub OAuth App client secret | **Yes** |
| `REDIRECT_URL` | OAuth redirect base URL override | No (defaults to `https://releaseplan-dashboard.azurewebsites.net`) |
| `PORT` | HTTP port to listen on | No (default: 3000) |

## Authentication

GitHub OAuth authentication is **required**. The server will not start without `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` set. Users must be public members of the **Microsoft** or **Azure** GitHub organization.

To set up a GitHub OAuth App:
1. Go to GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
2. Set the Authorization callback URL to `https://<your-domain>/auth/github/callback`
3. Use the generated Client ID and Client Secret as environment variables

## Deployment

### Azure App Service

1. Build the deployable zip:
   ```bash
   # The deploy.zip in the repo root contains server.js, package files, and public/
   ```
2. Deploy to Azure App Service (Node.js runtime)
3. Set the required environment variables in App Service → Configuration → Application settings
4. The app runs `npm start` which launches `server.js`

### Any Node.js Host

1. Copy `server.js`, `package.json`, `package-lock.json`, and `public/` to the host
2. Run `npm install --production`
3. Set environment variables
4. Run `npm start`

## URL Parameters

| Parameter | Description | Example |
|---|---|---|
| `releasePlan` | Show a single release plan by ID | `?releasePlan=2171` |
| `filter` | Pre-fill the search box with a keyword | `?filter=storage` |

Both can be combined: `?releasePlan=2171&filter=storage`
