// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
using System.Text;
using System.Text.Json.Serialization;

namespace Azure.Sdk.Tools.Cli.Models;

public class ActivityLogIngestionResponse : CommandResponse
{
    [JsonPropertyName("processed_records")]
    public int ProcessedRecords { get; set; }

    [JsonPropertyName("skipped_records")]
    public int SkippedRecords { get; set; }

    [JsonPropertyName("malformed_records")]
    public int MalformedRecords { get; set; }

    [JsonPropertyName("status_timestamp")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? StatusTimestamp { get; set; }

    [JsonPropertyName("status_path")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? StatusPath { get; set; }

    protected override string Format()
    {
        if (ProcessedRecords == 0 && SkippedRecords == 0 && MalformedRecords == 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        builder.AppendLine($"Processed records: {ProcessedRecords}");
        builder.AppendLine($"Skipped records: {SkippedRecords}");

        if (MalformedRecords > 0)
        {
            builder.AppendLine($"Malformed records: {MalformedRecords}");
        }

        if (!string.IsNullOrEmpty(StatusTimestamp))
        {
            builder.AppendLine($"Status marker written: {StatusTimestamp}");
        }

        return builder.ToString();
    }
}
