# Release Plan Detailed Steps

> **CRITICAL**: Do not mention or display Azure DevOps work item links/URLs. Only provide Release Plan Link and Release Plan ID to the user. All manual updates must be made through the Release Planner Tool (https://aka.ms/sdk-release-planner).

## Required Information

Collect these details (do not use temporary values):

- **TypeSpec project path**: Relative path to TypeSpec project root in azure-rest-api-specs repo. For e.g. `specification/contosowidgetmanager/Contoso.WidgetManager`
- **Expected Release Timeline**: "Month YYYY" format
- **SDK Release Type**: "beta" (preview) or "stable" (GA)
- **TypeSpec pull request URL**: API spec pull request that contains the spec changes for the SDK.
- **Service Tree ID**: This is Optional and only required if this is the first release plan created for the service. It's required for automatic KPI attestion in the service tree for your product. GUID format - confirm with user
- **Product Service Tree ID**: This is Optional and only required if this is the first release plan created for the service. It's required for automatic KPI attestion in the service tree for your product. GUID format - confirm with user

## SDK Details Update

To update SDK details in the release plan:

- Run `azsdk_update_sdk_details_in_release_plan` with the release plan work item ID and TypeSpec project path

## Namespace Approval (Management Plane Only)

For first release of management plane SDK:

1. Check if namespace approval issue already exists
2. If not, collect GitHub issue from Azure/azure-sdk repo
3. Run `azsdk_link_namespace_approval_issue`

## Linking SDK Pull Requests

If SDK PRs exist:

1. Ensure GitHub CLI authentication (`gh auth login`)
2. Run `azsdk_link_sdk_pull_request_to_release_plan` for each PR

## SDK pull request validation

SDK pull request must target to one of the following language repos.
| Repo | Language |
|------|----------|
| Azure/azure-sdk-for-go | Go |
| Azure/azure-sdk-for-js | JavaScript |
| Azure/azure-sdk-for-java | Java |
| Azure/azure-sdk-for-net | .NET |
| Azure/azure-sdk-for-python | Python |
| Azure/azure-sdk-for-rust | Rust |
