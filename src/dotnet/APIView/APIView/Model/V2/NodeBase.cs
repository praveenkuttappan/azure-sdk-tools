using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace APIView.Model.V2
{
    public class NodeBase
    {
        public string Name { get; set; }
        public string DefinitionId { get; set; }
        public string CrossLanguageId { get; set; }
        public List<string> Annotations { get; set; } = new ();
        public List<CodeDiagnostic> Diagnostics { get; set; } = new();
        public List<string> Documentation { get; set; } = new ();
        public bool IsHidden { get; set; }
        public List<string> Modifiers { get; set; } = new ();
        public override string ToString()
        {
            return Name;
        }
    }
}
