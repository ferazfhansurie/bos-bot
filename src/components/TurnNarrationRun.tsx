// A settled turn's intermediate assistant messages. Providers such as Grok
// narrate before tools; the messages stay available without looking like six
// separate final answers after the turn is done.
import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";

export function TurnNarrationRun({
  label,
  forceOpen = false,
  children,
}: {
  label: string;
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-start">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title={open ? "Hide progress messages" : "Show progress messages"}
          className="chat-text-tertiary flex max-w-full items-center gap-1.5 border-0 p-0 text-[14px] hover:text-ink"
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronRight size={14} className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
        </button>
      </div>
      <div className="border-t chat-hairline pt-1" />
      {open && children}
    </div>
  );
}
