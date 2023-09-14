using System.Collections.Generic;

namespace APIView.Model.V2
{
    public class MethodNode: NodeBase
    {
        public List<string> Qualifiers { get; set; } = new ();
        public TypeNode ReturnType { get; set; }

        //Default value will be required for C++ pure virtual functions
        public string DefaultValue { get; set; }

        public List<ParamNode> Params { get; set; } = new ();
    }
}
