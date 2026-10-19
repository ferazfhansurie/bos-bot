/** Named events use an authenticated relay. A relay must validate its upstream
 * provider signature/account before forwarding; BOS does not create subscriptions. */
export type RoutineEventSource =
  | { kind: "github-pr" | "github-ci"; repository: string; action?: string }
  | { kind: "slack-mention"; teamId: string; channelId: string };
export const ROUTINE_EVENT_PRESETS = [
  { kind: "github-pr", label: "GitHub pull request", event: "pull_request" },
  { kind: "github-ci", label: "GitHub CI workflow", event: "workflow_run" },
  { kind: "slack-mention", label: "Slack app mention", event: "app_mention" },
] as const;
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function matchesRoutineEvent(source: RoutineEventSource, eventName: string | undefined, payload: unknown): boolean {
  const body = object(payload);
  if (source.kind === "slack-mention") {
    const event = object(body.event);
    return (eventName === "app_mention" || eventName === "event_callback") && event.type === "app_mention"
      && body.team_id === source.teamId && event.channel === source.channelId;
  }
  const expected = source.kind === "github-pr" ? "pull_request" : "workflow_run";
  return eventName === expected && object(body.repository).full_name === source.repository
    && (source.kind === "github-pr" ? typeof object(body.pull_request).number === "number" : typeof object(body.workflow_run).id === "number")
    && (!source.action || body.action === source.action);
}
