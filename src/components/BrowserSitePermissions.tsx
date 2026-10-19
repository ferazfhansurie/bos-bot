import { useState } from 'react';
import type { BrowserLibrary } from '@/lib/primary-browser-types';

export function BrowserSitePermissions({ rules = {}, save, askFullAccess = false, saveAskFullAccess }: {
  rules?: BrowserLibrary['agentRules'];
  save: (origin: string, rule: NonNullable<BrowserLibrary['agentRules']>[string] | null) => Promise<unknown>;
  askFullAccess?: boolean;
  saveAskFullAccess?: (ask: boolean) => Promise<unknown>;
}) {
  const [origin, setOrigin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = async (site: string, rule: NonNullable<BrowserLibrary['agentRules']>[string] | null) => {
    setBusy(true); setError('');
    try { await save(site, rule); setOrigin(''); } catch (reason) { setError(reason instanceof Error ? reason.message : 'could not save site permissions'); } finally { setBusy(false); }
  };
  return <section className="flex flex-col gap-3" aria-label="agent site permissions">
    <h3 className="font-medium">agent site permissions</h3>
    {saveAskFullAccess && <label className="flex items-start gap-2 rounded bg-raised p-3 text-xs">
      <input type="checkbox" className="mt-0.5" checked={!askFullAccess} disabled={busy} onChange={event => { const ask = !event.target.checked; setBusy(true); setError(''); void saveAskFullAccess(ask).catch(reason => setError(reason instanceof Error ? reason.message : 'could not save')).finally(() => setBusy(false)); }} />
      <span><span className="block font-medium">let bots act without asking</span><span className="text-ink-secondary">a bot with full access browses, submits forms, uploads and downloads on any site without a prompt. sites you block below stay blocked.</span></span>
    </label>}
    <p className="text-xs text-ink-secondary">browsing is allowed by default. downloads and uploads or form submissions ask each time{saveAskFullAccess && !askFullAccess ? ', unless the bot has full access' : ''}. these rules apply while a bot controls the tab.</p>
    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void change(origin, { browse: 'allow', download: 'ask', upload: 'ask' }); }}>
      <input aria-label="website origin" placeholder="https://example.com" value={origin} maxLength={2048} onChange={event => setOrigin(event.target.value)} className="min-w-0 flex-1 rounded bg-raised p-2" />
      <button disabled={busy || !origin.trim()} className="rounded bg-control p-2 disabled:opacity-50">add site</button>
    </form>
    {Object.entries(rules).map(([site, rule]) => <div key={site} className="rounded border border-hairline/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2"><span className="break-all text-xs">{site}</span><button disabled={busy} onClick={() => void change(site, null)} className="text-xs text-ink-secondary">reset</button></div>
      <div className="grid grid-cols-3 gap-2">{(['browse', 'download', 'upload'] as const).map(action => <label key={action} className="text-xs">{action}<select aria-label={`${action} on ${site}`} value={rule[action]} disabled={busy} onChange={event => void change(site, { ...rule, [action]: event.target.value })} className="mt-1 w-full rounded bg-raised p-1.5"><option value="allow">allow</option><option value="ask">ask</option><option value="block">block</option></select></label>)}</div>
    </div>)}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </section>;
}
