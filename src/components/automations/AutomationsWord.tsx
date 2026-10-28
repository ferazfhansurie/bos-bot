// "Automations" under v3, the existing "Routines" label otherwise. A component
// so a large parent can switch the word without taking a new hook itself.
import { t } from "@/lib/i18n";
import { useV3 } from "@/lib/v3";

export function AutomationsWord() {
  return <>{useV3() ? "Automations" : t("computer.tab.routines")}</>;
}
