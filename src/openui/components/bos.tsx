// Components bos adds on top of the vendored set: a stat tile and a callout,
// the two shapes bots reach for most in a data answer.
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod/v4";
import { Glyph } from "./glyph";
import { inline } from "./markdown";
import { cx } from "./style";

const str = (value: unknown) => (value == null ? "" : String(value));
const shown = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : str(value);

export const Stat = defineComponent({
  name: "Stat",
  props: z.object({
    label: z.string(),
    value: z.union([z.string(), z.number()]),
    change: z.number().optional(),
    hint: z.string().optional(),
  }),
  description: "KPI tile. change is a percent (12 shows ▲ 12%); put several in a Grid.",
  component: ({ props }) => {
    const change = typeof props.change === "number" && Number.isFinite(props.change) ? props.change : null;
    return (
      <div className="iui-stat">
        <span className="iui-stat-label">{str(props.label)}</span>
        <span className="iui-stat-value">{shown(props.value)}</span>
        {change !== null || props.hint ? (
          <span className="iui-stat-foot">
            {change !== null ? (
              <span className={cx("iui-stat-change", change > 0 && "is-up", change < 0 && "is-down")}>
                {change > 0 ? "▲" : change < 0 ? "▼" : "–"} {Math.abs(change).toLocaleString("en-US", { maximumFractionDigits: 1 })}%
              </span>
            ) : null}
            {props.hint ? <span>{inline(str(props.hint))}</span> : null}
          </span>
        ) : null}
      </div>
    );
  },
});

const TONE_ICON: Record<string, string> = { info: "info", success: "check-circle", warning: "alert-triangle", danger: "alert-triangle" };

export const Callout = defineComponent({
  name: "Callout",
  props: z.object({
    text: z.string(),
    tone: z.enum(["info", "success", "warning", "danger"]).optional(),
    title: z.string().optional(),
  }),
  description: "Highlighted note: a takeaway, a warning or a next step.",
  component: ({ props }) => {
    const tone = props.tone ?? "info";
    return (
      <div className={`iui-callout iui-callout-${tone}`} role={tone === "danger" || tone === "warning" ? "alert" : "note"}>
        <Glyph name={TONE_ICON[tone]} size={16} className="iui-callout-icon" />
        <div>
          {props.title ? <div className="iui-callout-title">{inline(str(props.title))}</div> : null}
          <div>{inline(str(props.text))}</div>
        </div>
      </div>
    );
  },
});
