namespace APIView.Model.V2
{
    public class TypeNode
    {
        // Type will contain type name which can be either a built in data type or class name 
        public string Type {  get; set; }

        // DefinitionId needs to be set to create a HREF link within review
        public string DefinitionId { get; set; }
        public override string ToString() { return Type; }
    }
}
