// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
using System.Text.Json.Serialization;

namespace Azure.Sdk.Tools.Cli.Models;

public class ActivityLogRecord
{
    [JsonPropertyName("timestamp")]
    public string? Timestamp { get; set; }

    [JsonPropertyName("activityType")]
    public string? ActivityType { get; set; }

    [JsonPropertyName("requestSummary")]
    public string? RequestSummary { get; set; }

    [JsonPropertyName("action")]
    public string? Action { get; set; }

    [JsonPropertyName("tool")]
    public string? Tool { get; set; }

    [JsonPropertyName("outcome")]
    public string? Outcome { get; set; }

    [JsonPropertyName("outcomeDetails")]
    public string? OutcomeDetails { get; set; }

    [JsonPropertyName("releasePlanId")]
    public string? ReleasePlanId { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }
}
