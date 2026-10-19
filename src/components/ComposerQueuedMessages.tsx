import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ClipboardPaste, CornerDownRight, File as FileIcon, Image as ImageIcon, Pencil, Trash2 } from "lucide-react";

import { splitQueuedPreview } from "@/lib/composer-attachments";
import { t } from "@/lib/i18n";

export function composerCanSteerQueuedMessages(
  busy: boolean,
  locked: boolean,
  pendingCount: number,
  approvalPending = false,
): boolean {
  return busy && !locked && !approvalPending && pendingCount > 0;
}

const ROW_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-secondary outline-none hover:bg-raised-hover hover:text-ink focus-visible:ring-1 focus-visible:ring-hairline";
const UNDO_MS = 5000;

/** Only typed words are editable in place: the server refuses an edit that
 * changes a queued item's attachments, and pasted blocks are not text the
 * person typed into this row. */
export function queuedTextEditable(text: string): boolean {
  return !text.includes("<pasted-text") && !text.includes("<attached-");
}

/** Messages held by the harness until the running turn settles.
 *
 * The queue sits directly above the composer rather than pretending these
 * words are already part of the transcript. Only its head owns Steer: room
 * queues drain one item at a time, while bot queues coalesce all waiting
 * items into one follow-up. Delete remains available on every exact queue id.
 */
export function QueuedComposerMessages({
  items,
  onSteer,
  onResume,
  steerMode = "all",
  steering = false,
  steerInterrupts = false,
  steerTargetName,
  steerUnavailable,
  onCancel,
  onEdit,
  onReorder,
  onSteerItem,
}: {
  items: Array<{ queueId: string; text: string; paused?: boolean; reason?: "capacity" }>;
  onSteer?: () => void;
  onResume?: () => void;
  steerMode?: "all" | "next";
  steering?: boolean;
  /** True when Steer is backed by an interrupt (engine without live steer):
   * the hint must say what the click really does. */
  steerInterrupts?: boolean;
  /** Room steer: the one running member the server will deliver the head
   * to, so the button names who actually receives it. */
  steerTargetName?: string;
  /** Room steer the server would refuse or hold: shown in place of the
   * button so nobody clicks a Steer that lands nowhere. */
  steerUnavailable?: string;
  onCancel: (queueId: string) => void;
  /** Replace a queued item's words; `expectedText` is what the row showed. */
  onEdit?: (queueId: string, text: string, expectedText: string) => void;
  /** The whole queue in its new order after a move. */
  onReorder?: (order: string[]) => void;
  /** Bring a later item to the front and steer it into the running turn. */
  onSteerItem?: (queueId: string) => void;
}) {
  // Delete waits UNDO_MS behind an undo row; leaving the thread, or any
  // steer, commits it first so a hidden item is never folded into a turn.
  const [deleting, setDeleting] = useState<string | null>(null);
  const deletingRef = useRef<string | null>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const commitDelete = () => {
    const queueId = deletingRef.current;
    if (!queueId) return;
    deletingRef.current = null;
    setDeleting(null);
    cancelRef.current(queueId);
  };
  useEffect(() => {
    if (!deleting) return;
    const timeout = window.setTimeout(commitDelete, UNDO_MS);
    return () => window.clearTimeout(timeout);
  }, [deleting]);
  useEffect(() => () => {
    if (deletingRef.current) cancelRef.current(deletingRef.current);
  }, []);
  // An item that left the queue on its own (sent, steered) has nothing to undo.
  useEffect(() => {
    if (deleting && !items.some((item) => item.queueId === deleting)) {
      deletingRef.current = null;
      setDeleting(null);
    }
  }, [items, deleting]);
  const [editing, setEditing] = useState<{ queueId: string; draft: string } | null>(null);
  useEffect(() => {
    if (editing && !items.some((item) => item.queueId === editing.queueId)) setEditing(null);
  }, [items, editing]);

  const visible = items.filter((item) => item.queueId !== deleting);
  if (!visible.length && !deleting) return null;
  const startDelete = (queueId: string) => {
    commitDelete();
    deletingRef.current = queueId;
    setDeleting(queueId);
  };
  const steerHead = () => {
    commitDelete();
    // Steer the first row the person can see: a head still waiting on its
    // undo is already on its way out.
    if (onSteerItem && visible[0]) onSteerItem(visible[0].queueId);
    else onSteer?.();
  };
  // Swap with the visible neighbour; a row hidden behind undo keeps its slot.
  const move = (index: number, delta: -1 | 1) => {
    const a = visible[index];
    const b = visible[index + delta];
    if (!a || !b || !onReorder) return;
    const order = items.map((item) => item.queueId);
    const ai = order.indexOf(a.queueId);
    const bi = order.indexOf(b.queueId);
    order[ai] = b.queueId;
    order[bi] = a.queueId;
    onReorder(order);
  };
  const steerItem = (queueId: string) => {
    commitDelete();
    onSteerItem?.(queueId);
  };
  const saveEdit = (item: { queueId: string; text: string }) => {
    const draft = editing?.draft.trim() ?? "";
    setEditing(null);
    if (draft && draft !== item.text && onEdit) onEdit(item.queueId, draft, item.text);
  };

  const multiple = visible.length > 1;
  const steerLabel = steering
    ? t("composer.queued.steering")
    : steerTargetName
      ? t("composer.queued.steerTo", { name: steerTargetName })
      : multiple
      ? steerMode === "all"
        ? t("composer.queued.steerAll")
        : t("composer.queued.steerNext")
      : t("composer.queued.steer");
  const steerDescription = steerTargetName && !steerInterrupts
    ? t("composer.queued.steerToHint", { name: steerTargetName })
    : steerInterrupts
    ? multiple
      ? steerMode === "all"
        ? t("composer.queued.steerAllInterruptHint", { count: visible.length })
        : t("composer.queued.steerNextInterruptHint")
      : t("composer.queued.steerInterruptHint")
    : multiple
      ? steerMode === "all"
        ? t("composer.queued.steerAllHint", { count: visible.length })
        : t("composer.queued.steerNextHint")
      : t("composer.queued.steerHint");

  return (
    <div
      className="relative z-[1] mx-3 -mb-3 max-h-36 overflow-y-auto rounded-t-2xl border border-b-0 border-hairline/40 bg-raised/95 pb-3 shadow-sm backdrop-blur-sm"
      aria-label={
        visible.length === 1
          ? t("composer.queued.regionOne")
          : t("composer.queued.regionMany", { count: visible.length })
      }
      aria-live="polite"
    >
      {visible.some((item) => item.reason === "capacity") && (
        <p className="px-3 pt-2 text-[12px] text-ink-secondary">{t("composer.queued.capacity")}</p>
      )}
      {items.some(item => item.paused) && <div className="flex items-center gap-3 px-3 pt-2 text-xs text-ink-secondary" role="status"><span>Paused after stop</span><button type="button" className="font-medium underline" onClick={onResume}>Resume</button></div>}
      <ul className="divide-y divide-hairline/25" aria-label={t("composer.queued.list")}>
        {visible.map((item, index) => editing?.queueId === item.queueId ? (
          <li key={item.queueId} className="flex min-h-10 min-w-0 items-center gap-2 px-2.5 py-1.5">
            <input
              autoFocus
              dir="auto"
              value={editing.draft}
              aria-label={t("queue.editAria", { index: index + 1, count: visible.length })}
              onChange={(event) => setEditing({ queueId: item.queueId, draft: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  saveEdit(item);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setEditing(null);
                }
              }}
              className="min-h-7 min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-2 text-[14px] text-ink focus:border-focus"
            />
            <button type="button" onClick={() => saveEdit(item)} className="h-7 shrink-0 rounded-lg px-2 text-[13px] font-medium text-ink outline-none hover:bg-raised-hover focus-visible:ring-1 focus-visible:ring-hairline">
              {t("queue.save")}
            </button>
            <button type="button" onClick={() => setEditing(null)} className="h-7 shrink-0 rounded-lg px-2 text-[13px] text-ink-secondary outline-none hover:bg-raised-hover hover:text-ink focus-visible:ring-1 focus-visible:ring-hairline">
              {t("queue.cancel")}
            </button>
          </li>
        ) : (
          <li key={item.queueId} className="group flex min-h-10 min-w-0 items-center gap-2 px-2.5 py-1.5">
            <CornerDownRight
              size={14}
              strokeWidth={1.8}
              className="shrink-0 text-ink-secondary"
              aria-hidden="true"
            />
            <QueuedPreview text={item.text} />
            {index === 0 && steerUnavailable && (
              <span className="max-w-[45%] shrink-0 truncate text-[12px] text-ink-secondary" title={steerUnavailable}>
                {steerUnavailable}
              </span>
            )}
            {index === 0 && onSteer && !steerUnavailable && (
              <button
                type="button"
                onClick={steerHead}
                disabled={steering}
                aria-label={steering ? t("composer.queued.steeringAria") : steerDescription}
                title={steerDescription}
                className="flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[13px] font-medium text-ink-secondary outline-none hover:bg-raised-hover hover:text-ink focus-visible:ring-1 focus-visible:ring-hairline disabled:cursor-wait disabled:opacity-60"
              >
                <CornerDownRight
                  size={13}
                  strokeWidth={2}
                  className={steering ? "animate-pulse" : undefined}
                  aria-hidden="true"
                />
                {steerLabel}
              </button>
            )}
            {/* Secondary controls surface on hover or keyboard focus so a
                quiet queue stays one line of words plus delete. */}
            <span className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              {index > 0 && onSteerItem && !steerUnavailable && (
                <button
                  type="button"
                  onClick={() => steerItem(item.queueId)}
                  disabled={steering}
                  aria-label={t("queue.steerNow")}
                  title={t("queue.steerNowHint")}
                  className={`${ROW_BUTTON} disabled:cursor-wait disabled:opacity-60`}
                >
                  <CornerDownRight size={14} aria-hidden="true" />
                </button>
              )}
              {onEdit && queuedTextEditable(item.text) && (
                <button
                  type="button"
                  onClick={() => setEditing({ queueId: item.queueId, draft: item.text })}
                  aria-label={t("queue.editAria", { index: index + 1, count: visible.length })}
                  title={t("queue.edit")}
                  className={ROW_BUTTON}
                >
                  <Pencil size={13} aria-hidden="true" />
                </button>
              )}
              {onReorder && multiple && index > 0 && (
                <button type="button" onClick={() => move(index, -1)} aria-label={t("queue.up")} title={t("queue.up")} className={ROW_BUTTON}>
                  <ArrowUp size={14} aria-hidden="true" />
                </button>
              )}
              {onReorder && multiple && index < visible.length - 1 && (
                <button type="button" onClick={() => move(index, 1)} aria-label={t("queue.down")} title={t("queue.down")} className={ROW_BUTTON}>
                  <ArrowDown size={14} aria-hidden="true" />
                </button>
              )}
            </span>
            <button
              type="button"
              onClick={() => startDelete(item.queueId)}
              aria-label={t("composer.queued.deleteAria", { index: index + 1, count: visible.length })}
              title={t("composer.queued.deleteTitle")}
              className={ROW_BUTTON}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
        {deleting && (
          <li className="flex min-h-10 min-w-0 items-center gap-2 px-2.5 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink-secondary">{t("queue.deleted")}</span>
            <button
              type="button"
              onClick={() => {
                deletingRef.current = null;
                setDeleting(null);
              }}
              className="h-7 shrink-0 rounded-lg px-2 text-[13px] font-medium text-ink outline-none hover:bg-raised-hover focus-visible:ring-1 focus-visible:ring-hairline"
            >
              {t("queue.undo")}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

/** One queued row: typed words first, then a quiet chip per pasted block or
 * attachment, so the queue never shows the prompt's raw wrapper tags. */
function QueuedPreview({ text }: { text: string }) {
  const preview = splitQueuedPreview(text);
  const chips = [
    ...preview.pastes.map((paste, index) => ({
      key: `paste-${index}`,
      icon: ClipboardPaste,
      label: t("composer.queued.pasted", { lines: paste.lines }),
    })),
    ...preview.images.map((image, index) => ({ key: `image-${index}`, icon: ImageIcon, label: image.name })),
    ...preview.files.map((file, index) => ({ key: `file-${index}`, icon: FileIcon, label: file.name })),
  ];
  const title = [preview.display, ...chips.map((chip) => chip.label)].filter(Boolean).join(" · ");
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5" title={title}>
      {preview.display && (
        <span dir="auto" className="min-w-0 truncate text-[14px] text-ink">
          {preview.display}
        </span>
      )}
      {chips.map(({ key, icon: Icon, label }) => (
        <span
          key={key}
          className="flex max-w-40 shrink-0 items-center gap-1 rounded-md bg-hairline/25 px-1.5 py-0.5 text-[12px] text-ink-secondary"
        >
          <Icon size={12} strokeWidth={1.8} aria-hidden="true" />
          <span className="truncate">{label}</span>
        </span>
      ))}
    </span>
  );
}
