// 3.0: the one undo toast (lib/v3-undo). Bottom centre, above the composer.
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { dismissUndo, undoNow, useUndoToast } from "@/lib/v3-undo";
import "./alive.css";

export function UndoToastHost() {
  const toast = useUndoToast();
  if (!toast) return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[61] flex justify-center px-4" data-testid="v3-undo">
      <div
        role="status"
        key={toast.id}
        className="v3-rise pointer-events-auto flex max-w-[420px] items-center gap-2 rounded-xl border border-hairline/50 bg-card py-2 pl-3.5 pr-1.5 text-[13px] text-ink shadow-xl"
      >
        <span className="min-w-0 truncate">{toast.text}</span>
        {(toast.undo || toast.commit) && (
          <button
            type="button"
            onClick={() => undoNow(toast.id)}
            className="shrink-0 rounded-md px-2 py-0.5 font-medium text-accent hover:bg-raised"
          >
            {t("common.undo")}
          </button>
        )}
        <button
          type="button"
          aria-label={t("v3.undo.dismiss")}
          onClick={() => dismissUndo(toast.id)}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={13} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
