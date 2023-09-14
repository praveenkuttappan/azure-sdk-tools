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
    public class CodeFileHtmlTreeRenderer
    {
        private bool _readOnly = false;
        protected CodeFileHtmlTreeRenderer(bool readOnly)
        {
            _readOnly = readOnly;
        }

        public static CodeFileHtmlTreeRenderer Normal { get; } = new CodeFileHtmlTreeRenderer(false);
        public static CodeFileHtmlTreeRenderer ReadOnly { get; } = new CodeFileHtmlTreeRenderer(true);

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
            var root = new CodeLine("Review Root", "", "");
            ///Review header lines
            foreach (var header in file.ReviewHeaders)
            {
                root.children.Add(new CodeLine("<span>" +header + "</span>", "", ""));
            }

            foreach (var node in file.Namespaces)
            {
                root.children.Add(RenderNamespace(node));
            }
            return root;
        }

        private CodeLine RenderNamespace(NamespaceNode node)
        {
            var nameRoot = new CodeLine("<span class=\"keyword\">namespace</span> <span class=\"commentable\">" + node.Name+"</span>", "", "");
            foreach (var cl in node.Classes)
            {
                nameRoot.children.Add(RenderClass(cl));
            }
            return nameRoot;
        }
        private CodeLine RenderClass(ClassNode node)
        {
            StringBuilder sb = new StringBuilder();
            if (!String.IsNullOrEmpty(node.AccessType))
            {
                sb.Append("<span class=\"keyword\">").Append(node.AccessType).Append("</span>").Append(' ');
            }

            sb.Append("<span class=\"keyword\">class</span>").Append(' ');
            sb.Append("<span class=\"class\">").Append(node.Name).Append("</span>");
            var clRoot = new CodeLine(sb.ToString(), "", "");

            foreach (var m in node.Methods)
            {
                clRoot.children.Add(RenderMethod(m));
            }
            return clRoot;
        }

        private CodeLine RenderMethod(MethodNode node)
        {
            StringBuilder sb = new StringBuilder();
            foreach (var s in node.Qualifiers)
            {
                sb.Append("<span class=\"keyword\">").Append(s).Append("</span>").Append(' ');
            }

            var returnType = node.ReturnType.ToString();
            if (!string.IsNullOrEmpty(returnType))
            {
                sb.Append("<span class=\"class commentable\">").Append(returnType).Append("</span>").Append(' ');
            }

            sb.Append("<span class=\"name commentable\">").Append(node.Name).Append("</span>").Append('(');
            bool notFirst = false;
            foreach (var p in node.Params)
            {
                if (notFirst)
                {
                    sb.Append(", ");
                }
                sb.Append("<span class=\"class commentable\">").Append(p.ParamType.ToString()).Append("</span>").Append(' ').Append(p.Name);
                notFirst = true;
            }
            sb.Append(')');
            return new CodeLine(sb.ToString(), "", "");
        }

    }
}
