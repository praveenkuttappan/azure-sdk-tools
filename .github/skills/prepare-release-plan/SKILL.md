---
name: prepare-release-plan
license: MIT
metadata:
  version: "1.0.0"
  distribution: shared
description: "Create and manage release plan work items for Azure SDK releases across languages. **UTILITY SKILL**. USE FOR: \"create release plan\", \"update release plan\", \"link SDK PR to plan\", \"namespace approval\", \"check release plan status\". DO NOT USE FOR: SDK code generation, pipeline troubleshooting, API review feedback. INVOKES: azure-sdk-mcp:azsdk_create_release_plan, azure-sdk-mcp:azsdk_get_release_plan, azure-sdk-mcp:azsdk_link_sdk_pull_request_to_release_plan, azure-sdk-mcp:azsdk_abandon_release_plan."
compatibility:
  requires: "azure-sdk-mcp server, API spec PR in Azure/azure-rest-api-specs"
---

# Create/Prepare Release Plan

> Do not display Azure DevOps work item URLs. Only provide Release Plan Link and ID.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `azure-sdk-mcp:azsdk_create_release_plan` | Create plan |
| `azure-sdk-mcp:azsdk_get_release_plan` | Get details |
| `azure-sdk-mcp:azsdk_get_release_plan_for_spec_pr` | Find by spec PR |
| `azure-sdk-mcp:azsdk_update_sdk_details_in_release_plan` | Update SDK info |
| `azure-sdk-mcp:azsdk_link_sdk_pull_request_to_release_plan` | Link SDK PR |
| `azure-sdk-mcp:azsdk_link_namespace_approval_issue` | Link namespace |
| `azure-sdk-mcp:azsdk_abandon_release_plan` | Abandon a release plan |

## Steps

1. **Prerequisites** — Check for API spec PR; prompt if unavailable.
2. **Check Existing** — Query by plan number or spec PR link.
3. **Gather Info** — Collect Service Tree IDs, timeline. See [details](references/release-plan-details.md).
4. **Create** — Run `azure-sdk-mcp:azsdk_create_release_plan`. Create a release plan without service id and product ID. If request fails with unknown service and product error then prompt the user for service ID and product ID in the service tree and retry to create the release plan.
5. **Namespace** — For mgmt plane first releases, link approval issue.
6. **Link PRs** — Link SDK PRs to plan.

## Examples

- "Create a release plan for my spec PR"
- "Link my SDK PR to release plan"
- "Create a release plan for my TypeSpec project"

## Troubleshooting

- Requires `azure-sdk-mcp` server; no CLI fallback.
- If creation fails, verify spec PR URL and Service Tree IDs.


# Link SDK pull reuests to a release plan

## MCP Tools

| Tool | Purpose |
|------|---------|
| `azure-sdk-mcp:azsdk_get_release_plan` | Get details |
| `azure-sdk-mcp:azsdk_get_release_plan_for_spec_pr` | Find by spec PR |
| `azure-sdk-mcp:azsdk_link_sdk_pull_request_to_release_plan` | Link SDK PR |

## Steps

1. **Prerequisites** - Get release plan using release plan Id, TypeSpec API spec PR or TypeSpec. If a release plan does not exists then create a release plan first and resume.
2. **Identify pull request language**: Identify the SDK language and validate pull request URL. See [SDK pull request validation](references/release-plan-details.md).
3. **Link SDK PR**: Call MCP tool `azure-sdk-mcp:azsdk_link_sdk_pull_request_to_release_plan` to link SDK pull request to the release plan.