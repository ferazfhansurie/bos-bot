// Settings → Engines → Add an engine → Any other model by API key. The last,
// collapsed option under the agent engines. Pick a provider, paste its API key, pick
// (or type) a model, add. Every provider here speaks the OpenAI-compatible
// API, so the new connection lists all of that key's models in the picker.
import { useState } from "react";
import { Check, ChevronDown, KeyRound, Loader2, Plus } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { API_PROVIDERS, type ApiProviderId } from "../../shared/api-providers";

const field = "w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent disabled:opacity-50";

/** An `api-…` connection added here (and so removable here). */
export function isApiConnection(instance: Pick<InstanceInfo, "instanceId" | "driverKind">): boolean {
  return instance.driverKind === "api-key" && /^api-[\w-]+$/u.test(instance.instanceId);
}

export function AddModelCard() {
  const { refreshInstances } = useStore();
  const [provider, setProvider] = useState<ApiProviderId>("anthropic");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const preset = API_PROVIDERS.find((entry) => entry.id === provider);
  const custom = provider === "custom";
  const target = { provider, key: key.trim(), ...(custom ? { url: url.trim() } : {}) };
  const ready = Boolean(target.key) && (!custom || Boolean(target.url));

  const choose = (next: ApiProviderId) => {
    setProvider(next);
    setModels([]);
    setModel("");
    setError(null);
    setAdded(null);
  };

  const loadModels = async () => {
    if (!ready || loading) return;
    setLoading(true);
    setError(null);
    try {
      const body = await api("/api/instances/api-models", { method: "POST", body: JSON.stringify(target) });
      const list: Array<{ id: string; label: string }> = Array.isArray(body?.models) ? body.models : [];
      setModels(list);
      if (!model && list[0]) setModel(list[0].id);
    } catch (cause) {
      setModels([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  const add = async () => {
    if (!ready || !model.trim() || adding) return;
    setAdding(true);
    setError(null);
    try {
      await api("/api/instances/api-connections", { method: "POST", body: JSON.stringify({ ...target, model: model.trim() }) });
      await Promise.resolve(refreshInstances()).catch(() => {});
      setAdded(preset?.label ?? t("engines.addModel.custom"));
      setKey("");
      setUrl("");
      setModel("");
      setModels([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAdding(false);
    }
  };

  return (
    <details className="group/addmodel col-span-full min-w-0 rounded-2xl border border-hairline/40 bg-card transition-colors open:border-hairline/70 hover:border-hairline/70">
      <summary className="cursor-pointer list-none rounded-2xl p-4 outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-hairline/30 bg-panel text-ink-secondary">
            <KeyRound size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold tracking-[-0.015em] text-ink">{t("engines.addModel.title")}</h3>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("engines.addModel.subtitle")}</p>
          </div>
          <ChevronDown size={16} aria-hidden="true" className="shrink-0 text-ink-secondary transition-transform group-open/addmodel:rotate-180 motion-reduce:transition-none" />
        </div>
      </summary>
      <div className="min-w-0 border-t border-hairline/40 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-secondary">{t("engines.addModel.provider")}</span>
            <select value={provider} onChange={(event) => choose(event.target.value as ApiProviderId)} className={field}>
              {API_PROVIDERS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              <option value="custom">{t("engines.addModel.custom")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center justify-between gap-2 text-[12px] font-medium text-ink-secondary">
              {t("engines.addModel.key")}
              {preset && <a href={preset.keyUrl} target="_blank" rel="noreferrer" className="font-normal text-accent hover:underline">{t("engines.addModel.getKey")}</a>}
            </span>
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(event) => { setKey(event.target.value); setModels([]); setAdded(null); }}
              onBlur={() => { if (ready && !models.length) void loadModels(); }}
              placeholder={t("engines.addModel.keyPlaceholder")}
              className={field}
            />
          </label>
          {custom && (
            <label className="flex flex-col gap-1.5 sm:col-span-2">
              <span className="text-[12px] font-medium text-ink-secondary">{t("engines.addModel.url")}</span>
              <input
                value={url}
                inputMode="url"
                onChange={(event) => { setUrl(event.target.value); setModels([]); }}
                placeholder="https://api.example.com/v1"
                className={field}
              />
            </label>
          )}
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="flex items-center justify-between gap-2 text-[12px] font-medium text-ink-secondary">
              {t("engines.addModel.model")}
              <button type="button" disabled={!ready || loading} onClick={() => void loadModels()} className="font-normal text-accent hover:underline disabled:opacity-40 disabled:no-underline">
                {loading ? t("engines.addModel.loading") : t("engines.addModel.load")}
              </button>
            </span>
            {models.length > 0 ? (
              <select value={model} onChange={(event) => setModel(event.target.value)} className={field}>
                {models.map((entry) => <option key={entry.id} value={entry.id}>{entry.label === entry.id ? entry.id : `${entry.label} · ${entry.id}`}</option>)}
              </select>
            ) : (
              <input value={model} onChange={(event) => setModel(event.target.value)} placeholder={t("engines.addModel.modelPlaceholder")} className={field} />
            )}
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={!ready || !model.trim() || adding}
            onClick={() => void add()}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {adding ? t("engines.addModel.adding") : t("engines.addModel.add")}
          </button>
          {added && !error && (
            <span role="status" className="flex items-center gap-1.5 text-[12.5px] text-success">
              <Check size={13} /> {t("engines.addModel.added", { name: added })}
            </span>
          )}
        </div>
        {error && <p role="alert" className="mt-3 text-[12.5px] text-danger">{error}</p>}
      </div>
    </details>
  );
}

export function RemoveApiConnection({ instance }: { instance: InstanceInfo }) {
  const { state, refreshInstances } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inUse = state.bots.some((bot) => bot.modelSelection.instanceId === instance.instanceId);
  const remove = async () => {
    if (busy || inUse) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, { method: "DELETE" });
      await Promise.resolve(refreshInstances()).catch(() => {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={busy || inUse}
        title={inUse ? t("engines.addModel.inUse") : undefined}
        onClick={() => void remove()}
        className="rounded-lg border border-hairline/40 px-3 py-1 text-[12px] text-ink-secondary hover:bg-raised/50 hover:text-danger disabled:opacity-40"
      >
        {busy ? t("engines.addModel.removing") : t("engines.addModel.remove")}
      </button>
      {inUse && <p className="mt-1.5 text-[11.5px] text-ink-secondary">{t("engines.addModel.inUse")}</p>}
      {error && <p role="alert" className="mt-1.5 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
