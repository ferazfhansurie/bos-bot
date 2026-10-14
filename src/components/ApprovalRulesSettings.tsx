import { useState } from "react";
import { t } from "@/lib/i18n";
import { revokeApprovalRule, useApprovalRules } from "@/lib/approval-rules";
import { approvalRuleLabel } from "../../shared/approval-rules";
import { useStore } from "@/state/store";
import { Card, SettingRow } from "./SettingsPrimitives";

/** Every "approve these for me" rule the person made, with revoke. */
export function ApprovalRulesSettings() {
  const { state, dispatch } = useStore();
  const rules = useApprovalRules();
  const [revoking, setRevoking] = useState<string | null>(null);
  const revoke = (id: string) => {
    setRevoking(id);
    revokeApprovalRule(id)
      .catch((error) => {
        dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
        window.setTimeout(() => dispatch({ type: "error", message: null }), 6000);
      })
      .finally(() => setRevoking(null));
  };
  return (
    <Card title={t("approvalRules.title")} subtitle={t("approvalRules.subtitle")}>
      <div>
        {rules && rules.length === 0 && <p className="px-1 text-[13px] text-ink-secondary">{t("approvalRules.empty")}</p>}
        {rules?.map((rule) => {
          const bot = state.bots.find((candidate) => candidate.id === rule.botId);
          const scope = rule.threadId ? t("approvalRules.scopeThread") : t("approvalRules.scopeBot");
          return (
            <SettingRow key={rule.id} title={approvalRuleLabel(rule)} subtitle={`${bot?.name ?? rule.botId} · ${scope}`}>
              <button type="button" className="ui-button" disabled={revoking === rule.id} onClick={() => revoke(rule.id)}>
                {t("approvalRules.revoke")}
              </button>
            </SettingRow>
          );
        })}
      </div>
    </Card>
  );
}
