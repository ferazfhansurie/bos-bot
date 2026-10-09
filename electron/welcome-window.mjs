// The "say hi to firaz" window loads firaz's own server (a guest session in a
// single room), so it is remote content: only https links under
// bos.aihlete.com load in it, and the guest cookie lives in its own
// persistent partition, never the app's.

export const WELCOME_PARTITION = "persist:bos-welcome";
const WELCOME_HOST = /^(?:[a-z0-9-]+\.)*bos\.aihlete\.com$/;
/** A chat page may ask to notify and to copy; nothing else. */
const WELCOME_PERMISSIONS = new Set(["notifications", "clipboard-sanitized-write"]);

/** The URL to load, or throws. Accepts only https under bos.aihlete.com. */
export function welcomeWindowUrl(raw) {
  if (Object.prototype.toString.call(raw) !== "[object String]" || raw.length > 2048) {
    throw new Error("The welcome link is invalid");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The welcome link is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || !WELCOME_HOST.test(url.hostname)) {
    throw new Error("The welcome link is not a BOS link");
  }
  return url;
}

export function sameWelcomeOrigin(target, origin) {
  try {
    return new URL(target).origin === origin;
  } catch {
    return false;
  }
}

export function welcomePermissionAllowed(permission, requestingUrl, origin) {
  return WELCOME_PERMISSIONS.has(permission) && sameWelcomeOrigin(requestingUrl, origin);
}
