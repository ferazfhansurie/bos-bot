// Beat: bring your setup. Shown only when the server found a Claude Code,
// Codex or Cursor setup on this computer. The seeded bot is the default
// target; Settings → Import does the same later, so skipping costs nothing.
import { useEffect } from "react";
import { SetupImportFlow, type DetectedSource } from "@/components/SetupImport";
import type { Bot } from "@/state/store";
import { QuietButton, type BeatProps } from "./shared";

export function ImportBeat({
  onNext,
  onSkip,
  setMascot,
  bump,
  bot,
  sources,
}: BeatProps & { bot: Bot | null; sources: DetectedSource[] }) {
  useEffect(() => {
    setMascot("curious");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="animate-rise mt-4 flex min-h-0 flex-col gap-3">
      <div className="text-[13.5px] leading-relaxed text-ink-secondary">
        you already set up an agent on this computer. bring its instructions, skills and mcp servers over instead of starting blank.
      </div>
      <SetupImportFlow
        compact
        initial={{ sources, links: [] }}
        defaultBotId={bot?.id ?? null}
        onFinished={() => {
          bump("celebrate");
          onNext();
        }}
      />
      <div className="flex justify-center">
        <QuietButton onClick={onSkip}>not now</QuietButton>
      </div>
    </div>
  );
}
