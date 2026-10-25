import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { disableWebPush, enableWebPush, webPushState, webPushSupported, type WebPushState } from "@/lib/web-push";
import {
  NOTIFY_SOUNDS,
  setAttentionPreferences,
  useAttentionPreferences,
  type DoneNotifyMode,
  type FollowUpMode,
  type NotifySound,
} from "@/lib/attention-preferences";
import { Card, SettingRow, Switch } from "./SettingsPrimitives";

const SELECT_CLASS =
  "min-h-8 w-full max-w-[240px] rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink focus:border-focus";

function Choice<T extends string>({
  value,
  label,
  options,
  onChange,
}: {
  value: T;
  label: string;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <select value={value} aria-label={label} onChange={(event) => onChange(event.target.value as T)} className={SELECT_CLASS}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function soundLabel(sound: NotifySound): string {
  if (sound === "none") return t("attention.sound.none");
  if (sound === "default") return t("attention.sound.default");
  return sound.toLowerCase();
}

/** This browser's push subscription (plain browser tabs only). */
function BrowserNotifications() {
  const [state, setState] = useState<WebPushState | "busy" | "failed">("busy");
  useEffect(() => { void webPushState().then(setState, () => setState("off")); }, []);
  const on = state === "on";
  return (
    <SettingRow
      title={t("attention.browser")}
      subtitle={t("attention.browser.subtitle")}
      message={state === "denied" ? <span className="text-ink-secondary">{t("attention.browser.denied")}</span>
        : state === "failed" ? <span className="text-danger">{t("attention.browser.failed")}</span> : undefined}
    >
      <Switch
        checked={on}
        disabled={state === "busy" || state === "denied"}
        aria-label={t("attention.browser")}
        onClick={() => {
          setState("busy");
          // asked inside the click: browsers refuse a later, unprompted ask
          void (on ? disableWebPush() : enableWebPush()).then(setState, () => setState("failed"));
        }}
      />
    </SettingRow>
  );
}

/** Per-kind notification switches, when "done" may interrupt, the sound,
 * and what a send does while a turn is running. Stored on this device. */
export function AttentionSettings() {
  const prefs = useAttentionPreferences();
  // System sounds are the macOS ones; elsewhere only none or the default.
  const sounds = window.ogb?.platform === "darwin" ? NOTIFY_SOUNDS : NOTIFY_SOUNDS.filter((sound) => sound === "none" || sound === "default");
  const kinds = [
    { key: "approval", title: t("attention.approval"), subtitle: t("attention.approval.subtitle") },
    { key: "question", title: t("attention.question"), subtitle: t("attention.question.subtitle") },
    { key: "message", title: t("attention.message"), subtitle: t("attention.message.subtitle") },
  ] as const;
  return (
    <Card title={t("attention.title")} subtitle={t("attention.subtitle")}>
      <div>
        {webPushSupported() && <BrowserNotifications />}
        {kinds.map((kind) => (
          <SettingRow key={kind.key} title={kind.title} subtitle={kind.subtitle}>
            <Switch
              checked={prefs[kind.key]}
              aria-label={kind.title}
              onClick={() => setAttentionPreferences({ [kind.key]: !prefs[kind.key] })}
            />
          </SettingRow>
        ))}
        {window.ogb?.platform === "darwin" && window.ogb.notch && (
          <SettingRow title={t("attention.notch")} subtitle={t("attention.notch.subtitle")}>
            <Switch checked={prefs.notch} aria-label={t("attention.notch")} onClick={() => setAttentionPreferences({ notch: !prefs.notch })} />
          </SettingRow>
        )}
        <SettingRow title={t("attention.done")} subtitle={t("attention.done.subtitle")}>
          <Choice<DoneNotifyMode>
            value={prefs.done}
            label={t("attention.done")}
            onChange={(done) => setAttentionPreferences({ done })}
            options={[
              { value: "unfocused", label: t("attention.done.unfocused") },
              { value: "always", label: t("attention.done.always") },
              { value: "off", label: t("attention.done.off") },
            ]}
          />
        </SettingRow>
        <SettingRow title={t("attention.sound")} subtitle={t("attention.sound.subtitle")}>
          <Choice<NotifySound>
            value={sounds.includes(prefs.sound) ? prefs.sound : "default"}
            label={t("attention.sound")}
            onChange={(sound) => setAttentionPreferences({ sound })}
            options={sounds.map((sound) => ({ value: sound, label: soundLabel(sound) }))}
          />
        </SettingRow>
        <SettingRow title={t("attention.followUps")} subtitle={t("attention.followUps.subtitle")}>
          <Choice<FollowUpMode>
            value={prefs.followUps}
            label={t("attention.followUps")}
            onChange={(followUps) => setAttentionPreferences({ followUps })}
            options={[
              { value: "queue", label: t("attention.followUps.queue") },
              { value: "steer", label: t("attention.followUps.steer") },
            ]}
          />
        </SettingRow>
      </div>
    </Card>
  );
}
