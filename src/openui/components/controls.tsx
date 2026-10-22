import {
  action,
  defineComponent,
  reactive,
  useFormName,
  useIsStreaming,
  useStateField,
  useTriggerAction,
} from "@openuidev/react-lang";
import { useId, useState, type ReactNode } from "react";
import { z } from "zod/v4";
import { cx, option, toOption, type Option } from "./style";

type Plan = Parameters<ReturnType<typeof useTriggerAction>>[2];

/** Runs an action prop. With no action, a button sends its label to the assistant. */
function useRunAction() {
  const trigger = useTriggerAction();
  const formName = useFormName();
  return (message: string, plan: unknown, sendLabel: boolean) => {
    if (plan) void trigger(message, formName, plan as Plan);
    else if (sendLabel) void trigger(message, formName);
  };
}

/** The state key of a control: its label, its statement name, or a generated id. */
function useFieldName(label: unknown, statementId?: string) {
  const id = useId();
  return (typeof label === "string" && label) || statementId || id;
}

function Field({ label, children: content }: { label?: string; children: ReactNode }) {
  if (!label) return <>{content}</>;
  return (
    <label className="iui-field">
      <span className="iui-label">{label}</span>
      {content}
    </label>
  );
}

// Actions
export const Button = defineComponent({
  name: "Button",
  props: z.object({
    label: z.string(),
    action: action().optional(),
    variant: z.enum(["solid", "outline", "soft", "ghost"]).optional(),
    color: z.enum(["primary", "danger", "success"]).optional(),
    size: z.enum(["sm", "md", "lg"]).optional(),
    disabled: z.boolean().optional(),
  }),
  description: "",
  component: ({ props }) => {
    const run = useRunAction();
    const streaming = useIsStreaming();
    const label = String(props.label ?? "");
    return (
      <button
        type="button"
        className={cx(
          "iui-button",
          `iui-button-${props.variant ?? "solid"}`,
          props.color && props.color !== "primary" && `iui-button-${props.color}`,
          `iui-button-${props.size ?? "md"}`,
        )}
        disabled={!!props.disabled || streaming}
        onClick={() => run(label, props.action, true)}
      >
        {label}
      </button>
    );
  },
});

export const Input = defineComponent({
  name: "Input",
  props: z.object({
    value: reactive(z.union([z.string(), z.number()])),
    label: z.string().optional(),
    type: z.enum(["text", "number"]).optional(),
    placeholder: z.string().optional(),
  }),
  description: "Text or number field; a number field stores numbers.",
  component: function InputView({ props, statementId }) {
    const field = useStateField(useFieldName(props.label, statementId), props.value);
    const numeric = props.type === "number";
    // A number field shows what is typed ("1." or "-") until it parses.
    const [draft, setDraft] = useState<string | null>(null);
    const shown = draft ?? (numeric ? (typeof field.value === "number" ? String(field.value) : String(field.value ?? "")) : String(field.value ?? ""));
    return (
      <Field label={props.label}>
        <input
          className="iui-input"
          type="text"
          inputMode={numeric ? "decimal" : undefined}
          value={shown}
          placeholder={props.placeholder}
          aria-label={props.label ? undefined : props.placeholder}
          onChange={(event) => {
            const text = event.target.value;
            if (!numeric) return field.setValue(text);
            setDraft(text);
            const parsed = Number(text.replace(/,/g, ""));
            if (text.trim() === "") field.setValue(null as unknown as number);
            else if (Number.isFinite(parsed)) field.setValue(parsed);
          }}
          onBlur={() => setDraft(null)}
        />
      </Field>
    );
  },
});

const options = z.array(option);
const optionList = (value: unknown) => (Array.isArray(value) ? (value.flat() as Option[]).filter((o) => o != null).map(toOption) : []);

export const Select = defineComponent({
  name: "Select",
  props: z.object({
    value: reactive(z.string()),
    options,
    label: z.string().optional(),
    placeholder: z.string().optional(),
  }),
  description: "Dropdown, for long option lists.",
  component: ({ props, statementId }) => {
    const field = useStateField(useFieldName(props.label, statementId), props.value);
    const choices = optionList(props.options);
    const value = field.value == null ? "" : String(field.value);
    return (
      <Field label={props.label}>
        <select className="iui-input iui-select" value={value} aria-label={props.label ? undefined : props.placeholder} onChange={(event) => field.setValue(event.target.value)}>
          {(props.placeholder || !choices.some((o) => o.value === value)) && (
            <option value="" disabled>
              {props.placeholder ?? "Choose…"}
            </option>
          )}
          {choices.map((o, i) => (
            <option key={`${o.value}-${i}`} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
    );
  },
});

export const SegmentedControl = defineComponent({
  name: "SegmentedControl",
  props: z.object({ value: reactive(z.string()), options, block: z.boolean().optional() }),
  description: "2 to 4 short choices in a row.",
  component: function SegmentedView({ props, statementId }) {
    const field = useStateField(useFieldName(undefined, statementId), props.value);
    const value = field.value == null ? "" : String(field.value);
    return (
      <div className={cx("iui-segmented", props.block && "iui-block")} role="radiogroup">
        {optionList(props.options).map((o, i) => (
          <button
            key={`${o.value}-${i}`}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            className={cx(o.value === value && "is-selected")}
            onClick={() => field.setValue(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  },
});

export const Checkbox = defineComponent({
  name: "Checkbox",
  props: z.object({ checked: reactive(z.boolean()), label: z.string(), lineThrough: z.boolean().optional() }),
  description: "lineThrough strikes the label when checked, for to-do lists.",
  component: ({ props, statementId }) => {
    const field = useStateField(useFieldName(props.label, statementId), props.checked);
    const checked = field.value === true;
    return (
      <label className={cx("iui-check", checked && props.lineThrough && "is-done")}>
        <input type="checkbox" checked={checked} onChange={(event) => field.setValue(event.target.checked)} />
        <span>{String(props.label ?? "")}</span>
      </label>
    );
  },
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const DatePicker = defineComponent({
  name: "DatePicker",
  props: z.object({
    value: reactive(z.string()),
    label: z.string().optional(),
    min: z.string().optional(),
    max: z.string().optional(),
  }),
  description: 'Dates are "YYYY-MM-DD".',
  component: ({ props, statementId }) => {
    const field = useStateField(useFieldName(props.label, statementId), props.value);
    const value = typeof field.value === "string" && DATE.test(field.value) ? field.value : "";
    return (
      <Field label={props.label}>
        <input
          className="iui-input iui-date"
          type="date"
          value={value}
          min={props.min && DATE.test(props.min) ? props.min : undefined}
          max={props.max && DATE.test(props.max) ? props.max : undefined}
          aria-label={props.label ? undefined : "Date"}
          onChange={(event) => field.setValue(event.target.value)}
        />
      </Field>
    );
  },
});

