/** Only the supervised server's private port reaches this handler. No renderer IPC. */
export function createComputerPreviewHandler({ capture, allowed, isCurrent, send, now = Date.now }) {
  let pending;
  return (message) => {
    if (message?.type !== "bos:computer-preview") return false;
    if (typeof message.requestId !== "string" || message.requestId.length > 100 || !Number.isFinite(message.deadline) || message.deadline < now() || message.deadline > now() + 10_000) return true;
    const request = async () => {
      if (!isCurrent() || !allowed()) throw new Error("Screen Recording permission is required for this computer's preview");
      pending ??= Promise.resolve().then(capture).finally(() => { pending = null; });
      const png = await pending;
      if (!isCurrent() || !allowed() || message.deadline < now()) throw new Error("This computer's preview is no longer available");
      return png;
    };
    void request().then(png => {
      if (isCurrent()) send({ type: "bos:computer-preview-result", requestId: message.requestId, ok: true, png });
    }, error => {
      if (isCurrent()) send({ type: "bos:computer-preview-result", requestId: message.requestId, ok: false, error: error.message });
    });
    return true;
  };
}
