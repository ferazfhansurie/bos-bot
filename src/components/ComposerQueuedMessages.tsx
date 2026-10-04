import { ClipboardPaste, CornerDownRight, File as FileIcon, Image as ImageIcon, Trash2 } from "lucide-react";

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
  steerMode = "all",
  steering = false,
  steerInterrupts = false,
  steerTargetName,
  steerUnavailable,
  onCancel,
}: {
  items: Array<{ queueId: string; text: string; reason?: "capacity" }>;
  onSteer?: () => void;
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
}) {
  if (!items.length) return null;

  const multiple = items.length > 1;
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
        ? t("composer.queued.steerAllInterruptHint", { count: items.length })
        : t("composer.queued.steerNextInterruptHint")
      : t("composer.queued.steerInterruptHint")
    : multiple
      ? steerMode === "all"
        ? t("composer.queued.steerAllHint", { count: items.length })
        : t("composer.queued.steerNextHint")
      : t("composer.queued.steerHint");

  return (
    <div
      className="relative z-[1] mx-3 -mb-3 max-h-36 overflow-y-auto rounded-t-2xl border border-b-0 border-hairline/40 bg-raised/95 pb-3 shadow-sm backdrop-blur-sm"
      aria-label={
        items.length === 1
          ? t("composer.queued.regionOne")
          : t("composer.queued.regionMany", { count: items.length })
      }
      aria-live="polite"
    >
      {items.some((item) => item.reason === "capacity") && (
        <p className="px-3 pt-2 text-[12px] text-ink-secondary">{t("composer.queued.capacity")}</p>
      )}
      <ul className="divide-y divide-hairline/25" aria-label={t("composer.queued.list")}>
        {items.map((item, index) => (
          <li key={item.queueId} className="flex min-h-10 min-w-0 items-center gap-2 px-2.5 py-1.5">
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
                onClick={onSteer}
                disabled={steering}
                aria-label={steering ? t("composer.queued.steeringAria") : steerDescription}
                title={steerDescription}
                className="flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[13px] font-medium text-ink-secondary outline-none hover:bg-raised-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-wait disabled:opacity-60"
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
            <button
              type="button"
              onClick={() => onCancel(item.queueId)}
              aria-label={t("composer.queued.deleteAria", { index: index + 1, count: items.length })}
              title={t("composer.queued.deleteTitle")}
              className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-secondary outline-none hover:bg-raised-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
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
