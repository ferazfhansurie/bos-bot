import { useEffect, useRef, useState } from 'react';
import { api, type Bot } from '@/state/store';

type Status = { configured: boolean; ready: boolean; error?: string; pending: boolean; interrupted: number; connection: null | { username: string; members: number; groups: number } };
export function ChannelsSection({ bot }: { bot: Bot }) {
  const revision = useRef(0);
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; invite: boolean }>();
  const path = `/api/bots/${bot.id}/telegram-channel`;
  useEffect(() => {
    let active = true;
    const load = async () => { const version = revision.current; try { const value = await api(path); if (active && revision.current === version) { setStatus(value); setError(''); } } catch { if (active && revision.current === version) setError('could not load channels. try reopening this panel.'); } };
    void load(); const timer = setInterval(() => void load(), 4000);
    return () => { active = false; clearInterval(timer); };
  }, [path]);
  const action = async (kind: 'connect' | 'invite' | 'disconnect') => {
    revision.current++; setBusy(true); setError('');
    try {
      const result = await api(kind === 'disconnect' ? path : `${path}/${kind}`, { method: kind === 'disconnect' ? 'DELETE' : 'POST' });
      if (kind === 'disconnect') { setStatus(result); setLink(undefined); }
      else setLink({ url: result.url, invite: kind === 'invite' });
    } catch { setError('could not update the channel. check the connection and try again.'); }
    finally { revision.current++; setBusy(false); }
  };
  const button = 'rounded-lg border border-border px-3 py-2 text-sm text-ink disabled:opacity-50';
  return <div className="flex flex-col gap-3 text-sm text-ink">
    <p className="text-ink-secondary">talk to {bot.name} from your other chats.</p>
    <div className="rounded-xl border border-border p-4 flex flex-col gap-3">
      <div className="font-medium">telegram</div>
      {!status && !error && <p role="status">loading channels…</p>}
      {status && !status.configured && <p>telegram needs a management bot set up once on this server. after setup, connect here without copying tokens.</p>}
      {status?.configured && !status.connection && <>
        <p>connect your own telegram bot. only paired people can talk to it; they can use this bot’s configured tools and permissions.</p>
        <button className={button} disabled={busy} onClick={() => void action('connect')}>{status.pending ? 'start a new connection' : 'connect telegram'}</button>
      </>}
      {status?.connection && <>
        <a className="underline" href={`https://t.me/${status.connection.username}`} target="_blank" rel="noreferrer">@{status.connection.username}</a>
        <p>{status.connection.members} paired people · {status.connection.groups} groups</p>
        <p className="text-ink-secondary">to connect a group, add this bot and send /connect@{status.connection.username} as a group admin. only paired people can use it.</p>
        <p className="text-ink-secondary">text chats are supported. approvals stay in bos.</p>
        <button className={button} disabled={busy} onClick={() => void action('invite')}>create private invite</button>
        <button className={button} disabled={busy} onClick={() => void action('disconnect')}>disconnect telegram</button>
      </>}
      {link && (!status?.connection || link.invite) && <div className="flex flex-col gap-2">
        <a className="underline" href={link.url} target="_blank" rel="noreferrer">{link.invite ? 'open private invite' : 'continue in telegram'}</a>
        {link.invite && <><p>one person, valid for 15 minutes. only share with someone allowed to use this bot.</p><input aria-label="private telegram invite" readOnly value={link.url} className="w-full rounded border border-border bg-card p-2" onFocus={e => e.currentTarget.select()} /></>}
      </div>}
      {status?.interrupted ? <p role="status">{status.interrupted} interrupted deliveries. check the conversation in bos before sending those requests again.</p> : null}
      {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
    </div>
  </div>;
}
