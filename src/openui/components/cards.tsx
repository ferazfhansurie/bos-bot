// bos bot 3.0 cards: the shapes a bot answers with when it is doing, not
// talking (a lead, a go-ahead, a pick, a receipt, a draft). The signatures
// are frozen in shared/card-guide.ts and ios draws the same json, so prop
// names, order and enums stay exactly as listed there. Only the v3 library
// (library-v3.ts) carries these; the base library and its prompt don't.
//
// Every button posts a message to the assistant as if the person typed it.
// A tapped card settles: its choice is kept in the block's state (so a
// remount or a reload still shows it) and its buttons stop sending.
import { defineComponent, useGetFieldValue, useIsStreaming, useSetFieldValue, useTriggerAction } from "@openuidev/react-lang";
import {
  ArrowRight, Check, Code2, File, FileImage, FileSpreadsheet, FileText, Globe, Mail, MessageCircle,
  MessageSquare, Megaphone, Presentation, Repeat, Smartphone, X, type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { z } from "zod/v4";
import { Button } from "./controls";
import { inline } from "./markdown";
import { cx, webUrl } from "./style";
import { actOnCheckin, useCheckins } from "../../lib/checkins";
import type { CheckinAction, CheckinItem } from "../../../shared/checkins";

const str = (value: unknown) => (value == null ? "" : String(value)).trim();
const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value.flat() as T[]).filter((v) => v != null) : []);
const scalar = z.union([z.string(), z.number(), z.boolean()]);

type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "purple" | "pink";
const Pill = ({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) => (
  <span className={`iui-badge iui-badge-${tone}`}>{children}</span>
);

/** What each card button says when the bot gave no exact words. */
export const cardMessage = {
  approve: (title: string, message?: string) => str(message) || `yes, go ahead: ${title}`,
  reject: (title: string, message?: string) => str(message) || `no, don't: ${title}`,
  choices: (picked: string[]) => picked.join(", "),
  schedule: (title: string, when: string) => `turn on: ${title}${when ? ` (${when})` : ""}`,
  setting: (setting: string, from: string, to: string, message?: string) =>
    str(message) || `change ${setting} from ${from || "not set"} to ${to || "not set"}`,
  open: (name: string) => `open ${name}`,
  pick: (name: string) => `go with ${name}`,
  send: (channel: string, to: string, message?: string) => str(message) || `send this ${channel} to ${to}`,
  /** The person changed the words in the card: the bot sends exactly these. */
  sendEdited: (channel: string, to: string, text: string) =>
    `send this ${channel} to ${to}, exactly as i edited it:\n\n${text.trim()}`,
};

// Rise-in. The chat remounts a block on every streamed chunk (react-markdown
// rebuilds its components), so a plain mount animation would restart each
// time. A card that mounts while streaming rises once: a remount inside the
// same 160ms carries on from where it was, and a later one, or any mount of
// a settled block (history, a reload), draws still.
const RISE_MS = 160;
const risen = new Map<string, { first: number; last: number }>();
function useRise(kind: string, statementId: string | undefined): number | null {
  const id = useId();
  const key = `${kind}|${statementId ?? id}`;
  const streaming = useIsStreaming();
  const [rise] = useState(() => {
    const now = Date.now();
    const seen = risen.get(key);
    const fresh = !seen || now - seen.last > 4000;
    const first = fresh ? now : seen.first;
    return { first, delay: streaming && now - first < RISE_MS ? first - now : null };
  });
  useEffect(() => {
    risen.set(key, { first: rise.first, last: Date.now() });
    if (risen.size > 200) for (const k of [...risen.keys()].slice(0, 100)) risen.delete(k);
  });
  return rise.delay;
}

/** A card's one tap: what was chosen (kept in block state), and a sender that fires once. */
function useCardTap(statementId: string | undefined) {
  const id = useId();
  const field = `card:${statementId ?? id}`;
  const getField = useGetFieldValue();
  const setField = useSetFieldValue();
  const trigger = useTriggerAction();
  const streaming = useIsStreaming();
  const [local, setLocal] = useState<string | null>(null);
  const lock = useRef(false);
  const saved = getField(undefined, field);
  const done = local ?? (typeof saved === "string" && saved ? saved : null);
  const settled = !!done || streaming;
  /** Send message to the assistant and remember choice; a second tap does nothing. */
  const send = (choice: string, message: string) => {
    const text = message.trim();
    if (lock.current || done || streaming || !text) return;
    lock.current = true;
    setLocal(choice);
    // outside any Form: a card's choice is not a form field
    setField(undefined, undefined, field, choice);
    void trigger(text);
  };
  const open = (url: string) => {
    if (!streaming) void trigger("", undefined, { type: "open_url", params: { url } });
  };
  return { done, settled, streaming, send, open };
}

function Shell({ kind, rise, className, children, label }: {
  kind: string; rise: number | null; className?: string; children: ReactNode; label?: string;
}) {
  return (
    <section
      className={cx("iui-v3-card", `iui-v3-card-${kind}`, rise !== null && "iui-v3-rise", className)}
      style={rise ? { animationDelay: `${rise}ms` } : undefined}
      aria-label={label || undefined}
    >
      {children}
    </section>
  );
}

function Head({ title, meta, aside, icon }: { title: ReactNode; meta?: ReactNode; aside?: ReactNode; icon?: ReactNode }) {
  return (
    <header className="iui-v3-head">
      {icon ? <span className="iui-v3-icon" aria-hidden>{icon}</span> : null}
      <div className="iui-v3-head-text">
        <div className="iui-v3-title">{title}</div>
        {meta ? <div className="iui-v3-meta">{meta}</div> : null}
      </div>
      {aside ? <div className="iui-v3-aside">{aside}</div> : null}
    </header>
  );
}

function Act({ label, onClick, variant = "solid", color, disabled, picked }: {
  label: string; onClick: () => void; variant?: "solid" | "outline" | "soft" | "ghost";
  color?: "danger" | "success"; disabled?: boolean; picked?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx("iui-button", `iui-button-${variant}`, color && `iui-button-${color}`, "iui-button-sm", picked && "is-picked")}
      disabled={disabled}
      aria-pressed={picked || undefined}
      onClick={onClick}
    >
      {picked ? <Check size={14} strokeWidth={2.2} aria-hidden /> : null}
      {label}
    </button>
  );
}

const Actions = ({ children }: { children: ReactNode }) => <div className="iui-v3-actions">{children}</div>;

// Person
const STAGE_TONE: [RegExp, Tone][] = [
  [/\b(won|paid|booked|confirmed|closed|done|active|customer|signed)\b/i, "success"],
  [/\b(hot|urgent|overdue|at risk|churn)/i, "danger"],
  [/\b(warm|follow|pending|waiting|quoted|proposal|nego)/i, "warning"],
  [/\b(vip|repeat|loyal)/i, "purple"],
  [/\b(new|lead|fresh|enquir|inquir)/i, "info"],
];
const stageTone = (stage: string): Tone => STAGE_TONE.find(([re]) => re.test(stage))?.[1] ?? "neutral";
const initials = (name: string) =>
  name.split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w)).slice(0, 2).map((w) => [...w][0]!.toUpperCase()).join("") || "?";

export const Person = defineComponent({
  name: "Person",
  props: z.object({
    name: z.string(),
    detail: z.string().optional(),
    stage: z.string().optional(),
    facts: z.record(z.string(), scalar).optional(),
    actions: z.array(Button.ref).optional(),
  }),
  description: "A person or lead: name, a line on who they are, a stage badge, facts as {label: value}, Buttons.",
  component: function PersonCard({ props, renderNode, statementId }) {
    const rise = useRise("Person", statementId);
    const name = str(props.name);
    const stage = str(props.stage);
    const facts = props.facts && typeof props.facts === "object" && !Array.isArray(props.facts)
      ? Object.entries(props.facts as Record<string, unknown>).filter(([, v]) => v != null && str(v) !== "")
      : [];
    const actions = list<unknown>(props.actions);
    return (
      <Shell kind="person" rise={rise} label={name}>
        <Head
          icon={<span className="iui-v3-avatar">{initials(name)}</span>}
          title={name || "someone"}
          meta={props.detail ? inline(str(props.detail)) : null}
          aside={stage ? <Pill tone={stageTone(stage)}>{stage}</Pill> : null}
        />
        {facts.length ? (
          <dl className="iui-v3-facts">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{typeof value === "boolean" ? (value ? "yes" : "no") : inline(str(value))}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {actions.length ? <Actions>{renderNode(actions)}</Actions> : null}
      </Shell>
    );
  },
});

// Approval
export const Approval = defineComponent({
  name: "Approval",
  props: z.object({
    title: z.string(),
    detail: z.string().optional(),
    items: z.array(z.string()).optional(),
    approveMessage: z.string().optional(),
    rejectMessage: z.string().optional(),
    approveLabel: z.string().optional(),
  }),
  description: "Asks for a go-ahead before you act. Buttons send approveMessage / rejectMessage (defaults name the title).",
  component: function ApprovalCard({ props, statementId }) {
    const tap = useCardTap(statementId);
    const rise = useRise("Approval", statementId);
    const title = str(props.title);
    const items = list<unknown>(props.items).map(str).filter(Boolean);
    const yes = cardMessage.approve(title, props.approveMessage);
    const no = cardMessage.reject(title, props.rejectMessage);
    return (
      <Shell kind="approval" rise={rise} label={title}>
        <Head
          title={inline(title)}
          meta={props.detail ? inline(str(props.detail)) : null}
          aside={tap.done === "yes" ? <Pill tone="success">approved</Pill> : tap.done === "no" ? <Pill>declined</Pill> : <Pill tone="warning">needs you</Pill>}
        />
        {items.length ? (
          <ul className="iui-v3-items">
            {items.map((item, i) => <li key={i}>{inline(item, `a${i}`)}</li>)}
          </ul>
        ) : null}
        <Actions>
          <Act label={str(props.approveLabel) || "approve"} disabled={tap.settled} picked={tap.done === "yes"} onClick={() => tap.send("yes", yes)} />
          <Act label="not now" variant="outline" disabled={tap.settled} picked={tap.done === "no"} onClick={() => tap.send("no", no)} />
        </Actions>
      </Shell>
    );
  },
});

// Choices
export const Choices = defineComponent({
  name: "Choices",
  props: z.object({
    question: z.string(),
    options: z.array(z.string()),
    multi: z.boolean().optional(),
  }),
  description: "One question with a few answers; a tap sends the answer. multi lets them pick several, then send.",
  component: function ChoicesCard({ props, statementId }) {
    const tap = useCardTap(statementId);
    const rise = useRise("Choices", statementId);
    const [picked, setPicked] = useState<string[]>([]);
    const options = [...new Set(list<unknown>(props.options).map(str).filter(Boolean))];
    const multi = props.multi === true;
    const sent = tap.done ? (multi ? tap.done.split("\n") : [tap.done]) : null;
    const isOn = (option: string) => (sent ? sent.includes(option) : multi && picked.includes(option));
    const toggle = (option: string) => setPicked((now) => (now.includes(option) ? now.filter((o) => o !== option) : [...now, option]));
    const chosen = options.filter((o) => picked.includes(o));
    return (
      <Shell kind="choices" rise={rise} label={str(props.question)}>
        <Head title={inline(str(props.question))} meta={multi && !sent ? "pick any" : null} />
        <div className="iui-v3-options" role={multi ? "group" : undefined}>
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className={cx("iui-v3-option", isOn(option) && "is-on")}
              aria-pressed={multi || sent ? isOn(option) : undefined}
              disabled={tap.settled}
              onClick={() => (multi ? toggle(option) : tap.send(option, option))}
            >
              {isOn(option) ? <Check size={14} strokeWidth={2.2} aria-hidden /> : null}
              <span>{option}</span>
            </button>
          ))}
        </div>
        {multi ? (
          <Actions>
            <Act
              label={sent ? "sent" : "send"}
              disabled={tap.settled || chosen.length === 0}
              onClick={() => tap.send(chosen.join("\n"), cardMessage.choices(chosen))}
            />
          </Actions>
        ) : null}
      </Shell>
    );
  },
});

// Steps
const STEP_STATUS = ["done", "doing", "todo", "failed"] as const;
type StepStatus = (typeof STEP_STATUS)[number];
const stepStatus = (value: unknown): StepStatus => (STEP_STATUS as readonly string[]).includes(value as string) ? (value as StepStatus) : "todo";

export const Steps = defineComponent({
  name: "Steps",
  props: z.object({
    title: z.string(),
    steps: z.array(z.object({
      label: z.string(),
      status: z.enum(STEP_STATUS).optional(),
      detail: z.string().optional(),
    })),
  }),
  description: "Work in several steps, each done, doing, todo or failed.",
  component: function StepsCard({ props, statementId }) {
    const rise = useRise("Steps", statementId);
    const steps = list<Record<string, unknown>>(props.steps).filter((s) => typeof s === "object").map((s) => ({
      label: str(s.label), status: stepStatus(s.status), detail: str(s.detail),
    }));
    const done = steps.filter((s) => s.status === "done").length;
    const failed = steps.some((s) => s.status === "failed");
    const all = steps.length > 0 && done === steps.length;
    return (
      <Shell kind="steps" rise={rise} label={str(props.title)}>
        <Head
          title={inline(str(props.title))}
          meta={steps.length ? `${done} of ${steps.length} done` : null}
          aside={failed ? <Pill tone="danger">needs a look</Pill> : all ? <Pill tone="success">done</Pill> : steps.some((s) => s.status === "doing") ? <Pill tone="info">working</Pill> : null}
        />
        {steps.length ? (
          <ol className="iui-v3-steps">
            {steps.map((step, i) => (
              <li key={i} className={`is-${step.status}`}>
                <span className="iui-v3-step-mark" aria-hidden>
                  {step.status === "done" ? <Check size={12} strokeWidth={2.6} /> : step.status === "failed" ? <X size={12} strokeWidth={2.6} /> : null}
                </span>
                <div className="iui-v3-step-body">
                  <div className="iui-v3-step-label">
                    {inline(step.label || `step ${i + 1}`, `s${i}`)}
                    <span className="iui-v3-sr"> ({step.status})</span>
                  </div>
                  {step.detail ? <div className="iui-v3-meta">{inline(step.detail, `d${i}`)}</div> : null}
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </Shell>
    );
  },
});

// Receipt
/** A number from 1200, "1,200.50" or "RM 1,200"; null when there is none. */
export function amountOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^\d.\-]/g, "");
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
export function money(n: number, currency: string): string {
  const shown = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "−" : ""}${currency ? `${currency} ` : ""}${shown}`;
}
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** Line totals (qty × amount), subtotal, tax and total, in cents-safe rounding. */
export function receiptTotals(items: { qty?: unknown; amount?: unknown }[], taxPercent?: unknown) {
  const lines = items.map((item) => {
    const qty = amountOf(item.qty) ?? 1;
    return round2(qty * (amountOf(item.amount) ?? 0));
  });
  const subtotal = round2(lines.reduce((a, b) => a + b, 0));
  const rate = amountOf(taxPercent);
  const tax = rate ? round2((subtotal * rate) / 100) : 0;
  return { lines, subtotal, rate: rate || 0, tax, total: round2(subtotal + tax) };
}
const RECEIPT_TONE: Record<string, Tone> = { draft: "neutral", sent: "info", paid: "success", overdue: "danger" };

export const Receipt = defineComponent({
  name: "Receipt",
  props: z.object({
    title: z.string(),
    items: z.array(z.object({
      label: z.string(),
      qty: z.number().optional(),
      amount: z.union([z.number(), z.string()]),
    })),
    currency: z.string().optional(),
    status: z.enum(["draft", "sent", "paid", "overdue"]).optional(),
    meta: z.string().optional(),
    taxPercent: z.number().optional(),
  }),
  description: "Invoice, receipt or quote. amount is per unit; the card adds the lines, tax (taxPercent) and total.",
  component: function ReceiptCard({ props, statementId }) {
    const rise = useRise("Receipt", statementId);
    const currency = props.currency == null ? "RM" : str(props.currency);
    const items = list<Record<string, unknown>>(props.items).filter((i) => typeof i === "object");
    const totals = receiptTotals(items, props.taxPercent);
    const status = props.status && props.status in RECEIPT_TONE ? props.status : null;
    return (
      <Shell kind="receipt" rise={rise} label={str(props.title)}>
        <Head
          title={inline(str(props.title))}
          meta={props.meta ? inline(str(props.meta)) : null}
          aside={status ? <Pill tone={RECEIPT_TONE[status]}>{status}</Pill> : null}
        />
        {items.length ? (
          <ul className="iui-v3-lines">
            {items.map((item, i) => {
              const qty = amountOf(item.qty);
              const unit = amountOf(item.amount);
              return (
                <li key={i}>
                  <div className="iui-v3-line-label">
                    <span>{inline(str(item.label), `l${i}`)}</span>
                    {qty !== null && qty !== 1 && unit !== null ? <span className="iui-v3-meta">{qty.toLocaleString("en-US")} × {money(unit, currency)}</span> : null}
                  </div>
                  <span className="iui-v3-num">{money(totals.lines[i] ?? 0, currency)}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
        <dl className="iui-v3-totals">
          {totals.rate ? (
            <>
              <div><dt>subtotal</dt><dd className="iui-v3-num">{money(totals.subtotal, currency)}</dd></div>
              <div><dt>tax {totals.rate.toLocaleString("en-US", { maximumFractionDigits: 2 })}%</dt><dd className="iui-v3-num">{money(totals.tax, currency)}</dd></div>
            </>
          ) : null}
          <div className="is-total"><dt>total</dt><dd className="iui-v3-num">{money(totals.total, currency)}</dd></div>
        </dl>
      </Shell>
    );
  },
});

// Schedule
export const Schedule = defineComponent({
  name: "Schedule",
  props: z.object({
    title: z.string(),
    when: z.string(),
    bot: z.string().optional(),
    sample: z.string().optional(),
    on: z.boolean().optional(),
  }),
  description: "Something recurring you set up or propose. \"turn it on\" asks you to set it up; on shows it running.",
  component: function ScheduleCard({ props, statementId }) {
    const tap = useCardTap(statementId);
    const rise = useRise("Schedule", statementId);
    const title = str(props.title);
    const when = str(props.when);
    const on = props.on === true;
    return (
      <Shell kind="schedule" rise={rise} label={title}>
        <Head
          icon={<Repeat size={16} strokeWidth={1.9} />}
          title={inline(title)}
          meta={[when, str(props.bot) && `by ${str(props.bot)}`].filter(Boolean).join(" · ") || null}
          aside={on ? <Pill tone="success">on</Pill> : tap.done ? <Pill tone="info">asked</Pill> : null}
        />
        {props.sample ? <blockquote className="iui-v3-inset">{inline(str(props.sample))}</blockquote> : null}
        {on ? null : (
          <Actions>
            <Act
              label={tap.done ? "asked to turn on" : "turn it on"}
              disabled={tap.settled}
              picked={!!tap.done}
              onClick={() => tap.send("on", cardMessage.schedule(title, when))}
            />
          </Actions>
        )}
      </Shell>
    );
  },
});

// SettingChange
export const SettingChange = defineComponent({
  name: "SettingChange",
  props: z.object({
    setting: z.string(),
    from: scalar,
    to: scalar,
    scope: z.string().optional(),
    applyMessage: z.string().optional(),
  }),
  description: "A change to one setting, from → to. apply sends applyMessage (default names the change).",
  component: function SettingChangeCard({ props, statementId }) {
    const tap = useCardTap(statementId);
    const rise = useRise("SettingChange", statementId);
    const shown = (v: unknown) => (typeof v === "boolean" ? (v ? "on" : "off") : str(v));
    const setting = str(props.setting);
    const from = shown(props.from);
    const to = shown(props.to);
    return (
      <Shell kind="setting" rise={rise} label={setting}>
        <Head
          title={inline(setting)}
          meta={props.scope ? inline(str(props.scope)) : null}
          aside={tap.done ? <Pill tone="success">applying</Pill> : null}
        />
        <div className="iui-v3-change">
          <span className="iui-v3-from">{from || "not set"}</span>
          <ArrowRight size={14} strokeWidth={2} aria-label="to" className="iui-v3-arrow" />
          <span className="iui-v3-to">{to || "not set"}</span>
        </div>
        <Actions>
          <Act
            label={tap.done ? "applied" : "apply"}
            disabled={tap.settled}
            picked={!!tap.done}
            onClick={() => tap.send("apply", cardMessage.setting(setting, from, to, props.applyMessage))}
          />
        </Actions>
      </Shell>
    );
  },
});

// FilePreview
const FILE_KINDS = ["page", "doc", "sheet", "slides", "image", "pdf", "code", "file"] as const;
const FILE_ICON: Record<string, LucideIcon> = {
  page: Globe, doc: FileText, sheet: FileSpreadsheet, slides: Presentation, image: FileImage, pdf: FileText, code: Code2, file: File,
};

export const FilePreview = defineComponent({
  name: "FilePreview",
  props: z.object({
    name: z.string(),
    kind: z.enum(FILE_KINDS).optional(),
    summary: z.string().optional(),
    url: z.string().optional(),
    meta: z.string().optional(),
  }),
  description: "A file or page you made. open goes to url when it is http(s), else asks you to open it.",
  component: function FilePreviewCard({ props, statementId }) {
    const tap = useCardTap(statementId);
    const rise = useRise("FilePreview", statementId);
    const name = str(props.name);
    const kind = props.kind && props.kind in FILE_ICON ? props.kind : "file";
    const Icon = FILE_ICON[kind]!;
    const url = webUrl(props.url);
    return (
      <Shell kind="file" rise={rise} label={name}>
        <Head
          icon={<Icon size={18} strokeWidth={1.8} />}
          title={name || "untitled"}
          meta={[kind === "file" ? "" : kind, str(props.meta)].filter(Boolean).join(" · ") || null}
        />
        {props.summary ? <p className="iui-v3-body">{inline(str(props.summary))}</p> : null}
        <Actions>
          <Act
            label="open"
            variant="outline"
            disabled={url ? tap.streaming : tap.settled}
            onClick={() => (url ? tap.open(url) : tap.send("open", cardMessage.open(name)))}
          />
        </Actions>
      </Shell>
    );
  },
});

// Compare
const fieldLabel = (key: string) => key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

export const Compare = defineComponent({
  name: "Compare",
  props: z.object({
    items: z.array(z.object({ name: z.string() }).catchall(z.any())),
    fields: z.array(z.string()).optional(),
    pick: z.string().optional(),
  }),
  description: "2 to 4 options side by side. fields picks and orders the rows (default: every key); pick marks your pick.",
  component: function CompareCard({ props, statementId }) {
    const tap = useCardTap(statementId);
    const rise = useRise("Compare", statementId);
    const items = list<Record<string, unknown>>(props.items).filter((i) => typeof i === "object").slice(0, 6);
    const keys = list<unknown>(props.fields).map(str).filter((k) => k && k !== "name");
    const fields = keys.length ? keys : [...new Set(items.flatMap((i) => Object.keys(i).filter((k) => k !== "name")))];
    const pick = str(props.pick).toLowerCase();
    return (
      <Shell kind="compare" rise={rise}>
        <div className="iui-v3-compare">
          {items.map((item, i) => {
            const name = str(item.name) || `option ${i + 1}`;
            const isPick = !!pick && name.toLowerCase() === pick;
            return (
              <div key={i} className={cx("iui-v3-option-col", isPick && "is-pick", tap.done === name && "is-on")}>
                <div className="iui-v3-col-head">
                  <div className="iui-v3-title">{inline(name, `n${i}`)}</div>
                  {isPick ? <Pill tone="success">pick</Pill> : null}
                </div>
                <dl className="iui-v3-facts is-stacked">
                  {fields.map((field) => {
                    const value = item[field];
                    return (
                      <div key={field}>
                        <dt>{fieldLabel(field)}</dt>
                        <dd>{value == null || value === "" ? "–" : typeof value === "boolean" ? (value ? "yes" : "no") : typeof value === "object" ? JSON.stringify(value) : inline(str(value), `v${i}`)}</dd>
                      </div>
                    );
                  })}
                </dl>
                <Act
                  label={tap.done === name ? "chosen" : "choose"}
                  variant={isPick ? "solid" : "outline"}
                  disabled={tap.settled}
                  picked={tap.done === name}
                  onClick={() => tap.send(name, cardMessage.pick(name))}
                />
              </div>
            );
          })}
        </div>
      </Shell>
    );
  },
});

// Draft
const CHANNELS = ["email", "whatsapp", "sms", "post", "message"] as const;
const CHANNEL_ICON: Record<string, LucideIcon> = { email: Mail, whatsapp: MessageCircle, sms: Smartphone, post: Megaphone, message: MessageSquare };

export const Draft = defineComponent({
  name: "Draft",
  props: z.object({
    to: z.string(),
    text: z.string(),
    channel: z.enum(CHANNELS).optional(),
    subject: z.string().optional(),
    sendMessage: z.string().optional(),
  }),
  description: "A message you drafted for someone else; edit changes the words in the card, send asks you to send them.",
  component: function DraftCard({ props, statementId }) {
    const tap = useCardTap(statementId);
    const rise = useRise("Draft", statementId);
    const to = str(props.to);
    const channel = props.channel && props.channel in CHANNEL_ICON ? props.channel : "message";
    const Icon = CHANNEL_ICON[channel]!;
    const original = props.text == null ? "" : String(props.text);
    // The person's own words live in block state, beside the tap, so a reload
    // still shows what was sent. Typing stays local until they leave the box.
    const id = useId();
    const field = `draft:${statementId ?? id}`;
    const getField = useGetFieldValue();
    const setField = useSetFieldValue();
    const saved = getField(undefined, field);
    const kept = typeof saved === "string" ? saved : null;
    const [editing, setEditing] = useState(false);
    const [typed, setTyped] = useState<string | null>(null);
    const text = typed ?? kept ?? original;
    const changed = text.trim() !== original.trim();
    const box = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
      const el = box.current;
      if (!editing || !el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }, [editing, text]);
    useEffect(() => {
      const el = box.current;
      if (!editing || !el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, [editing]);
    const save = () => { if (typed != null) setField(undefined, undefined, field, typed); };
    const keep = () => { setEditing(false); save(); };
    const send = () => {
      if (!text.trim()) return;
      keep();
      tap.send("send", changed ? cardMessage.sendEdited(channel, to, text) : cardMessage.send(channel, to, props.sendMessage));
    };
    const live = editing && !tap.settled;
    return (
      <Shell kind="draft" rise={rise} label={`draft to ${to}`}>
        <Head
          icon={<Icon size={16} strokeWidth={1.9} />}
          title={<>to {to || "someone"}</>}
          meta={channel === "message" ? "draft" : `${channel} draft`}
          aside={tap.done === "send" ? <Pill tone="success">sending</Pill> : live ? <Pill>editing</Pill> : changed ? <Pill>edited</Pill> : null}
        />
        {props.subject ? <div className="iui-v3-subject">{inline(str(props.subject))}</div> : null}
        {live ? (
          <textarea
            ref={box}
            className="iui-v3-inset iui-v3-draft-text iui-v3-draft-edit"
            value={text}
            rows={1}
            aria-label={`edit the draft to ${to || "someone"}`}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
              else if (e.key === "Escape") { e.preventDefault(); keep(); }
            }}
          />
        ) : (
          <div
            className={cx("iui-v3-inset iui-v3-draft-text", !tap.settled && "is-editable")}
            onClick={tap.settled ? undefined : () => setEditing(true)}
          >{text}</div>
        )}
        <Actions>
          <Act label="send" disabled={tap.settled || !text.trim()} picked={tap.done === "send"} onClick={send} />
          <Act label={live ? "done" : "edit"} variant="outline" disabled={tap.settled} onClick={() => (live ? keep() : setEditing(true))} />
          {changed && !tap.settled ? (
            <Act label="undo edits" variant="ghost" onClick={() => { setTyped(original); setField(undefined, undefined, field, original); }} />
          ) : null}
        </Actions>
      </Shell>
    );
  },
});

// Checkin: the person's live check-in list. It reads the server's list rather
// than props, so a card from this morning shows what is still open now, and
// its buttons act on the item directly instead of messaging the bot. Where
// the owner api isn't reachable (the phone's card webview) it points at the
// today card on the home screen, which carries the same buttons.
const CHECKIN_KIND: Record<CheckinItem["kind"], [string, Tone]> = {
  did: ["done", "success"],
  broke: ["broke", "danger"],
  decide: ["decide", "warning"],
  tonight: ["tonight", "info"],
};

export const Checkin = defineComponent({
  name: "Checkin",
  props: z.object({
    note: z.string().optional(),
  }),
  description: "The person's open check-in items, live from the server, with go ahead / done / not now / no on each.",
  component: function CheckinCard({ props, statementId }) {
    const rise = useRise("Checkin", statementId);
    const streaming = useIsStreaming();
    const { snapshot, busy, error } = useCheckins(!streaming);
    const items = snapshot?.items ?? [];
    const note = str(props.note);
    return (
      <Shell kind="checkin" rise={rise} label="check-in">
        <Head
          title={items.length ? `${items.length} ${items.length === 1 ? "thing needs" : "things need"} you` : "check-in"}
          meta={note ? inline(note) : null}
          aside={snapshot ? (items.length ? <Pill tone="warning">needs you</Pill> : <Pill tone="success">all clear</Pill>) : null}
        />
        {!snapshot && error ? <p className="iui-v3-meta">open today on the home screen to answer these.</p> : null}
        {snapshot && !items.length ? <p className="iui-v3-meta">nothing needs you right now.</p> : null}
        {items.length ? (
          <ul className="iui-v3-checkins">
            {items.map((item) => {
              const [kind, tone] = CHECKIN_KIND[item.kind] ?? ["", "neutral"];
              const held = busy.has(item.id) || streaming;
              const act = (action: CheckinAction) => void actOnCheckin(item.id, action);
              return (
                <li key={item.id} data-checkin-item={item.id}>
                  <div className="iui-v3-checkin-head"><strong>{item.title}</strong> {kind ? <Pill tone={tone}>{kind}</Pill> : null}</div>
                  {item.why ? <div className="iui-v3-meta">{inline(item.why, `w${item.id}`)}</div> : null}
                  {item.draft ? <div className="iui-v3-inset iui-v3-draft-text">{item.draft}</div> : null}
                  <Actions>
                    {item.kind === "did" ? (
                      <Act label="got it" disabled={held} onClick={() => act("done")} />
                    ) : (
                      <>
                        <Act label={item.kind === "broke" ? "fix it" : item.draft ? "send" : "go ahead"} disabled={held} onClick={() => act("approve")} />
                        <Act label="done" variant="outline" disabled={held} onClick={() => act("done")} />
                        <Act label="not now" variant="outline" disabled={held} onClick={() => act("not-now")} />
                      </>
                    )}
                    <Act label="no" variant="ghost" disabled={held} onClick={() => act("no")} />
                  </Actions>
                </li>
              );
            })}
          </ul>
        ) : null}
      </Shell>
    );
  },
});

export const CARDS = [Person, Approval, Choices, Steps, Receipt, Schedule, SettingChange, FilePreview, Compare, Draft, Checkin];
