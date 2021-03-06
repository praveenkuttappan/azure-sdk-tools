using Microsoft.Extensions.Logging;
using Microsoft.TeamFoundation.Build.WebApi;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace PipelineGenerator.Conventions
{
    public class PullRequestValidationPipelineConvention : PipelineConvention
    {
        public PullRequestValidationPipelineConvention(ILogger logger, PipelineGenerationContext context) : base(logger, context)
        {
        }

        protected override string GetDefinitionName(SdkComponent component)
        {
            return component.Variant == null ? $"{Context.Prefix} - {component.Name} - ci" : $"{Context.Prefix} - {component.Name} - ci.{component.Variant}";
        }

        public override string SearchPattern => "ci.yml";
        public override bool IsScheduled => false;
        public override bool RemoveCITriggers => true;

        protected override async Task<bool> ApplyConventionAsync(BuildDefinition definition, SdkComponent component)
        {
            // NOTE: Not happy with this code at all, I'm going to look for a reasonable
            // API that can do equality comparisons (without having to do all the checks myself).

            var hasChanges = await base.ApplyConventionAsync(definition, component);

            var prTrigger = definition.Triggers.OfType<PullRequestTrigger>().SingleOrDefault();

            if (prTrigger == null)
            {
                // TODO: We should probably be more complete here.
                definition.Triggers.Add(new PullRequestTrigger()
                {
                    SettingsSourceType = 2, // HACK: See above.
                    Forks = new Forks()
                    {
                        AllowSecrets = false,
                        Enabled = true
                    }
                });
                hasChanges = true;
            }
            else
            {
                // TODO: We should probably be more complete here.
                if (prTrigger.SettingsSourceType != 2 || prTrigger.Forks.AllowSecrets != false || prTrigger.Forks.Enabled != true)
                {
                    prTrigger.SettingsSourceType = 2;
                    prTrigger.Forks.AllowSecrets = false;
                    prTrigger.Forks.Enabled = true;
                    hasChanges = true;
                }
            }

            var ciTrigger = definition.Triggers.OfType<ContinuousIntegrationTrigger>().SingleOrDefault();

            if (ciTrigger == null)
            {
                definition.Triggers.Add(new ContinuousIntegrationTrigger()
                {
                    SettingsSourceType = 2
                });
                hasChanges = true;
            }
            else
            {
                if (ciTrigger.SettingsSourceType != 2)
                {
                    ciTrigger.SettingsSourceType = 2;
                    hasChanges = true;
                }
            }

            return hasChanges;
        }
    }
}
