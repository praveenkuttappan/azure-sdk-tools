using System.ComponentModel;
using System.CommandLine;
using System.CommandLine.Parsing;
using Azure.Sdk.Tools.Cli.Commands;
using Azure.Sdk.Tools.Cli.Helpers;
using Azure.Sdk.Tools.Cli.Models;
using Azure.Sdk.Tools.Cli.Models.Responses.Package;
using Azure.Sdk.Tools.Cli.Services;
using Azure.Sdk.Tools.Cli.Services.Languages;
using Azure.Sdk.Tools.Cli.Tools.Core;
using ModelContextProtocol.Server;

namespace Azure.Sdk.Tools.Cli.Tools.Package;

/// <summary>
/// Tool for updating package metadata files in Azure SDK packages.
/// Supports running configured script or built-in code for update flows.
/// </summary>
[McpServerToolType, Description("This type contains the tools to update package metadata content for Azure SDK packages.")]
public class MetadataUpdateTool : LanguageMcpTool
{
    private readonly ISpecGenSdkConfigHelper _specGenSdkConfigHelper;

    public MetadataUpdateTool(
        IGitHelper gitHelper,
        ILogger<MetadataUpdateTool> logger,
        ISpecGenSdkConfigHelper specGenSdkConfigHelper,
        IEnumerable<LanguageService> languageServices)
        : base(languageServices, gitHelper, logger)
    {
        _specGenSdkConfigHelper = specGenSdkConfigHelper;
    }

    public override CommandGroup[] CommandHierarchy { get; set; } = [SharedCommandGroups.Package];

    private const string UpdateMetadataCommandName = "update-metadata";

    protected override Command GetCommand() =>
        new(UpdateMetadataCommandName, "Updates package metadata files for Azure SDK packages.") { SharedOptions.PackagePath };

    public override async Task<CommandResponse> HandleCommand(ParseResult parseResult, CancellationToken ct)
    {
        var packagePath = parseResult.GetValue(SharedOptions.PackagePath);
        return await UpdateMetadataAsync(packagePath, ct);
    }

    /// <summary>
    /// Updates the package metadata content for a specified package.
    /// </summary>
    /// <param name="packagePath">The absolute path to the package directory.</param>
    /// <param name="ct">Cancellation token for the operation.</param>
    /// <returns>A response indicating the result of the metadata update operation.</returns>
    [McpServerTool(Name = "azsdk_package_update_metadata"), Description("Updates the package metadata content for a specified package.")]
    public async Task<PackageOperationResponse> UpdateMetadataAsync(
        [Description("The absolute path to the package directory.")] string packagePath,
        CancellationToken ct)
    {
        try
        {
            // Validate package path
            if (string.IsNullOrWhiteSpace(packagePath))
            {
                return PackageOperationResponse.CreateFailure("Package path is required and cannot be empty.");
            }

            if (!Directory.Exists(packagePath))
            {
                return PackageOperationResponse.CreateFailure($"Package path does not exist: {packagePath}");
            }

            // Discover the repository root
            var sdkRepoRoot = gitHelper.DiscoverRepoRoot(packagePath);
            if (sdkRepoRoot == null)
            {
                return PackageOperationResponse.CreateFailure("Unable to find git repository root from the provided package path.");
            }

            this.logger.LogInformation("Repository root discovered: {SdkRepoRoot}", sdkRepoRoot);

            // Get language service
            var languageService = GetLanguageService(packagePath);
            var (configContentType, configValue) = await _specGenSdkConfigHelper.GetConfigurationAsync(sdkRepoRoot, SpecGenSdkConfigType.UpdateMetadata);
            if (configContentType != SpecGenSdkConfigContentType.Unknown && !string.IsNullOrEmpty(configValue))
            {
                this.logger.LogInformation("Found valid configuration for updating package metadata. Executing configured script...");

                // Prepare script parameters
                var scriptParameters = new Dictionary<string, string>
                {
                    { "SdkRepoPath", sdkRepoRoot },
                    { "PackagePath", packagePath }
                };

                // Create and execute process options for the update-metadata script
                var processOptions = _specGenSdkConfigHelper.CreateProcessOptions(configContentType, configValue, sdkRepoRoot, packagePath, scriptParameters);
                if (processOptions != null)
                {
                    // Get package info from language service
                    PackageInfo? packageInfo = null;                    
                    if (languageService != null)
                    {
                        try
                        {
                            packageInfo = await languageService.GetPackageInfo(packagePath, ct);
                        }
                        catch (Exception ex)
                        {
                            this.logger.LogWarning(ex, "Failed to get package info from language service for package: {PackagePath}", packagePath);
                        }
                    }
                    
                    return await _specGenSdkConfigHelper.ExecuteProcessAsync(processOptions, ct, packageInfo, "Package metadata content is updated.", ["Update the version if it's a release."]);
                }
            }

            // Hand over to language service for language-specific update steps
            this.logger.LogInformation("No configured script found for updating package metadata. Checking for language-specific update implementations...");

            // Call language service to update metadata
            if (languageService != null)
            {
                return await languageService.UpdateMetadataAsync(packagePath, ct);
            }

            this.logger.LogInformation("No language-specific package update implementation found for package path: {packagePath}.", packagePath);
            return PackageOperationResponse.CreateSuccess("No package metadata updates need to be performed.", null);
        }
        catch (Exception ex)
        {
            this.logger.LogError(ex, "Error occurred while updating package metadata for package: {PackagePath}", packagePath);
            return PackageOperationResponse.CreateFailure($"An error occurred: {ex.Message}");
        }
    }
}
