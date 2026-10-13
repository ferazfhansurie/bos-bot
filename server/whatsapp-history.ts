// Stable diagnostics without exposing provider errors, chat text or credentials.
export class WhatsAppHistoryError extends Error {
  readonly code = "bos_whatsapp_history";
  readonly status: number;
  readonly stage: string;
  constructor(status: number, stage: string) {
    super(`WhatsApp history failed at ${stage}`);
    this.status = status;
    this.stage = stage;
  }
}

/** The adapter is bundled separately from index.ts, so instanceof alone
 * cannot recognize its errors. Validate only stable, non-sensitive fields. */
export function historyFailure(error: unknown): WhatsAppHistoryError {
  if (error instanceof WhatsAppHistoryError) return error;
  const value = error as { code?: unknown; stage?: unknown } | null;
  if (value?.code === "bos_whatsapp_history" && typeof value.stage === "string") {
    const statuses: Record<string, number> = { not_linked: 409, account_or_scope_changed: 403, chat_lookup: 502, history_chat_lookup: 502, fetch_messages: 502, capture_messages: 502, native_history: 502 };
    if (Object.hasOwn(statuses, value.stage)) return new WhatsAppHistoryError(statuses[value.stage], value.stage);
  }
  return new WhatsAppHistoryError(502, "native_history");
}

export async function historyStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch { throw new WhatsAppHistoryError(502, stage); }
}
