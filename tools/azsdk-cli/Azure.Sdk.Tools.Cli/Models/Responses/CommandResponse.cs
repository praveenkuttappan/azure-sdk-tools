// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
using System.Text;
using System.Text.Json.Serialization;

namespace Azure.Sdk.Tools.Cli.Models;

public abstract class CommandResponse
{
    private int? exitCode = null;
    [JsonIgnore]
    public int ExitCode
    {
        get
        {
            if (null != exitCode) { return exitCode.Value; }
            if (!string.IsNullOrEmpty(ResponseError) || (ResponseErrors?.Count ?? 0) > 0)
            {
                return 1;
            }
            return 0;
        }
        set => exitCode = value;
    }

    /// <summary>
    /// ResponseError represents a single error message associated with the response.
    /// </summary>
    [JsonPropertyName("response_error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ResponseError { get; set; }

    /// <summary>
    /// ResponseErrors represents a list of error messages associated with the response.
    /// </summary>
    [JsonPropertyName("response_errors")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string> ResponseErrors { get; set; }

    /// <summary>
    /// NextSteps provides guidance or recommended actions regarding the response.
    /// </summary>
    [JsonPropertyName("next_steps")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? NextSteps { get; set; }

    /// <summary>
    /// Language indicates the SDK language context of the response, if applicable.    
    /// </summary>
    [JsonPropertyName("language")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string Language { get; set; } = "";

    /// <summary>
    /// Package provides the SDK package name in the context of the response, if applicable.    
    /// </summary>
    [JsonPropertyName("package")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string PackageName { get; set; } = "";

    /// <summary>
    /// TypeSpecProject represents the TypeSpec project name related to the response, if applicable.
    /// </summary>
    [JsonPropertyName("typeSpecProject")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string TypeSpecProject { get; set; } = "";

    /// <summary>
    /// SdkType indicates whether the tool call is for management plane or data plane, if applicable.    
    /// </summary>
    [JsonPropertyName("sdkType")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string SdkType { get; set; } = ""; //client or mgmt

    protected abstract string Format();

    public override string ToString()
    {
        var value = Format();

        List<string> messages = [];
        if (!string.IsNullOrEmpty(ResponseError))
        {
            messages.Add("[ERROR] " + ResponseError);
        }
        foreach (var error in ResponseErrors ?? [])
        {
            messages.Add("[ERROR] " + error);
        }

        if (NextSteps?.Count > 0)
        {
            messages.Add("[NEXT STEPS]");
            foreach (var step in NextSteps)
            {
                messages.Add(step);
            }
        }

        if (messages.Count > 0)
        {
            value = string.Join(Environment.NewLine, messages);
        }

        return value;
    }
}
