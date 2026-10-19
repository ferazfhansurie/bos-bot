// Editor schema pieces for pages: stable block ids, the highlight (callout)
// block, images that resolve page assets, the slash trigger, and the
// decorations for comments and attribution.
import { Extension, Node, mergeAttributes, type Editor, type Range } from "@tiptap/core";
import { Image } from "@tiptap/extension-image";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";

import { newBlockId, type PageAttribution, type PageComment } from "../../../shared/page";
import { BLOCK_NODE_TYPES } from "./page-doc";

/** Gives every block node an id and repairs duplicates (a split paragraph copies its attrs). */
export const BlockIds = Extension.create({
  name: "blockIds",
  addGlobalAttributes() {
    return [{
      types: BLOCK_NODE_TYPES,
      attributes: {
        blockId: {
          default: null,
          keepOnSplit: false,
          parseHTML: element => element.getAttribute("data-block-id"),
          renderHTML: attributes => attributes.blockId ? { "data-block-id": attributes.blockId } : {},
        },
      },
    }];
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey("blockIds"),
      appendTransaction: (transactions, _old, state) => {
        if (!transactions.some(tr => tr.docChanged)) return null;
        const seen = new Set<string>();
        const tr = state.tr;
        state.doc.descendants((node, pos) => {
          if (!BLOCK_NODE_TYPES.includes(node.type.name)) return;
          const id = node.attrs.blockId as string | null;
          if (id && !seen.has(id)) { seen.add(id); return; }
          const fresh = newBlockId();
          seen.add(fresh);
          tr.setNodeAttribute(pos, "blockId", fresh);
        });
        return tr.steps.length ? tr.setMeta("addToHistory", false) : null;
      },
    })];
  },
});

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "inline*",
  defining: true,
  addAttributes() {
    return { emoji: { default: "💡", parseHTML: el => el.getAttribute("data-emoji") ?? "💡", renderHTML: a => ({ "data-emoji": a.emoji }) } };
  },
  parseHTML() { return [{ tag: "div[data-type=callout]" }]; },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "callout", class: "page-callout" }),
      ["span", { class: "page-callout-emoji", contenteditable: "false" }, String(node.attrs.emoji)],
      ["div", { class: "page-callout-body" }, 0]];
  },
  addKeyboardShortcuts() {
    return {
      // an empty highlight turns back into text, like a list item
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parent.type.name !== this.name || $from.parentOffset > 0) return false;
        return editor.commands.setNode("paragraph");
      },
    };
  },
});

/** Images keep their stored src (asset:… or https) and show it through `resolve`. */
export function pageImage(resolve: () => (src: string) => string) {
  return Image.extend({
    parseHTML() { return [{ tag: "img[src]", getAttrs: el => ({ src: (el as HTMLElement).getAttribute("data-src") ?? (el as HTMLElement).getAttribute("src") }) }]; },
    renderHTML({ HTMLAttributes }) {
      const src = String(HTMLAttributes.src ?? "");
      return ["img", mergeAttributes(HTMLAttributes, { src: resolve()(src), "data-src": src, class: "page-image", draggable: "false" })];
    },
  }).configure({ allowBase64: false });
}

export interface SlashState { items: SlashItem[]; query: string; rect: DOMRect | null; range: Range; selected: number }
export interface SlashItem {
  id: string; label: string; description: string; section: "Create" | "Generate" | "Basic" | "Media";
  keywords: string; shortcut?: string; run: (editor: Editor, range: Range) => void;
}

/** The "/" trigger. The menu itself is React; this only reports state and keys. */
export function slashCommands(options: {
  items: (query: string) => SlashItem[];
  onState: (state: SlashState | null) => void;
  onKey: (event: KeyboardEvent) => boolean;
}) {
  return Extension.create({
    name: "slashCommands",
    addProseMirrorPlugins() {
      return [Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        char: "/",
        pluginKey: new PluginKey("pageSlash"),
        allowSpaces: false,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          return !["codeBlock"].includes($from.parent.type.name);
        },
        items: ({ query }) => options.items(query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          const report = (props: SuggestionProps<SlashItem, SlashItem>) =>
            options.onState({ items: props.items, query: props.query, rect: props.clientRect?.() ?? null, range: props.range, selected: 0 });
          return {
            onStart: report,
            onUpdate: report,
            onExit: () => options.onState(null),
            onKeyDown: ({ event }: SuggestionKeyDownProps) => options.onKey(event),
          };
        },
      })];
    },
  });
}

export const pageMarksKey = new PluginKey<DecorationSet>("pageMarks");
export interface PageMarksState { comments: PageComment[]; attribution: Record<string, PageAttribution> | null; activeComment: string | null }

/** Where a comment's quote sits inside its block, if it is still there. */
export function findQuote(doc: PMNode, comment: PageComment): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs.blockId !== comment.blockId) return;
    let text = "", map: number[] = [];
    node.descendants((child, childPos) => {
      if (child.isText) for (let k = 0; k < child.text!.length; k++) { text += child.text![k]; map.push(pos + 1 + childPos + k); }
    });
    const at = comment.quote ? text.indexOf(comment.quote) : -1;
    found = at >= 0 ? { from: map[at]!, to: map[at + comment.quote.length - 1]! + 1 }
      : { from: pos, to: pos + node.nodeSize };
    return false;
  });
  return found;
}

function marksDecorations(state: EditorState, marks: PageMarksState): DecorationSet {
  const decorations: Decoration[] = [];
  for (const comment of marks.comments) {
    if (comment.resolved) continue;
    const range = findQuote(state.doc, comment);
    if (!range || !comment.quote) continue;
    decorations.push(Decoration.inline(range.from, range.to, {
      class: `page-comment-mark${marks.activeComment === comment.id ? " is-active" : ""}`,
      "data-comment-id": comment.id,
    }));
  }
  if (marks.attribution) {
    state.doc.descendants((node, pos) => {
      const id = node.attrs.blockId as string | null;
      if (!id || node.type.name === "paragraph" && state.doc.resolve(pos).parent.type.name !== "doc" && state.doc.resolve(pos).parent.type.name !== "blockquote") return;
      const who = marks.attribution![id];
      if (!who) return;
      decorations.push(Decoration.node(pos, pos + node.nodeSize, {
        class: `page-attributed ${who.author.kind === "bot" ? "is-bot" : "is-human"}`,
        "data-attribution": `${who.author.name} · ${new Date(who.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
      }));
    });
  }
  return DecorationSet.create(state.doc, decorations);
}

/** Comment highlights and the attribution overlay; fed through transaction meta. */
export const PageMarks = Extension.create({
  name: "pageMarks",
  addProseMirrorPlugins() {
    let current: PageMarksState = { comments: [], attribution: null, activeComment: null };
    return [new Plugin<DecorationSet>({
      key: pageMarksKey,
      state: {
        init: (_config, state) => marksDecorations(state, current),
        apply: (tr, set, _old, state) => {
          const next = tr.getMeta(pageMarksKey) as PageMarksState | undefined;
          if (next) { current = next; return marksDecorations(state, current); }
          return tr.docChanged ? marksDecorations(state, current) : set;
        },
      },
      props: { decorations: state => pageMarksKey.getState(state) },
    })];
  },
});
