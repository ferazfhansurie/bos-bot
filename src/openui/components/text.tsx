import { defineComponent } from "@openuidev/react-lang";
import { ArrowUpRight } from "lucide-react";
import { Fragment } from "react";
import { z } from "zod/v4";
import { inline } from "./markdown";
import { children, color, cx, fg, webUrl } from "./style";

const str = (value: unknown) => (value == null ? "" : String(value));
const HEADING_LEVEL: Record<string, number> = { "3xl": 1, "2xl": 2, xl: 2, lg: 2, md: 3, sm: 4 };

export const Title = defineComponent({
  name: "Title",
  props: z.object({
    text: z.string(),
    size: z.enum(["sm", "md", "lg", "xl", "2xl", "3xl"]).optional(),
    color: color.optional(),
  }),
  description: "Heading; md for a card title, lg for a section, 2xl for a big number.",
  component: ({ props }) => {
    const sizeName = props.size ?? "md";
    return (
      <div role="heading" aria-level={HEADING_LEVEL[sizeName] ?? 3} className={`iui-title iui-title-${sizeName}`} style={{ color: fg(props.color) }}>
        {inline(str(props.text))}
      </div>
    );
  },
});

/** Text, or a run of strings and inline components such as Icon, Badge, Link or Math. */
const richText = z.union([z.string(), children]);
const isNode = (value: unknown) => !!value && typeof value === "object" && (value as { type?: unknown }).type === "element";

export const Text = defineComponent({
  name: "Text",
  props: z.object({
    text: richText,
    size: z.enum(["xs", "sm", "md", "lg"]).optional(),
    color: color.optional(),
    weight: z.enum(["normal", "medium", "semibold"]).optional(),
  }),
  description: 'Paragraph with **bold**, *italic*, `code`, [links](https://…). text may mix strings and inline components: ["Stage ", Badge("won", "success")].',
  component: ({ props, renderNode }) => {
    return (
      <p
        className={cx("iui-text", props.size && `iui-text-${props.size}`, props.weight && `iui-weight-${props.weight}`)}
        style={{ color: fg(props.color) }}
      >
        {Array.isArray(props.text)
          ? (props.text as unknown[]).flat().map((part, i) =>
              isNode(part) ? <span key={i} className="iui-inline">{renderNode(part)}</span> : <Fragment key={i}>{inline(str(part), `t${i}`)}</Fragment>,
            )
          : inline(str(props.text))}
      </p>
    );
  },
});

export const Caption = defineComponent({
  name: "Caption",
  props: z.object({ text: z.string(), color: color.optional() }),
  description: "Small secondary text.",
  component: ({ props }) => (
    <p className="iui-caption" style={{ color: fg(props.color) }}>
      {inline(str(props.text))}
    </p>
  ),
});

export const Badge = defineComponent({
  name: "Badge",
  props: z.object({
    text: z.string(),
    color: z.enum(["neutral", "info", "success", "warning", "danger", "purple", "pink"]).optional(),
  }),
  description: "Pill tag, e.g. a status.",
  component: ({ props }) => (
    <span className={`iui-badge iui-badge-${props.color ?? "neutral"}`}>
      {str(props.text)}
    </span>
  ),
});

export const Link = defineComponent({
  name: "Link",
  props: z.object({ text: z.string(), url: z.string() }),
  description: "Opens an http(s) URL in a new tab.",
  component: ({ props }) => {
    const href = webUrl(props.url);
    if (!href) return <span>{str(props.text)}</span>;
    return (
      <a className="iui-link" href={href} target="_blank" rel="noopener noreferrer">
        {str(props.text) || new URL(href).hostname}
        <ArrowUpRight aria-hidden className="iui-link-arrow" />
      </a>
    );
  },
});

type ItemElement = { type: "element"; typeName: string; props: Record<string, unknown> };
const isItem = (value: unknown): value is ItemElement =>
  !!value && typeof value === "object" && (value as ItemElement).type === "element" && (value as ItemElement).typeName === "ListItem";

export const ListItem = defineComponent({
  name: "ListItem",
  props: z.object({
    title: z.string(),
    description: z.string().optional(),
    marker: z.string().optional(),
    children: children.optional(),
  }),
  description: "marker replaces the bullet or number, e.g. a time.",
  // Rendered by List; on its own it shows its content.
  component: ({ props, renderNode }) => (
    <div className="iui-list-body">
      <div className="iui-list-title">{inline(str(props.title))}</div>
      {props.description ? <div className="iui-list-description">{inline(str(props.description))}</div> : null}
      {props.children ? <div className="iui-list-children">{renderNode(props.children)}</div> : null}
    </div>
  ),
});

export const List = defineComponent({
  name: "List",
  props: z.object({
    items: z.array(z.union([z.string(), ListItem.ref])),
    marker: z.enum(["bullet", "number", "none"]).optional(),
    timeline: z.boolean().optional(),
  }),
  description: "timeline joins the markers with a line.",
  component: ({ props, renderNode }) => {
    const items = (Array.isArray(props.items) ? props.items.flat() : []) as unknown[];
    const marker = props.marker ?? "bullet";
    const textMarkers = items.some((item) => isItem(item) && typeof item.props.marker === "string" && item.props.marker.length > 2);
    const Tag = marker === "number" ? "ol" : "ul";
    return (
      <Tag className={cx("iui-list", `iui-list-${marker}`, props.timeline && "iui-timeline", textMarkers && "iui-list-wide")}>
        {items.map((item, i) => {
          if (item == null) return null;
          const custom = isItem(item) && typeof item.props.marker === "string" && item.props.marker ? item.props.marker : null;
          const step = !!custom && /^[0-9A-Za-z]{1,2}$/.test(custom);
          const rich = isItem(item) && (!!item.props.description || !!item.props.children);
          return (
            <li key={i} className={cx(rich && "iui-list-rich")}>
              <span className={cx("iui-list-marker", custom && (step ? "iui-list-marker-chip" : "iui-list-marker-text"))} aria-hidden={!custom}>
                {step ? <span>{custom}</span> : custom ?? (marker === "number" ? i + 1 : null)}
              </span>
              {isItem(item) ? renderNode(item) : <div className="iui-list-body">{inline(str(item))}</div>}
            </li>
          );
        })}
      </Tag>
    );
  },
});

