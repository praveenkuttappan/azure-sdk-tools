using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using ApiView;
using APIView.Model;
using APIView.Model.V2;
using Microsoft.Extensions.Primitives;

namespace APIView.Renderers
{
    // This class is used to render new hierarchical API review token 
    public class CodeFileTreeRenderer
    {
        public static CodeFileTreeRenderer Instance = new CodeFileTreeRenderer();

        public RenderResult Render(CodeFile file, bool showDocumentation = false, bool enableSkipDiff = false)
        {
            var sections = new Dictionary<int, TreeNode<CodeLine>>();
            var codeLine = RenderCodeFile(file);
            var result = new CodeLine[1];
            result[0] = codeLine;
            return new RenderResult(result, sections);
        }

        private CodeLine RenderCodeFile(CodeFile file)
        {
            var root = new CodeLine();
            ///Review header lines
            foreach(var header in file.ReviewHeaders)
            {
                root.children.Add(new CodeLine(header, "", ""));
            }

            foreach(var node in file.Namespaces)
            {
                root.children.Add(RenderNamespace(node));
            }
            return root;
        }

        private CodeLine RenderNamespace(NamespaceNode node)
        {
            var nameRoot = new CodeLine("namespace "+ node.Name,"", "");
            foreach(var cl in node.Classes)
            {
                nameRoot.children.Add(RenderClass(cl));
            }
            return nameRoot;
        }
        private CodeLine RenderClass(ClassNode node)
        {            
            StringBuilder sb = new StringBuilder();
            if(!String.IsNullOrEmpty(node.AccessType))
            {
                sb.Append(node.AccessType).Append(' ');
            }
            
            sb.Append("class ").Append(node.Name);
            var clRoot = new CodeLine(sb.ToString(), "", "");

            foreach(var m in node.Methods)
            {
                clRoot.children.Add(RenderMethod(m));
            }
            return clRoot;
        }

        private CodeLine RenderMethod(MethodNode node)
        {
            StringBuilder sb = new StringBuilder();
            foreach(var s in node.Qualifiers)
            {
                sb.Append(s).Append(' ');
            }

            var returnType = node.ReturnType.ToString();
            if(!string.IsNullOrEmpty(returnType))
            {
                sb.Append(returnType).Append(' ');
            }
            
            sb.Append(node.Name).Append('(');
            foreach (var p in node.Params)
            {
                sb.Append(p.ParamType.ToString()).Append(' ').Append(p.Name);
            }
            sb.Append('(');
            return new CodeLine(sb.ToString(), "", "");
        }

        private string EscapeHTML(string word)
        {
            return word.Replace("<", "&lt;").Replace(">", "&gt;");
        }
    }
}
