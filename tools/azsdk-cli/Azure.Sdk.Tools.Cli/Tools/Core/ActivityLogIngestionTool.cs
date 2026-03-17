// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
using System.Collections.Generic;
using System.CommandLine;
using System.CommandLine.Parsing;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using Azure.Sdk.Tools.Cli.Commands;
using Azure.Sdk.Tools.Cli.Helpers;
using Azure.Sdk.Tools.Cli.Models;
using Azure.Sdk.Tools.Cli.Telemetry;
using ModelContextProtocol.Server;
using OpenTelemetry.Trace;

namespace Azure.Sdk.Tools.Cli.Tools.Core;

[McpServerToolType, Description("Ingest .azsdk-agent-activity.log entries into Application Insights")]
public class ActivityLogIngestionTool(
    ITelemetryService telemetryService,
    IActivityLogSanitizer activitySanitizer,
    ILogger<ActivityLogIngestionTool> logger
) : MCPTool
{
    private const string IngestCommandName = "ingest-activity-log";
    private const string IngestToolName = "azsdk_ingest_activity_log";
    private const string ProcessedStatusValue = "Processed";

    private readonly ITelemetryService telemetryService = telemetryService;
    private readonly ILogger<ActivityLogIngestionTool> logger = logger;
    private readonly IActivityLogSanitizer activitySanitizer = activitySanitizer;

    private readonly JsonSerializerOptions readOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly JsonSerializerOptions writeOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly Option<string> filePathOption = new("--file-path", "-f")
    {
        Description = "Path to a JSON file containing a serialized list of activity log records",
        Required = true
    };

    protected override Command GetCommand() => new McpCommand(IngestCommandName, "Ingest activity log entries into Application Insights", IngestToolName)
    {
        filePathOption
    };

    public override async Task<CommandResponse> HandleCommand(ParseResult parseResult, CancellationToken ct)
    {
        var filePath = parseResult.GetValue(filePathOption);
        return await IngestActivityLog(filePath, ct);
    }

    [McpServerTool(Name = IngestToolName)]
    [Description("Ingests activity log entries into Application Insights")]
    public async Task<CommandResponse> IngestActivityLog(
        [Description("Path to a JSON file containing a serialized list of activity log records")]
        string filePath,
        CancellationToken ct = default)
    {        
        var shouldDeleteFile = false;
        try
        {
            //Thread.Sleep(20000);
            if (string.IsNullOrWhiteSpace(filePath))
            {
                return new ActivityLogIngestionResponse
                {
                    ResponseError = "File path is required"
                };
            }

            if (!File.Exists(filePath))
            {
                return new ActivityLogIngestionResponse
                {
                    ResponseError = $"File not found: {filePath}"
                };
            }

            shouldDeleteFile = true;

            var payload = await File.ReadAllTextAsync(filePath, ct);
            var records = DeserializeRecords(payload);
            if (records.Count == 0)
            {
                return new ActivityLogIngestionResponse();
            }

            return await PublishTelemetryEventsAsync(records, ct);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to ingest activity log from file {FilePath}", filePath);
            return new ActivityLogIngestionResponse
            {
                ResponseError = $"Failed to ingest activity log: {ex.Message}"
            };
        }
        finally
        {
            if (shouldDeleteFile)
            {
                //DeleteInputFile(filePath);
            }
        }
    }

    private void DeleteInputFile(string filePath)
    {
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return;
        }

        try
        {
            if (File.Exists(filePath))
            {
                File.Delete(filePath);
                logger.LogDebug("Deleted activity log input file {FilePath}", filePath);
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to delete activity log input file {FilePath}", filePath);
        }
    }

    private List<ActivityLogRecord> DeserializeRecords(string payload)
    {
        if (string.IsNullOrWhiteSpace(payload))
        {
            return [];
        }

        var trimmed = payload.Trim();
        if (trimmed.StartsWith("[", StringComparison.Ordinal))
        {
            return JsonSerializer.Deserialize<List<ActivityLogRecord>>(payload, readOptions) ?? [];
        }

        var singleRecord = JsonSerializer.Deserialize<ActivityLogRecord>(payload, readOptions);
        return singleRecord != null ? [singleRecord] : [];
    }

    private async Task<ActivityLogIngestionResponse> PublishTelemetryEventsAsync(List<ActivityLogRecord> records, CancellationToken ct)
    {
        var processed = 0;
        var skipped = 0;
        var malformed = 0;

        var sanitizedRecords = await activitySanitizer.SanitizeAsync(records, ct);
        foreach (var record in sanitizedRecords)
        {
            ct.ThrowIfCancellationRequested();

            if (record == null)
            {
                malformed++;
                continue;
            }

            if (string.Equals(record.Status, ProcessedStatusValue, StringComparison.OrdinalIgnoreCase))
            {
                skipped++;
                continue;
            }

            if (IsRecordEmpty(record))
            {
                malformed++;
                continue;
            }

            AddActivity(record);
            processed++;
        }

        return new ActivityLogIngestionResponse
        {
            ProcessedRecords = processed,
            SkippedRecords = skipped,
            MalformedRecords = malformed
        };
    }

    private async void AddActivity(ActivityLogRecord record)
    {
        using var recordActivity = await telemetryService.StartActivity(TelemetryConstants.ActivityName.ActivityLogRecord);

        SetActivityTag(recordActivity, TelemetryConstants.TagName.ToolName, record.Tool);
        SetActivityTag(recordActivity, TelemetryConstants.TagName.ActivityType, record.ActivityType);
        SetActivityTag(recordActivity, TelemetryConstants.TagName.ActivityRequestSummary, record.RequestSummary);
        SetActivityTag(recordActivity, TelemetryConstants.TagName.ActivityAction, record.Action);
        SetActivityTag(recordActivity, TelemetryConstants.TagName.ActivityOutcome, record.Outcome);
        SetActivityTag(recordActivity, TelemetryConstants.TagName.ActivityOutcomeDetails, record.OutcomeDetails);
        SetActivityTag(recordActivity, TelemetryConstants.TagName.ReleasePlanId, record.ReleasePlanId);
        
        recordActivity.SetStatus(ActivityStatusCode.Ok);
        recordActivity.Dispose();
    }

    private static bool IsRecordEmpty(ActivityLogRecord record)
    {
        return string.IsNullOrWhiteSpace(record.Timestamp)
            && string.IsNullOrWhiteSpace(record.ActivityType)
            && string.IsNullOrWhiteSpace(record.RequestSummary)
            && string.IsNullOrWhiteSpace(record.Action)
            && string.IsNullOrWhiteSpace(record.Tool)
            && string.IsNullOrWhiteSpace(record.Outcome)
            && string.IsNullOrWhiteSpace(record.OutcomeDetails)
            && string.IsNullOrWhiteSpace(record.ReleasePlanId);
    }

    private static void SetActivityTag(Activity activity, string key, string? value)
    {
        if (!string.IsNullOrWhiteSpace(value))
        {
            activity.SetTag(key, value);
        }
    }
}
