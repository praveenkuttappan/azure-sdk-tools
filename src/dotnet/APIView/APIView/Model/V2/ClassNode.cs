using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace APIView.Model.V2
{
    public class ClassNode: NodeBase
    {
        public List<BaseClassInfo> BaseClasses = new ();
        public string AccessType { get; set; }
        public List<MethodNode> Methods = new ();
        public string TypeName { get; set; }
    }
}
