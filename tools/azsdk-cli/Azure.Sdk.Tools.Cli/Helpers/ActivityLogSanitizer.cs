// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
using System.ComponentModel;
using System.Text.Json;
using System.Text.RegularExpressions;
using Azure.Sdk.Tools.Cli.CopilotAgents;
using Azure.Sdk.Tools.Cli.Models;
using Microsoft.Extensions.Logging;

namespace Azure.Sdk.Tools.Cli.Helpers;

public interface IActivityLogSanitizer
{
    Task<List<ActivityLogRecord>> SanitizeAsync(IEnumerable<ActivityLogRecord> records, CancellationToken ct = default);
}

public class ActivityLogSanitizer(
    ILogger<ActivityLogSanitizer> logger,
    ICopilotAgentRunner copilotAgentRunner) : IActivityLogSanitizer
{
    private static readonly string[] RelevanceKeywords =
    [
        "typespec",
        "package",
        "sdk",
        "release",
        "api spec",
        "apispec",
        "customization",
        "api view",
        "apiview"
    ];

    private static readonly Regex EmailRegex = new("[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex PhoneRegex = new("(?:\\+?\\d{1,3}[\\s-]?)?(?:\\(\\d{3}\\)|\\d{3})[\\s-]?\\d{3}[\\s-]?\\d{4}", RegexOptions.Compiled);
    private static readonly Regex PathRegex = new("[A-Za-z]:\\\\\\S+|\\\\\\w+\\\\\\S+", RegexOptions.Compiled);
    private static readonly Regex GuidRegex = new("[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = true
    };

    public async Task<List<ActivityLogRecord>> SanitizeAsync(IEnumerable<ActivityLogRecord> records, CancellationToken ct = default)
    {
        var sanitized = new List<ActivityLogRecord>();
        foreach (var record in records)
        {
            ct.ThrowIfCancellationRequested();

            if (record == null || !IsRelevant(record))
            {
                continue;
            }

            var (heuristicRecord, changed) = SanitizeFields(record);
            if (changed)
            {
                logger.LogInformation("Heuristic sanitization redacted potential PII from record at {Timestamp} of type {ActivityType}", record.Timestamp, record.ActivityType);
            }
            if (NeedsCopilotRedaction(heuristicRecord))
            {
                var redactedRecord = await RunCopilotRedactionAsync(heuristicRecord, ct);
                if (redactedRecord != null)
                {
                    heuristicRecord = redactedRecord;
                }
            }
            sanitized.Add(heuristicRecord);
        }

        return sanitized;
    }

    private static bool IsRelevant(ActivityLogRecord record)
    {
        var buffer = string.Join(' ', new[]
        {
            record.ActivityType,
            record.RequestSummary,
            record.Action,
            record.Outcome,
            record.OutcomeDetails,
            record.Tool
        }.Where(v => !string.IsNullOrWhiteSpace(v)));

        if (string.IsNullOrWhiteSpace(buffer))
        {
            return false;
        }

        var lower = buffer.ToLowerInvariant();
        return RelevanceKeywords.Any(keyword => lower.Contains(keyword, StringComparison.Ordinal));
    }

    private static (ActivityLogRecord Record, bool Redacted) SanitizeFields(ActivityLogRecord record)
    {
        bool redacted = false;
        var sanitized = new ActivityLogRecord
        {
            Timestamp = record.Timestamp,
            ActivityType = record.ActivityType,
            RequestSummary = Redact(record.RequestSummary, ref redacted),
            Action = Redact(record.Action, ref redacted),
            Tool = Redact(record.Tool, ref redacted),
            Outcome = Redact(record.Outcome, ref redacted),
            OutcomeDetails = Redact(record.OutcomeDetails, ref redacted),
            ReleasePlanId = Redact(record.ReleasePlanId, ref redacted),
            Status = record.Status
        };

        return (sanitized, redacted);
    }

    private static string? Redact(string? value, ref bool redacted)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return value;
        }

        var sanitized = EmailRegex.Replace(value, "[REDACTED-EMAIL]");
        sanitized = PhoneRegex.Replace(sanitized, "[REDACTED-PHONE]");
        sanitized = GuidRegex.Replace(sanitized, "[REDACTED-ID]");
        sanitized = PathRegex.Replace(sanitized, "[REDACTED-PATH]");

        if (!string.Equals(value, sanitized, StringComparison.Ordinal))
        {
            redacted = true;
        }

        return sanitized;
    }

    private static bool NeedsCopilotRedaction(ActivityLogRecord record)
    {
        return ContainsPotentialPii(record.RequestSummary)
            || ContainsPotentialPii(record.Action)
            || ContainsPotentialPii(record.Outcome)
            || ContainsPotentialPii(record.OutcomeDetails)
            || ContainsPotentialPii(record.Tool);
    }

    private static bool ContainsPotentialPii(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        return EmailRegex.IsMatch(value)
            || PhoneRegex.IsMatch(value)
            || GuidRegex.IsMatch(value)
            || PathRegex.IsMatch(value);
    }

    private async Task<ActivityLogRecord?> RunCopilotRedactionAsync(ActivityLogRecord record, CancellationToken ct)
    {
        try
        {
            var payload = JsonSerializer.Serialize(record, SerializerOptions);
            var agent = new CopilotAgent<ActivityLogRedactionResult>
            {
                Instructions = $$"""
You are a security reviewer sanitizing telemetry logs. Remove or mask any personally identifiable information (PII), machine-specific paths, user aliases, email addresses, phone numbers, authentication tokens, or other secrets from the JSON record below. Replace removed values with "[REDACTED]" while preserving key technical context (TypeSpec, SDK/package names, release identifiers, API spec references). Always return valid JSON that matches the provided schema via the Record property.

JSON to sanitize:
{payload}
""",
                MaxIterations = 5
            };

            var result = await copilotAgentRunner.RunAsync(agent, ct);
            return result?.Record ?? record;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Copilot-based activity log sanitization failed; using heuristic redaction only");
            return record;
        }
    }

    private sealed record ActivityLogRedactionResult(
        [property: Description("Sanitized activity log record")]
        ActivityLogRecord Record
    );
}
