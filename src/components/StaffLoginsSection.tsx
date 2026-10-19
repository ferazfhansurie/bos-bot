// App settings → People → Staff logins: a username + password for people who
// will never pair a device or own a work email (a clinic's front desk, a
// client's sales team). The server generates the password and shows it once;
// the owner hands it over with the sign-in address. Resetting or removing a
// login signs that person out everywhere.
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, Loader2, Plus, RefreshCw } from "lucide-react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { readSessionState, type SessionState } from "../lib/session";
import { canPairDevices } from "./ServerPairingCard";
import { Card } from "./SettingsPrimitives";

export interface StaffLogin {
  id: string;
  name: string;
  username: string;
  phone?: string;
  role: "member" | "admin";
  createdAt: number;
  passwordSetAt: number;
}

/** A suggested username from a display name: "Uteh Rahman" → "uteh.rahman". */
export function suggestUsername(name: string): string {
  return name.trim().toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s.-]/gu, "").replace(/[^a-z0-9\s.-]/g, "").trim().replace(/\s+/g, ".").slice(0, 40);
}

/** What the owner sends the person: where to go and what to type. */
export function handoverText(base: string, login: StaffLogin, password: string): string {
  return [`${t("staffLogins.handoverOpen")} ${base.replace(/\/+$/, "")}/pair`, `${t("staffLogins.username")}: ${login.username}`, `${t("staffLogins.password")}: ${password}`].join("\n");
}

export function StaffLoginsSection() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [logins, setLogins] = useState<StaffLogin[]>([]);
  const [base, setBase] = useState<string>(typeof window !== "undefined" ? window.location.origin : "");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<StaffLogin["role"]>("member");
  const [issued, setIssued] = useState<{ login: StaffLogin; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [listed, domain] = await Promise.all([api("/api/auth/password-logins"), api("/api/auth/pairing").catch(() => null)]);
      setLogins(Array.isArray(listed?.logins) ? listed.logins : []);
      if (typeof domain?.publicUrl === "string" && domain.publicUrl) setBase(domain.publicUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void readSessionState().then((state) => {
      setSession(state);
      if (canPairDevices(state)) void load();
    });
  }, [load]);

  const run = async (work: () => Promise<{ login: StaffLogin; password: string } | null>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      if (result) setIssued(result);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const create = () => run(async () => {
    const created = await api("/api/auth/password-logins", { method: "POST", body: JSON.stringify({ name, username, phone: phone.trim() || undefined, role }) });
    setName("");
    setUsername("");
    setUsernameEdited(false);
    setPhone("");
    return created;
  });

  if (!canPairDevices(session)) return null;
  const field = "rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-50";
  return (
    <Card title={t("staffLogins.title")} subtitle={t("staffLogins.subtitle")}>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <input
          value={name}
          onChange={(e) => { setName(e.target.value); if (!usernameEdited) setUsername(suggestUsername(e.target.value)); }}
          placeholder={t("staffLogins.name")}
          aria-label={t("staffLogins.name")}
          disabled={busy}
          className={cn(field, "min-w-[10rem] flex-1")}
        />
        <input
          value={username}
          onChange={(e) => { setUsername(e.target.value); setUsernameEdited(true); }}
          placeholder={t("staffLogins.username")}
          aria-label={t("staffLogins.username")}
          autoCapitalize="none"
          spellCheck={false}
          disabled={busy}
          className={cn(field, "w-[9rem]")}
        />
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder={t("staffLogins.phone")}
          aria-label={t("staffLogins.phone")}
          inputMode="tel"
          disabled={busy}
          className={cn(field, "w-[9rem]")}
        />
        <select value={role} onChange={(e) => setRole(e.target.value as StaffLogin["role"])} aria-label={t("people.colRole")} disabled={busy} className="rounded-lg border border-hairline/40 bg-inset px-2 py-2 text-[12.5px] text-ink focus:border-hairline focus:outline-none">
          <option value="member">{t("people.roleMember")}</option>
          <option value="admin">{t("people.roleAdmin")}</option>
        </select>
        <button type="submit" disabled={busy || !name.trim() || !username.trim()} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-60">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}{t("staffLogins.add")}
        </button>
        <button type="button" onClick={() => void load()} disabled={loading || busy} aria-label={t("people.refresh")} title={t("people.refresh")} className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50"><RefreshCw size={13} className={cn(loading && "animate-spin")} /></button>
      </form>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">{t("staffLogins.hint")}</p>
      {issued && <IssuedPassword text={handoverText(base, issued.login, issued.password)} onDone={() => setIssued(null)} />}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
      <div className="mt-4 flex flex-col">
        {logins.length === 0 ? (
          <p className="text-[13px] text-ink-secondary">{t("staffLogins.empty")}</p>
        ) : (
          logins.map((login) => (
            <div key={login.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 border-b border-hairline/20 py-2 text-[13px]">
              <span className="min-w-0">
                <span className="block truncate text-ink">{login.name}</span>
                <span className="block truncate text-[11.5px] text-ink-secondary">{login.username}{login.phone ? ` · +${login.phone}` : ""}</span>
              </span>
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", login.role === "admin" ? "bg-accent/15 text-accent" : "bg-control text-ink-secondary")}>
                {login.role === "admin" ? t("people.roleAdmin") : t("people.roleMember")}
              </span>
              <span className="flex items-center justify-end gap-3 text-[12px]">
                <button type="button" disabled={busy} onClick={() => void run(() => api(`/api/auth/password-logins/${login.id}/reset`, { method: "POST", body: "{}" }))} className="flex items-center gap-1 text-ink-secondary hover:text-ink disabled:opacity-50">
                  <KeyRound size={12} />{t("staffLogins.reset")}
                </button>
                <button type="button" disabled={busy} onClick={() => void run(async () => { await api(`/api/auth/password-logins/${login.id}`, { method: "DELETE" }); return null; })} className="text-danger hover:underline disabled:opacity-50">{t("people.remove")}</button>
              </span>
            </div>
          ))
        )}
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-secondary">{t("staffLogins.note")}</p>
    </Card>
  );
}

function IssuedPassword({ text, onDone }: { text: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      /* the text stays selectable when clipboard access is blocked */
    }
  };
  return (
    <div className="mt-3 rounded-lg border border-accent/30 bg-inset p-3 text-[12.5px]">
      <div className="mb-1 text-ink-secondary">{t("staffLogins.issued")}</div>
      <pre className="select-all whitespace-pre-wrap break-all font-mono text-[12.5px] text-ink">{text}</pre>
      <div className="mt-2 flex items-center gap-3">
        <button type="button" onClick={() => void copy()} className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}{copied ? t("people.copied") : t("people.copy")}
        </button>
        <button type="button" onClick={onDone} className="text-[12px] text-ink-secondary underline">{t("staffLogins.done")}</button>
      </div>
    </div>
  );
}
