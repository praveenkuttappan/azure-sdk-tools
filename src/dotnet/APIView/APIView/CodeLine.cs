using System;
using System.Collections.Generic;
using APIView.Model;

namespace ApiView
{
    public readonly struct CodeLine: IEquatable<CodeLine>
    {
        public string DisplayString { get; }
        public string ElementId { get; }
        public string LineClass { get; }
        public int? LineNumber { get; }
        public int? SectionKey { get; }
        public int Indent { get; }
        public bool IsDocumentation { get; }
        public TreeNode<CodeLine> NodeRef { get; }
        public bool IsHiddenApi { get; }
        public List<CodeLine> children { get; } = new List<CodeLine> ();

        public CodeLine(string html, string id, string lineClass, int? lineNumber = null, int? sectionKey = null, int indent = 0, bool isDocumentation = false, TreeNode<CodeLine> nodeRef = null, bool isHiddenApi = false)
        {
            this.DisplayString = html;
            this.ElementId = id;
            this.LineClass = lineClass;
            this.LineNumber = lineNumber;
            this.SectionKey = sectionKey;
            this.Indent = indent;
            this.IsDocumentation = isDocumentation;
            this.NodeRef = nodeRef;
            this.IsHiddenApi = isHiddenApi;
            this.children = new List<CodeLine> ();
        }

        public CodeLine(CodeLine codeLine, string html = null, string id = null, string lineClass = null, int? lineNumber = null, int? sectionKey = null, int indent = 0, bool isDocumentation = false, TreeNode<CodeLine> nodeRef = null, bool isHiddenApi = false)
        {
            this.DisplayString = html ?? codeLine.DisplayString;
            this.ElementId = id ?? codeLine.ElementId;
            this.LineClass = lineClass ?? codeLine.LineClass;
            this.LineNumber = lineNumber ?? codeLine.LineNumber;
            this.SectionKey = sectionKey ?? codeLine.SectionKey;
            this.Indent = (indent != 0)? indent : codeLine.Indent;
            this.IsDocumentation = (isDocumentation != false)? isDocumentation : codeLine.IsDocumentation;
            this.NodeRef = nodeRef ?? codeLine.NodeRef;
            this.IsHiddenApi = isHiddenApi;
            this.children = new List<CodeLine>();
        }

        public override string ToString()
        {
            return DisplayString + " [" + ElementId + "]";
        }

        public bool Equals(CodeLine other)
        {
            bool isEquals = DisplayString == other.DisplayString && other.IsHiddenApi == IsHiddenApi;
            if(isEquals && children.Count == other.children.Count)
            {
                for (int i = 0; i < children.Count; i++)
                {
                    if (!children[i].Equals(other.children[i]))
                        return false;
                }
                return true;
            }
            return false;
        }
    }
}
