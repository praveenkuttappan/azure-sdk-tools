using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using ApiView;
using APIView.Model.V2;

namespace APIView.Model.V2
{
    public class NamespaceNode: NodeBase
    {
        public List<ClassNode> Classes = new();        
    }
}
