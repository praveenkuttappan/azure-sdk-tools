namespace APIView.Model.V2
{
    public class ParamNode : NodeBase
    {
        public TypeNode ParamType { get; set; }
        public string DefaultValue { get; set; }
    }
}
