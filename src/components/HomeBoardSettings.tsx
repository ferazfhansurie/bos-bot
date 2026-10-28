import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { setHomeBotHidden, useHomeHiddenBots } from "@/lib/home-filter";
import { homeBoardBots } from "@/lib/v3-home";
import { BotAvatar } from "./Avatar";
import { Card, SettingRow, Switch } from "./SettingsPrimitives";

/** Which bots show on the "today" board. Stored on this device; the bots,
 * their threads and the sidebar stay as they are. */
export function HomeBoardSettings() {
  const { state } = useStore();
  const hidden = useHomeHiddenBots();
  const bots = homeBoardBots(state.bots, state.routines, state.routineRuns);
  if (!bots.length) return null;
  return (
    <Card title={t("v3.home.settings.title")} subtitle={t("v3.home.settings.subtitle")}>
      <div className="max-h-[360px] overflow-y-auto px-4">
        {bots.map((bot) => {
          const shown = !hidden.includes(bot.id);
          const label = bot.homeLink ? `${bot.name} · ${bot.homeLink.name}` : bot.name;
          return (
            <SettingRow key={bot.id} title={label} subtitle={bot.title || undefined}>
              <div className="flex items-center gap-2">
                <BotAvatar bot={bot} size={22} />
                <Switch checked={shown} aria-label={t("v3.home.settings.show", { name: label })} onClick={() => setHomeBotHidden(bot.id, shown)} />
              </div>
            </SettingRow>
          );
        })}
      </div>
    </Card>
  );
}
