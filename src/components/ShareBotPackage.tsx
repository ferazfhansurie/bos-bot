import { useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { api, useStore } from "@/state/store";
import { downloadSnippetFile } from "@/lib/code-block";

/** Prepare a portable definition locally. Nothing is published by this flow. */
export function ShareBotPackage() {
  const { state } = useStore();
  const bots = state.bots.filter((bot) => !bot.hidden && !bot.remote);
  const [botId, setBotId] = useState("");
  const [skills, setSkills] = useState<Array<{ name: string; description: string }>>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const revision = useRef(0);
  const bot = bots.find((item) => item.id === botId);
  const invalidate = () => { revision.current++; setPreview(""); setReviewed(false); setBusy(false); setError(""); };

  useEffect(() => {
    let current = true;
    setSkills([]);
    if (!botId) { setLoadingSkills(false); return; }
    setLoadingSkills(true);
    void api(`/api/bots/${encodeURIComponent(botId)}/skills`).then((result) => {
      if (current) setSkills(result.skills ?? []);
    }).catch(() => {
      if (current) setError("Skills could not be loaded. You can still share the bot without them.");
    }).finally(() => { if (current) setLoadingSkills(false); });
    return () => { current = false; };
  }, [botId]);
  useEffect(() => () => { revision.current++; }, []);

  const prepare = async () => {
    if (!bot || busy) return;
    const request = ++revision.current;
    setBusy(true); setError(""); setPreview(""); setReviewed(false);
    try {
      const result = await api("/api/teams/export", { method: "POST", body: JSON.stringify({
        format: "package", name: bot.name, botIds: [bot.id], skillIds: selectedSkills,
      }) });
      if (request === revision.current) setPreview(result.markdown);
    } catch (cause) {
      if (request === revision.current) setError(cause instanceof Error ? cause.message : "Could not prepare this bot.");
    } finally { if (request === revision.current) setBusy(false); }
  };

  return <section className="mx-auto max-w-2xl space-y-5">
    <div><h3 className="text-[17px] font-semibold text-ink">Share your bot</h3>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">Create a portable setup someone else can inspect and install. Choose a bot, include the skills you want, then review the exact file.</p></div>
    <label className="block text-[13px] font-medium text-ink">Bot
      <select aria-label="Bot to share" value={botId} onChange={(event) => { invalidate(); setBotId(event.target.value); setSelectedSkills([]); }} className="mt-2 block w-full rounded-xl border border-hairline bg-card px-3 py-2.5">
        <option value="">Choose a bot</option>{bots.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    {bot && <div><h4 className="text-[13px] font-medium text-ink">Include skills</h4>
      {loadingSkills ? <p className="mt-2 text-[13px] text-ink-secondary">Loading skills…</p> : skills.length ? <div className="mt-2 divide-y divide-hairline/40">{skills.map((skill) => <label key={skill.name} className="flex items-start gap-3 py-3 text-[13px]">
        <input type="checkbox" className="mt-1" checked={selectedSkills.includes(skill.name)} onChange={(event) => { invalidate(); setSelectedSkills((items) => event.target.checked ? [...items, skill.name] : items.filter((name) => name !== skill.name)); }} />
        <span><span className="font-medium text-ink">{skill.name}</span><span className="mt-0.5 block text-ink-secondary">{skill.description}</span></span>
      </label>)}</div> : <p className="mt-2 text-[13px] text-ink-secondary">No skills selected.</p>}
    </div>}
    <p className="rounded-xl bg-raised/50 px-4 py-3 text-[13px] leading-relaxed text-ink-secondary">Includes profile, standing instructions, playbooks and selected skills. Chats, memory, saved credentials, permission grants, rooms and schedules stay out. Instructions and skills are copied verbatim and may contain private details.</p>
    <button type="button" className="ui-button" disabled={!bot || busy || loadingSkills} onClick={() => void prepare()}>{busy && <Loader2 size={14} className="animate-spin" />}Preview package</button>
    {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    {preview && bot && <div className="space-y-3">
      <label className="block text-[13px] font-medium text-ink">Package contents
        <textarea readOnly aria-label="Package contents" value={preview} className="mt-2 h-72 w-full resize-y rounded-xl border border-hairline bg-inset p-3 font-mono text-[12px] leading-relaxed" />
      </label>
      <label className="flex items-start gap-2 text-[13px] text-ink"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} className="mt-1" />I reviewed the exact file above and it contains no private details.</label>
      <button type="button" className="ui-button" disabled={!reviewed} onClick={() => downloadSnippetFile(`${bot.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bot"}.md`, preview)}><Download size={14} />Download bot</button>
      <p className="text-[12px] text-ink-secondary">If you edit the source instructions, generate a new preview before downloading. Downloading does not publish the file. The recipient can preview it under Import.</p>
    </div>}
  </section>;
}
