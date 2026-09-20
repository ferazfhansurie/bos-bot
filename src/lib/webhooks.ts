import type { WebhookTrigger, WebhookTriggerInput } from "../../shared/webhooks";

/** Webhook wire shapes — triggers and delivery attempts as they ride the REST
 * snapshot and the `webhook` / `webhook.attempt` live frames — live in
 * shared/webhooks.ts now (part of the wire model); re-exported here so
 * existing client imports keep working. */
export type {
  WebhookTrigger,
  WebhookTriggerInput,
  WebhookVerificationSample,
  WebhookAttemptOutcome,
  WebhookAttempt,
  WebhookIngressStatus,
} from "../../shared/webhooks";

export interface WebhookCredential {
  endpointUrl: string;
  secret: string;
  /** Capability URL for senders that cannot configure an Authorization header. */
  url: string;
}

/** New local webhooks are ready to execute immediately. Editing an existing
 * webhook must preserve its current pause/verification state. */
export function webhookActivationDefaults(
  webhook?: Pick<WebhookTrigger, "enabled" | "verificationPending">,
): Pick<WebhookTriggerInput, "enabled" | "verificationPending"> {
  return {
    enabled: webhook?.enabled ?? true,
    verificationPending: webhook?.verificationPending ?? false,
  };
}
