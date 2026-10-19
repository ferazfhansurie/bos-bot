/** Reserve the browser window while the Connect click still has activation.
 * A failed reservation never falls back to another asynchronous popup. The
 * caller keeps the returned OAuth URL in an ordinary Continue link instead. */
export function reserveConnectionWindow() {
  const external = window.ogb?.openExternal;
  let reserved = external ? null : window.open("about:blank", "_blank");
  let cancelled = false;
  if (reserved) reserved.opener = null;
  return {
    cancel() {
      cancelled = true;
      reserved?.close();
      reserved = null;
    },
    async navigate(url: string): Promise<boolean> {
      if (cancelled) return false;
      if (external) return (await external(url)) !== false;
      if (!reserved || reserved.closed) return false;
      const opened = reserved;
      opened.location.replace(url);
      reserved = null;
      return true;
    },
  };
}
