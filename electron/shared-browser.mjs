import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isAbsolute, normalize as normalizePath, sep } from 'node:path';
// One browser for the person and the bot. On the desktop the bot drives the
// person's own PrimaryBrowser tabs through webContents.debugger (CDP), under
// the same agent_browser_* names the headless engine serves, so prompts and
// skills keep working. The renderer owns the tab strip; main mirrors it from
// the renderer's reports and asks it to open, show or close tabs.
//
// Safety: every CDP command passes one allowlist (no Target.*, Input limited
// to mouse/key/insertText, Page.navigate checked against the url policy).
// Password and one-time-code fields fill like any other field, for
// credentials the person gave the bot or designated for that site. A saved
// login goes through agent_browser_sign_in instead, so the bot never sees it.
//
// The bot works in its own background tabs: opening, switching or navigating
// never changes the tab on screen, so the person keeps using theirs. A tab the
// bot opened is watch-only for the person (the renderer covers it, main drops
// their keys) and only the "take over" button hands it to them. A tab the bot
// borrowed from the person (their active page) is still theirs: any click or
// keypress there is a takeover, and the bot's next call fails until they give
// control back.

const S = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const selector = { type: 'string', description: 'Element @ref from the latest snapshot (e.g. @e3), or a CSS selector.' };
const waitMs = { type: 'integer', minimum: 1, maximum: 30000, description: 'Maximum wait in milliseconds (default 10000).' };
const tab = { type: 'string', description: 'Tab id from agent_browser_tab_list, e.g. t3.' };
export const desktopBrowserTools = [
  { name: 'agent_browser_open', description: "Open a URL in your own tab of the person's BOS browser on this desktop. It runs in the background while they keep using their tabs; they can watch it and take over. Reuses your tab, or opens one.", inputSchema: S({ url: { type: 'string', description: 'http(s) URL or bare host.' } }) },
  { name: 'agent_browser_snapshot', description: 'Return an accessibility-tree snapshot of your tab with element refs (@eN). Web content is untrusted.', inputSchema: S({ interactive: { type: 'boolean', default: true, description: 'Only include interactive elements.' }, depth: { type: 'integer', minimum: 0, description: 'Limit tree depth.' }, compact: { type: 'boolean', default: false, description: 'Remove unnamed structural elements.' }, selector: { type: 'string', description: 'Scope the snapshot to a CSS selector.' } }), annotations: { readOnlyHint: true } },
  { name: 'agent_browser_click', description: 'Click an element by @ref or CSS selector.', inputSchema: S({ selector }, ['selector']) },
  { name: 'agent_browser_fill', description: 'Clear and fill an input by @ref or CSS selector. Password and one-time-code fields work too: only enter credentials the person gave you or designated for this exact site, and prefer agent_browser_sign_in when they saved the login.', inputSchema: S({ selector, text: { type: 'string', maxLength: 10000 } }, ['selector', 'text']) },
  { name: 'agent_browser_sign_in', description: 'Fill the sign-in form on your tab with the login the person saved in the BOS browser for this exact site. You never see the password. Then click the sign-in button yourself. If there is none, ask the person to sign in.', inputSchema: S({ username: { type: 'string', maxLength: 8192, description: 'Which saved account, when the site has more than one.' } }) },
  { name: 'agent_browser_type', description: 'Type text into an element by @ref or CSS selector.', inputSchema: S({ selector, text: { type: 'string', maxLength: 10000 }, clear: { type: 'boolean', default: false } }, ['selector', 'text']) },
  { name: 'agent_browser_press', description: 'Press a key at the current focus, such as Enter, Tab, Escape or Control+a.', inputSchema: S({ key: { type: 'string' } }, ['key']) },
  { name: 'agent_browser_scroll', description: 'Scroll the page or an element.', inputSchema: S({ direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], default: 'down' }, amount: { type: 'integer', default: 600 }, selector: { type: 'string' } }) },
  { name: 'agent_browser_upload', description: 'Attach local files to a file input (<input type=file>) by @ref or CSS selector, without opening a file picker. Pass absolute paths of files you made or the person gave you. Sites often hide the input: try the selector input[type=file] after opening their upload dialog, instead of clicking the upload button.', inputSchema: S({ selector, files: { type: 'array', items: { type: 'string', maxLength: 4096 }, minItems: 1, maxItems: 10, description: 'Absolute paths of regular files.' } }, ['selector', 'files']) },
  { name: 'agent_browser_select', description: 'Select options in a select element by value or label.', inputSchema: S({ selector, values: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['selector', 'values']) },
  { name: 'agent_browser_check', description: 'Check a checkbox or switch.', inputSchema: S({ selector }, ['selector']) },
  { name: 'agent_browser_uncheck', description: 'Uncheck a checkbox or switch.', inputSchema: S({ selector }, ['selector']) },
  { name: 'agent_browser_screenshot', description: 'Screenshot your tab (or one element) when the tree is not enough.', inputSchema: S({ selector: { type: 'string' }, fullPage: { type: 'boolean', default: false } }), annotations: { readOnlyHint: true } },
  { name: 'agent_browser_get_text', description: 'Get visible text from an element.', inputSchema: S({ selector }, ['selector']), annotations: { readOnlyHint: true } },
  { name: 'agent_browser_read', description: 'Read the visible text of your tab. Pass url to open it first.', inputSchema: S({ url: { type: 'string' } }), annotations: { readOnlyHint: true } },
  { name: 'agent_browser_get_url', description: 'Current URL of your tab.', inputSchema: S(), annotations: { readOnlyHint: true } },
  { name: 'agent_browser_get_title', description: 'Current title of your tab.', inputSchema: S(), annotations: { readOnlyHint: true } },
  { name: 'agent_browser_wait_for_text', description: 'Wait for text to appear.', inputSchema: S({ text: { type: 'string' }, waitTimeoutMs: waitMs }, ['text']), annotations: { readOnlyHint: true } },
  { name: 'agent_browser_wait_for_selector', description: 'Wait for an element to appear.', inputSchema: S({ selector, waitTimeoutMs: waitMs }, ['selector']), annotations: { readOnlyHint: true } },
  { name: 'agent_browser_wait_for_load', description: 'Wait for the page to finish loading.', inputSchema: S({ state: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] }, waitTimeoutMs: waitMs }), annotations: { readOnlyHint: true } },
  { name: 'agent_browser_wait_ms', description: 'Wait a fixed time.', inputSchema: S({ ms: { type: 'integer', minimum: 1, maximum: 10000 } }, ['ms']), annotations: { readOnlyHint: true } },
  { name: 'agent_browser_back', description: 'Go back in your tab.', inputSchema: S() },
  { name: 'agent_browser_forward', description: 'Go forward in your tab.', inputSchema: S() },
  { name: 'agent_browser_reload', description: 'Reload your tab.', inputSchema: S() },
  { name: 'agent_browser_tab_new', description: 'Open a new tab and make it yours.', inputSchema: S({ url: { type: 'string' } }) },
  { name: 'agent_browser_tab_list', description: "List the browser's tabs with ids.", inputSchema: S(), annotations: { readOnlyHint: true } },
  { name: 'agent_browser_tab_switch', description: 'Switch to a tab by id and make it yours.', inputSchema: S({ tab }, ['tab']) },
  { name: 'agent_browser_tab_close', description: 'Close a tab you opened. Omit tab to close your current tab.', inputSchema: S({ tab }) },
  { name: 'agent_browser_close', description: 'Finish browser work: close the tabs you opened and hand the browser back.', inputSchema: S() },
];
const TOOL_NAMES = new Set(desktopBrowserTools.map(t => t.name));

// Raw CDP never leaves this file; this is the complete command surface.
const ALLOWED = new Set([
  'Accessibility.getFullAXTree', 'DOM.getDocument', 'DOM.querySelector', 'DOM.describeNode', 'DOM.resolveNode',
  'DOM.getContentQuads', 'DOM.getBoxModel', 'DOM.scrollIntoViewIfNeeded', 'DOM.focus', 'DOM.setFileInputFiles',
  'Runtime.callFunctionOn', 'Runtime.evaluate', 'Runtime.releaseObject',
  'Page.captureScreenshot', 'Page.getLayoutMetrics', 'Page.navigate',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
]);
const INPUT = new Set(['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText']);

export const TAKEOVER = 'The person took over the browser. Stop browser work and ask them in chat how to continue; they can hand control back from the browser.';
export const STOPPED = 'The person stopped your browser work for this turn. Do not retry browser tools; tell them where you got to.';
const NO_PAGE = 'No page is open for you. Call agent_browser_open with a URL first.';
const STALE = 'Unknown or stale ref. Take a fresh agent_browser_snapshot.';

const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'option', 'listbox', 'spinbutton', 'treeitem', 'textField', 'TextField', 'PopUpButton']);
const SKIP = new Set(['InlineTextBox', 'none', 'generic', 'LineBreak', 'presentation']);
const KEYS = { Enter: [13, '\r'], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], Home: [36], End: [35], PageUp: [33], PageDown: [34], Space: [32, ' '], ' ': [32, ' '] };
const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Cmd: 4, Shift: 8 };
const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' };

// Secrets a page must never receive, even from a bot with shell access.
const SECRET_PATH = /(^|[\\/])(\.ssh|\.gnupg|\.aws|\.kube|\.docker|Keychains|\.env(\.[\w-]+)?|\.netrc|\.npmrc|\.pgpass|id_[a-z0-9]+)([\\/]|$)/i;
const MAX_UPLOAD = 200 * 1024 * 1024;
export function checkUploadFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 10) throw new Error('Pass 1 to 10 absolute file paths.');
  return files.map(f => {
    if (typeof f !== 'string' || !isAbsolute(f)) throw new Error('File paths must be absolute.');
    const path = normalizePath(f);
    if (SECRET_PATH.test(path)) throw new Error(`That file cannot be uploaded: ${path.split(sep).pop()}.`);
    let st; try { st = lstatSync(path); } catch { throw new Error(`No file at ${path}.`); }
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${path.split(sep).pop()} is not a regular file.`);
    if (st.size > MAX_UPLOAD) throw new Error(`${path.split(sep).pop()} is over 200 MB.`);
    return path;
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = value => ({ content: [{ type: 'text', text: value }] });
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function createSharedBrowser({ contentsFromId, urlAllowed = () => true, guestValid = () => true, host = {}, notify = () => {} }) {
  // Renderer mirror of the selected profile's tab strip.
  const view = { profileId: '', mounted: false, tabs: [], active: '' };
  const shortIds = new Map(); let nextShort = 1;
  const short = tabId => { if (!shortIds.has(tabId)) shortIds.set(tabId, `t${nextShort++}`); return shortIds.get(tabId); };
  const threads = new Map(); // key -> conversation state
  const holders = new Map(); // tabId -> { key, mode: 'bot'|'user', cursor, busy }
  const hooked = new WeakSet(); const dispatching = new Map();
  const key = (botId, threadId) => JSON.stringify([botId, threadId]);
  const tabOf = tabId => view.tabs.find(t => t.id === tabId);
  const tabIdForGuest = guestId => view.tabs.find(t => t.guestId === guestId)?.id;
  const guestOf = tabId => { const t = tabOf(tabId); if (!t?.guestId) return null; const c = contentsFromId(t.guestId); return c && !c.isDestroyed() ? c : null; };
  const waitFor = async (pred, ms) => { const end = Date.now() + ms; for (;;) { const v = pred(); if (v) return v; if (Date.now() >= end) return null; await sleep(50); } };
  // Which conversation holds a tab, so other threads can say where the bot is browsing.
  const holderThread = h => { try { const [botId, threadId] = JSON.parse(h.key); return { botId, threadId }; } catch { return {}; } };
  const publish = () => { try { notify({ tabs: Object.fromEntries([...holders].map(([tabId, h]) => [tabId, { mode: h.mode, cursor: h.cursor ?? null, busy: h.busy === true, own: h.own === true, ...holderThread(h) }])) }); } catch { /* renderer closed during guest teardown */ } };

  const detach = c => { try { if (c && !c.isDestroyed() && c.debugger.isAttached()) c.debugger.detach(); } catch { /* already gone */ } };
  const releaseTab = tabId => { const h = holders.get(tabId); if (!h) return; holders.delete(tabId); const c = guestOf(tabId); detach(c); try { c?.setBackgroundThrottling(true); } catch { /* destroyed */ } publish(); };
  const takeover = (tabId, mode = 'user') => {
    const h = holders.get(tabId); if (!h || h.mode !== 'bot') return false;
    h.mode = 'user'; h.busy = false; h.cursor = null; detach(guestOf(tabId));
    const t = threads.get(h.key); if (t) { t.interrupted = mode; t.refs.clear(); }
    publish(); return true;
  };
  const invalidate = tabId => { for (const t of threads.values()) if (t.refsTab === tabId) t.refs.clear(); };

  const hook = c => {
    if (hooked.has(c)) return; hooked.add(c);
    // The bot's own tab ignores the person's keys until they press take over;
    // a click or keypress in a tab borrowed from them is an interrupt.
    const ownedByBot = () => { const h = holders.get(tabIdForGuest(c.id)); return h?.own === true && h.mode === 'bot'; };
    c.on('before-input-event', (event, input) => { if (!dispatching.get(c.id) && input?.type !== 'keyUp' && ownedByBot()) event.preventDefault(); });
    c.on('input-event', (_event, input) => {
      if (dispatching.get(c.id) || ownedByBot()) return;
      if (!['mouseDown', 'keyDown', 'rawKeyDown'].includes(input?.type)) return;
      const tabId = tabIdForGuest(c.id); if (tabId) takeover(tabId, 'user');
    });
    c.debugger.on('detach', (_event, reason) => { const tabId = tabIdForGuest(c.id); if (tabId && reason !== 'target closed' && !c.isDestroyed() && !c.isCrashed() && holders.get(tabId)?.mode === 'bot') takeover(tabId, 'user'); });
    c.on('did-start-navigation', details => { if (details?.isMainFrame !== false && details?.isSameDocument !== true) { const tabId = tabIdForGuest(c.id); if (tabId) invalidate(tabId); } });
    // main.mjs reloads crashed tabs; here only the bot's view of them resets.
    c.on('render-process-gone', () => { const tabId = tabIdForGuest(c.id); detach(c); if (tabId) invalidate(tabId); });
    c.once('destroyed', () => { const tabId = tabIdForGuest(c.id); if (tabId) { invalidate(tabId); if (holders.has(tabId)) { holders.delete(tabId); publish(); } } });
  };

  // The reveal names the bot's conversation so only that thread opens the pane.
  const ensureMounted = async (t, deadline) => {
    if (!host.available?.()) throw Object.assign(new Error('desktop browser unavailable'), { unavailable: true });
    if (view.mounted) return;
    host.reveal?.({ botId: t.botId, threadId: t.threadId });
    if (!await waitFor(() => view.mounted, Math.min(8000, Math.max(0, deadline - Date.now())))) throw new Error('The browser did not open. Ask the person to open the browser panel, then try again.');
  };
  const assertCurrent = t => {
    if (t.released || threads.get(t.key) !== t) throw new Error('This browser turn ended. Start a new turn.');
    if (t.profileId !== view.profileId) throw new Error('The browser profile changed. Select the configured browser profile before continuing.');
    if (t.interrupted === 'user') throw new Error(TAKEOVER);
    if (t.interrupted === 'stopped') throw new Error(STOPPED);
  };
  const canClose = (t, tabId) => { const h = holders.get(tabId); return !h || (h.key === t.key && h.mode === 'bot'); };
  const send = command => { if (!host.command?.({ ...command, profileId: view.profileId })) throw new Error('The browser panel is not open.'); };

  const claim = (t, tabId) => {
    assertCurrent(t);
    const h = holders.get(tabId);
    if (h && h.key !== t.key) throw new Error(h.mode === 'user' ? 'The person is using that tab. Pick another tab or open a new one.' : 'Another conversation is using that tab. Open a new tab instead.');
    if (t.tabId && t.tabId !== tabId && holders.get(t.tabId)?.key === t.key) releaseTab(t.tabId);
    if (!h) { holders.set(tabId, { key: t.key, mode: 'bot', cursor: null, own: t.created.has(tabId), authorization: JSON.stringify([t.key, t.generation]) }); publish(); }
    if (t.tabId !== tabId) { t.refs.clear(); t.refsTab = tabId; }
    t.tabId = tabId;
  };
  const newTab = async (t, url, deadline) => {
    assertCurrent(t);
    await host.authorize?.({ profileId: t.profileId, url, action: 'browse', scope: JSON.stringify([t.key, t.generation]), fullAccess: t.fullAccess === true });
    assertCurrent(t);
    if (view.tabs.length >= 100) throw new Error('The browser has too many tabs. Ask the person to close some.');
    if (t.created.size >= 8) throw new Error('You already opened 8 tabs. Close one with agent_browser_tab_close first.');
    const tabId = randomUUID(); send({ op: 'new', tabId, url, background: true });
    if (!await waitFor(() => tabOf(tabId), Math.max(0, deadline - Date.now()))) throw new Error('The new tab did not open in time.');
    // Holding the background tab is what makes the renderer mount its page.
    t.created.add(tabId); claim(t, tabId);
    if (url !== 'about:blank' && !await waitFor(() => guestOf(tabId), Math.max(0, deadline - Date.now()))) throw new Error('The new tab did not open in time.');
    return tabId;
  };
  const currentTab = t => {
    if (t.tabId && tabOf(t.tabId) && holders.get(t.tabId)?.key === t.key) return t.tabId;
    t.tabId = ''; const active = tabOf(view.active);
    if (active && active.url !== 'about:blank' && !holders.has(active.id)) { claim(t, active.id); return active.id; }
    throw new Error(NO_PAGE);
  };
  const liveGuest = async (tabId, deadline) => {
    let c = guestOf(tabId);
    if (!c) {
      if (tabOf(tabId)?.url === 'about:blank') throw new Error(NO_PAGE);
      // The renderer keeps every held tab live, so it mounts without being shown.
      c = await waitFor(() => guestOf(tabId), Math.max(0, Math.min(8000, deadline - Date.now())));
      if (!c) throw new Error('That tab could not load. Take a fresh agent_browser_tab_list.');
    }
    hook(c);
    try { c.setBackgroundThrottling(false); } catch { /* destroyed */ }
    return c;
  };
  const normalize = raw => {
    let value = String(raw ?? '').trim(); if (!value) throw new Error('Pass a URL.');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`;
    let u; try { u = new URL(value); } catch { throw new Error('That is not a valid URL.'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !urlAllowed(u.href)) throw new Error('That URL is not allowed in the browser.');
    return u.href;
  };

  async function call(t, name, args, deadline) {
    if (t.interrupted === 'user') throw new Error(TAKEOVER);
    if (t.interrupted === 'stopped') throw new Error(STOPPED);
    await ensureMounted(t, deadline);
    if (!t.profileId) t.profileId = view.profileId;
    assertCurrent(t);
    if (name === 'agent_browser_tab_list') {
      const lines = view.tabs.map(x => { const h = holders.get(x.id); const marks = [x.id === t.tabId && 'yours, current', t.created.has(x.id) && x.id !== t.tabId && 'opened by you', x.id === view.active && 'on screen', h && h.key !== t.key && (h.mode === 'user' ? 'person in control' : 'another conversation')].filter(Boolean); return `${short(x.id)} ${clip(x.title || 'untitled', 80)} — ${clip(x.url, 200)}${marks.length ? ` (${marks.join(', ')})` : ''}`; });
      return text(lines.join('\n') || 'No tabs.');
    }
    if (name === 'agent_browser_tab_new') { const url = args.url ? normalize(args.url) : 'about:blank'; const id = await newTab(t, url, deadline); return text(`Opened ${short(id)}${url === 'about:blank' ? '' : ` at ${url}`}. It is now your tab. Take a snapshot before acting.`); }
    if (name === 'agent_browser_tab_switch' || name === 'agent_browser_tab_close') {
      const wanted = typeof args.tab === 'string' ? args.tab.trim() : '';
      const tabId = wanted ? [...shortIds].find(([, s]) => s === wanted)?.[0] : t.tabId;
      if (!tabId || !tabOf(tabId)) throw new Error('Unknown tab. Call agent_browser_tab_list.');
      if (name === 'agent_browser_tab_close') {
        if (!t.created.has(tabId)) throw new Error('You can only close tabs you opened.');
        if (!canClose(t, tabId)) throw new Error('Another conversation or the person is using that tab.');
        releaseTab(tabId); send({ op: 'close', tabId }); t.created.delete(tabId); if (t.tabId === tabId) t.tabId = '';
        return text(`Closed ${short(tabId)}.`);
      }
      claim(t, tabId); return text(`Switched to ${short(tabId)}: ${tabOf(tabId)?.url}. Take a snapshot before acting.`);
    }
    if (name === 'agent_browser_close') {
      for (const id of t.created) { if (!canClose(t, id)) continue; releaseTab(id); try { send({ op: 'close', tabId: id }); } catch { /* panel closed */ } }
      t.created.clear(); if (t.tabId) releaseTab(t.tabId); t.tabId = '';
      return text('Done. The browser is back with the person.');
    }
    if (name === 'agent_browser_wait_ms') { await sleep(Math.max(1, Math.min(10000, Number(args.ms) || 0, deadline - Date.now()))); return text('Waited.'); }
    if (name === 'agent_browser_open' || (name === 'agent_browser_read' && args.url)) {
      const url = normalize(args.url);
      // Never the person's tab, not even a blank one: the bot opens its own.
      let tabId = t.tabId && tabOf(t.tabId) && holders.get(t.tabId)?.key === t.key ? t.tabId : '';
      if (!tabId) tabId = await newTab(t, url, deadline);
      else if (tabOf(tabId)?.url === 'about:blank' && !guestOf(tabId)) {
        await host.authorize?.({ profileId: t.profileId, url, action: 'browse', scope: JSON.stringify([t.key, t.generation]), fullAccess: t.fullAccess === true });
        assertCurrent(t); send({ op: 'navigate', tabId, url });
        if (!await waitFor(() => guestOf(tabId), Math.max(0, deadline - Date.now()))) throw new Error('The page did not open in time.');
      } else {
        await host.authorize?.({ profileId: t.profileId, url, action: 'browse', scope: JSON.stringify([t.key, t.generation]), fullAccess: t.fullAccess === true });
        assertCurrent(t);
        const c = await liveGuest(tabId, deadline);
        const result = await cdp(t, tabId, c, 'Page.navigate', { url }, deadline);
        if (result?.errorText) throw new Error(`Could not open the page: ${result.errorText}`);
      }
      const c = await liveGuest(tabId, deadline); t.refs.clear();
      await waitFor(() => c.isDestroyed() || !c.isLoading(), Math.max(0, Math.min(15000, deadline - Date.now() - 500)));
      if (name === 'agent_browser_open') return text(`Opened ${c.getURL()} in ${short(tabId)}: ${c.getTitle()}. Take a snapshot before acting.`);
    }
    const tabId = currentTab(t); const c = await liveGuest(tabId, deadline);
    await host.authorize?.({ profileId: t.profileId, guestId: c.id, url: c.getURL(), action: 'browse', scope: JSON.stringify([t.key, t.generation]), fullAccess: t.fullAccess === true });
    assertCurrent(t);
    const run = (method, params) => cdp(t, tabId, c, method, params, deadline);
    const h = holders.get(tabId); h.busy = true; publish();
    try { return await tool(t, tabId, c, run, name, args, deadline); }
    finally { const now = holders.get(tabId); if (now) { now.busy = false; publish(); } }
  }

  async function cdp(t, tabId, c, method, params, deadline) {
    assertCurrent(t);
    if (!ALLOWED.has(method)) throw new Error('That browser command is not allowed.');
    if (method === 'Page.navigate' && (typeof params?.url !== 'string' || !urlAllowed(params.url))) throw new Error('That URL is not allowed in the browser.');
    const h = holders.get(tabId);
    if (t.interrupted === 'user' || !h || h.key !== t.key || h.mode !== 'bot') throw new Error(t.interrupted === 'stopped' ? STOPPED : TAKEOVER);
    if (c.isDestroyed()) throw new Error('Your tab closed. Open a page again.');
    if (!c.debugger.isAttached()) { try { c.debugger.attach('1.3'); } catch { throw new Error('The browser is being inspected with developer tools. Ask the person to close them.'); } }
    const input = INPUT.has(method); if (input) dispatching.set(c.id, (dispatching.get(c.id) ?? 0) + 1);
    let timer;
    try {
      const budget = Math.max(1, Math.min(15000, deadline - Date.now()));
      return await Promise.race([c.debugger.sendCommand(method, params), new Promise((_, reject) => { timer = setTimeout(() => { t.refs.clear(); reject(new Error('The page did not respond in time. Take a snapshot to check its state before repeating anything.')); }, budget); })]);
    } finally {
      clearTimeout(timer);
      if (input) setTimeout(() => { const n = (dispatching.get(c.id) ?? 1) - 1; if (n > 0) dispatching.set(c.id, n); else dispatching.delete(c.id); }, 150);
    }
  }

  async function nodeFor(t, tabId, run, sel) {
    if (typeof sel !== 'string' || !sel.trim()) throw new Error('Pass a selector or @ref.');
    const ref = /^@?(?:ref=)?(e\d+)$/.exec(sel.trim());
    if (ref) { const id = t.refsTab === tabId ? t.refs.get(ref[1]) : undefined; if (!id) throw new Error(STALE); return id; }
    const { root } = await run('DOM.getDocument', { depth: 0 });
    let found; try { found = await run('DOM.querySelector', { nodeId: root.nodeId, selector: sel }); } catch { throw new Error('That CSS selector is invalid.'); }
    if (!found?.nodeId) throw new Error(`No element matches ${clip(sel, 120)}.`);
    const { node } = await run('DOM.describeNode', { nodeId: found.nodeId }); return node.backendNodeId;
  }
  async function on(run, backendNodeId, fn, args = []) {
    let object; try { ({ object } = await run('DOM.resolveNode', { backendNodeId })); } catch { throw new Error(STALE); }
    if (!object?.objectId) throw new Error(STALE);
    try {
      const r = await run('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: fn, arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0]?.replace(/^Error:\s*/, '') || 'The element refused this action. Take a fresh snapshot.');
      return r.result?.value;
    } finally { await run('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {}); }
  }
  async function point(run, backendNodeId) {
    await run('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {});
    let quad;
    try { const { quads } = await run('DOM.getContentQuads', { backendNodeId }); quad = quads?.[0]; } catch { /* fall back */ }
    if (!quad) { try { quad = (await run('DOM.getBoxModel', { backendNodeId })).model.content; } catch { throw new Error('That element is not visible. Scroll or take a fresh snapshot.'); } }
    return { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4, quad };
  }
  async function mouseClick(t, tabId, c, run, x, y) {
    await run('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await run('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await run('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    const h = holders.get(tabId); if (h) { let zoom = 1; try { zoom = c.getZoomFactor(); } catch { /* destroyed */ } h.cursor = { x: x * zoom, y: y * zoom, at: Date.now() }; publish(); }
  }
  async function pressKey(run, combo) {
    const parts = String(combo).split('+').map(s => s.trim()).filter(Boolean); if (!parts.length) throw new Error('Pass a key such as Enter.');
    const name = parts.pop(); let modifiers = 0; for (const m of parts) { if (!MODIFIERS[m]) throw new Error(`Unknown modifier ${m}.`); modifiers |= MODIFIERS[m]; }
    const known = KEYS[name]; const single = name.length === 1;
    if (!known && !single && !/^F([1-9]|1[0-2])$/.test(name)) throw new Error(`Unknown key ${name}.`);
    const code = known ? known[0] : single ? name.toUpperCase().charCodeAt(0) : 111 + Number(name.slice(1));
    const typed = (modifiers & ~8) ? undefined : known ? known[1] : single ? name : undefined;
    const command = (modifiers & 6) && single ? EDIT_COMMANDS[name.toLowerCase()] : undefined;
    const base = { key: name === 'Space' ? ' ' : name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
    await run('Input.dispatchKeyEvent', { type: typed ? 'keyDown' : 'rawKeyDown', ...base, ...(typed ? { text: typed, unmodifiedText: typed } : {}), ...(command ? { commands: [command] } : {}) });
    await run('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  const evaluate = async (run, expression) => { const r = await run('Runtime.evaluate', { expression, returnByValue: true }); return r.result?.value; };
  const waitUntil = async (args, deadline, test) => {
    const end = Math.min(deadline - 300, Date.now() + Math.max(1, Math.min(30000, Number(args.waitTimeoutMs) || 10000)));
    for (;;) { if (await test()) return true; if (Date.now() >= end) return false; await sleep(250); }
  };

  async function tool(t, tabId, c, run, name, args, deadline) {
    if (name === 'agent_browser_get_url') return text(c.getURL());
    if (name === 'agent_browser_get_title') return text(c.getTitle());
    if (['agent_browser_back', 'agent_browser_forward', 'agent_browser_reload'].includes(name)) {
      const nav = c.navigationHistory;
      if (name === 'agent_browser_back') { if (!nav.canGoBack()) throw new Error('There is no previous page.'); nav.goBack(); }
      else if (name === 'agent_browser_forward') { if (!nav.canGoForward()) throw new Error('There is no next page.'); nav.goForward(); }
      else c.reload();
      t.refs.clear(); await sleep(150); await waitFor(() => c.isDestroyed() || !c.isLoading(), Math.max(0, Math.min(15000, deadline - Date.now() - 500)));
      return text(`Now at ${c.getURL()}: ${c.getTitle()}. Take a snapshot before acting.`);
    }
    if (name === 'agent_browser_snapshot') return snapshot(t, tabId, c, run, args);
    if (name === 'agent_browser_read') {
      const body = await evaluate(run, `(document.body ? document.body.innerText : '').slice(0, 200000)`);
      return text(`untrusted page: ${c.getURL()}\ntitle: ${c.getTitle()}\n\n${body ?? ''}`);
    }
    if (name === 'agent_browser_get_text') { const id = await nodeFor(t, tabId, run, args.selector); return text(String(await on(run, id, `function(){return String(this.innerText ?? this.textContent ?? '').slice(0,50000);}`) ?? '')); }
    if (name === 'agent_browser_wait_for_text') {
      if (typeof args.text !== 'string' || !args.text) throw new Error('Pass text to wait for.');
      const ok = await waitUntil(args, deadline, async () => await evaluate(run, `(document.body ? document.body.innerText : '').includes(${JSON.stringify(args.text)})`));
      if (!ok) throw new Error(`Timed out waiting for "${clip(args.text, 80)}".`); return text('Found.');
    }
    if (name === 'agent_browser_wait_for_selector') {
      const ok = await waitUntil(args, deadline, async () => { try { await nodeFor(t, tabId, run, args.selector); return true; } catch (e) { if (e.message === STALE) throw e; return false; } });
      if (!ok) throw new Error('Timed out waiting for that element.'); return text('Found.');
    }
    if (name === 'agent_browser_wait_for_load') {
      const want = args.state === 'domcontentloaded' ? ['interactive', 'complete'] : ['complete'];
      const ok = await waitUntil(args, deadline, async () => !c.isLoading() && want.includes(await evaluate(run, 'document.readyState')));
      if (ok && args.state === 'networkidle') await sleep(500);
      if (!ok) throw new Error('Timed out waiting for the page to load.'); return text('Loaded.');
    }
    if (name === 'agent_browser_screenshot') {
      const params = { format: 'jpeg', quality: 70 };
      if (args.selector) {
        const id = await nodeFor(t, tabId, run, args.selector); const { quad } = await point(run, id);
        const { cssLayoutViewport: v } = await run('Page.getLayoutMetrics', {});
        const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
        params.clip = { x: Math.min(...xs) + v.pageX, y: Math.min(...ys) + v.pageY, width: Math.max(1, Math.max(...xs) - Math.min(...xs)), height: Math.max(1, Math.max(...ys) - Math.min(...ys)), scale: 1 };
      } else if (args.fullPage) {
        const { cssContentSize: s } = await run('Page.getLayoutMetrics', {});
        params.clip = { x: 0, y: 0, width: Math.min(s.width, 4000), height: Math.min(s.height, 8000), scale: 1 }; params.captureBeyondViewport = true;
      }
      const { data } = await run('Page.captureScreenshot', params);
      return { content: [{ type: 'image', data, mimeType: 'image/jpeg' }, { type: 'text', text: `untrusted page: ${c.getURL()}` }] };
    }
    if (name === 'agent_browser_scroll') {
      const amount = Math.max(1, Math.min(10000, Number(args.amount) || 600)); const dir = args.direction || 'down';
      let x, y;
      if (args.selector) ({ x, y } = await point(run, await nodeFor(t, tabId, run, args.selector)));
      else { const { cssLayoutViewport: v } = await run('Page.getLayoutMetrics', {}); x = v.clientWidth / 2; y = v.clientHeight / 2; }
      await run('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dir === 'left' ? -amount : dir === 'right' ? amount : 0, deltaY: dir === 'up' ? -amount : dir === 'down' ? amount : 0 });
      return text('Scrolled. Take a fresh snapshot to see what changed.');
    }
    if (name === 'agent_browser_press') { await pressKey(run, args.key); return text(`Pressed ${args.key}.`); }
    if (name === 'agent_browser_sign_in') {
      if (!host.signIn) throw new Error('Saved sign-in is not available here. Ask the person to sign in themselves.');
      const r = await host.signIn({ profileId: t.profileId, guestId: c.id, username: typeof args.username === 'string' ? args.username : undefined });
      assertCurrent(t); t.refs.clear();
      return text(`Filled the saved login for ${r.username || 'the saved account'} on ${r.origin}. Take a snapshot and click the sign-in button.`);
    }
    const id = await nodeFor(t, tabId, run, args.selector);
    if (name === 'agent_browser_click') {
      await on(run, id, `function(){if(!this.isConnected)throw new Error('That element is no longer on the page. Take a fresh snapshot.');return true;}`);
      const { x, y } = await point(run, id); await mouseClick(t, tabId, c, run, x, y);
      return text('Clicked. Take a fresh snapshot to verify the result.');
    }
    if (name === 'agent_browser_fill' || name === 'agent_browser_type') {
      if (typeof args.text !== 'string' || args.text.length > 10000) throw new Error('Pass text of at most 10000 characters.');
      // Chromium native insertText can silently do nothing in an unfocused
      // Electron guest. Edit the exact DOM field without taking desktop focus,
      // notify its framework, and read it back before reporting success.
      await on(run, id, `function(value,clear){
        if(!this.isConnected)throw new Error('That element is no longer on the page. Take a fresh snapshot.');
        if(this.disabled||this.readOnly)throw new Error('That field cannot be edited.');
        this.focus({preventScroll:true});
        let expected;
        if(this.isContentEditable){
          if(clear){this.textContent=value;expected=value;const range=document.createRange();range.selectNodeContents(this);range.collapse(false);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);}
          else {
            const selection=getSelection();const range=selection&&selection.rangeCount?selection.getRangeAt(0):null;
            if(range&&this.contains(range.commonAncestorContainer)){range.deleteContents();const node=document.createTextNode(value);range.insertNode(node);range.setStartAfter(node);range.collapse(true);selection.removeAllRanges();selection.addRange(range);}
            else this.appendChild(document.createTextNode(value));
            expected=this.textContent;
          }
        }else if(this.tagName==='INPUT'||this.tagName==='TEXTAREA'){
          if(this.tagName==='INPUT'&&!['text','search','email','url','tel','number','password'].includes(this.type))throw new Error('That field does not accept text.');
          const old=this.value;const start=clear?0:(this.selectionStart??old.length),end=clear?old.length:(this.selectionEnd??old.length);
          expected=old.slice(0,start)+value+old.slice(end);
          const proto=this.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto,'value').set.call(this,expected);
          try{this.setSelectionRange(start+value.length,start+value.length);}catch{}
        }else throw new Error('That element is not an editable text field.');
        this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:clear?'insertReplacementText':'insertText',data:value}));
        if(clear)this.dispatchEvent(new Event('change',{bubbles:true}));
        if((this.isContentEditable?this.textContent:this.value)!==expected)throw new Error('The field did not retain the requested text. Take a snapshot before trying again.');
        return true;
      }`, [args.text, name === 'agent_browser_fill' || args.clear === true]);
      return text(name === 'agent_browser_fill' ? 'Filled.' : 'Typed.');
    }
    if (name === 'agent_browser_upload') {
      const files = checkUploadFiles(args.files);
      await on(run, id, `function(){if(!this.isConnected)throw new Error('That element is no longer on the page. Take a fresh snapshot.');if(this.tagName!=='INPUT'||this.type!=='file')throw new Error('That element is not a file input. Try the selector input[type=file].');if(this.disabled)throw new Error('That file input is disabled.');return true;}`);
      if (files.length > 1 && !(await on(run, id, 'function(){return this.multiple;}'))) throw new Error('That file input takes one file.');
      await host.authorize?.({ profileId: t.profileId, guestId: c.id, url: c.getURL(), action: 'upload', scope: JSON.stringify([t.key, t.generation]), fullAccess: t.fullAccess === true });
      assertCurrent(t);
      await run('DOM.setFileInputFiles', { files, backendNodeId: id });
      const n = await on(run, id, 'function(){return this.files?this.files.length:0;}');
      if (n !== files.length) throw new Error('The page did not take the files. Take a snapshot before trying again.');
      return text(`Attached ${n} file${n === 1 ? '' : 's'}. Take a fresh snapshot to see what the page did with ${n === 1 ? 'it' : 'them'}.`);
    }
    if (name === 'agent_browser_select') {
      if (!Array.isArray(args.values) || !args.values.length) throw new Error('Pass values to select.');
      const n = await on(run, id, `function(values){if(this.tagName!=='SELECT')throw new Error('That element is not a select. Click it and pick an option instead.');const want=new Set(values.map(String));let hit=0;for(const o of this.options){const m=want.has(o.value)||want.has(o.label)||want.has(o.textContent.trim());if(this.multiple)o.selected=m;else if(m&&!hit)this.value=o.value;if(m)hit++;}if(!hit)throw new Error('No option matches.');this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return hit;}`, [args.values]);
      return text(`Selected ${n} option${n === 1 ? '' : 's'}.`);
    }
    if (name === 'agent_browser_check' || name === 'agent_browser_uncheck') {
      const want = name === 'agent_browser_check';
      const state = await on(run, id, `function(){return typeof this.checked==='boolean'?this.checked:this.getAttribute('aria-checked')==='true';}`);
      if (state !== want) { const { x, y } = await point(run, id); await mouseClick(t, tabId, c, run, x, y); }
      return text(want ? 'Checked.' : 'Unchecked.');
    }
    throw new Error('Unknown browser tool.');
  }

  async function snapshot(t, tabId, c, run, args) {
    const { nodes } = await run('Accessibility.getFullAXTree', {});
    const byId = new Map(nodes.map(n => [n.nodeId, n]));
    let rootId = nodes[0]?.nodeId;
    if (args.selector) {
      const backend = await nodeFor(t, tabId, run, args.selector);
      rootId = nodes.find(n => n.backendDOMNodeId === backend)?.nodeId;
      if (!rootId) throw new Error('That element has no accessible content.');
    }
    const interactive = args.interactive !== false, maxDepth = Number.isInteger(args.depth) ? args.depth : Infinity;
    t.refs.clear(); t.refsTab = tabId; let n = 0; const lines = []; const seen = new Set();
    const walk = (id, depth) => {
      const node = byId.get(id); if (!node || seen.has(id) || lines.length >= 1500) return; seen.add(id);
      const role = node.role?.value; const name = String(node.name?.value ?? '').replace(/\s+/g, ' ').trim();
      let keep = !node.ignored && role && !SKIP.has(role);
      if (keep && interactive) keep = INTERACTIVE.has(role);
      if (keep && !interactive && args.compact && !name && !INTERACTIVE.has(role)) keep = false;
      if (keep && role === 'StaticText' && (!name || name === String(byId.get(node.parentId)?.name?.value ?? '').trim())) keep = false;
      if (keep && depth <= maxDepth) {
        const props = Object.fromEntries((node.properties ?? []).map(p => [p.name, p.value?.value]));
        const flags = ['checked', 'selected', 'expanded', 'disabled', 'required'].filter(k => props[k] === true || props[k] === 'true').map(k => ` [${k}]`).join('');
        const value = node.value?.value !== undefined && node.value.value !== '' && !/•|\*{3}/.test(String(node.value.value)) ? ` value="${clip(String(node.value.value), 200)}"` : '';
        let ref = ''; if (node.backendDOMNodeId) { const r = `e${++n}`; t.refs.set(r, node.backendDOMNodeId); ref = ` [ref=${r}]`; }
        lines.push(`${interactive ? '' : '  '.repeat(depth)}- ${role === 'StaticText' ? 'text' : role}${name ? ` "${clip(name, 300)}"` : ''}${value}${flags}${ref}`);
        for (const child of node.childIds ?? []) walk(child, depth + 1);
      } else for (const child of node.childIds ?? []) walk(child, depth);
    };
    if (rootId) walk(rootId, 0);
    if (lines.length >= 1500) lines.push('[snapshot truncated: pass selector or depth]');
    return text(`untrusted page: ${c.getURL()}\ntitle: ${c.getTitle()}\ntab: ${short(tabId)}\n${lines.join('\n') || (interactive ? 'No interactive elements. Pass interactive: false for the full tree.' : 'Empty page.')}`);
  }

  return {
    hasAgentControl(profileId) {
      return view.profileId === profileId && [...holders.values()].some(holder => holder.mode === 'bot');
    },
    agentForGuest(guestId) {
      const tabId = tabIdForGuest(guestId); const holder = holders.get(tabId);
      return holder?.mode === 'bot' ? { profileId: view.profileId, key: holder.key, scope: holder.authorization, fullAccess: threads.get(holder.key)?.fullAccess === true } : null;
    },
    tools() { return desktopBrowserTools; },
    mounted() { return view.mounted; },
    /** The window holding the tab strip closed without reporting it. */
    unmount() { view.mounted = false; view.tabs = []; view.active = ''; },
    /** The renderer's tab strip for one profile. Only the selected profile drives. */
    reportTabs(input) {
      if (!input || typeof input.profileId !== 'string') return false;
      if (input.mounted === false) { if (view.profileId === input.profileId) { view.mounted = false; view.tabs = []; view.active = ''; } return true; }
      if (input.selected !== true) return true;
      const tabs = Array.isArray(input.tabs) ? input.tabs.slice(0, 100).flatMap(x => x && typeof x.id === 'string' && /^[\w-]{1,80}$/.test(x.id) ? [{ id: x.id, url: String(x.url ?? '').slice(0, 4000), title: String(x.title ?? '').slice(0, 300), guestId: Number.isSafeInteger(x.guestId) && guestValid(x.guestId, input.profileId) ? x.guestId : undefined }] : []) : [];
      if (view.profileId && view.profileId !== input.profileId) for (const id of [...holders.keys()]) releaseTab(id);
      Object.assign(view, { profileId: input.profileId, mounted: true, tabs, active: typeof input.active === 'string' ? input.active : '' });
      for (const id of [...holders.keys()]) if (!tabOf(id)) { holders.delete(id); publish(); }
      for (const x of tabs) if (x.guestId) { const c = guestOf(x.id); if (c) { hook(c); try { c.setBackgroundThrottling(holders.get(x.id)?.mode !== 'bot'); } catch { /* destroyed */ } } }
      return true;
    },
    /** The person in the browser UI: take over, give back, or stop. */
    person(action, tabId) {
      const h = holders.get(tabId); if (!h) return false; const t = threads.get(h.key);
      if (action === 'take-over') return takeover(tabId, 'user');
      if (action === 'stop') { if (t) { t.interrupted = 'stopped'; t.refs.clear(); } releaseTab(tabId); return true; }
      if (action === 'give-back') { if (h.mode !== 'user') return false; h.mode = 'bot'; if (t) t.interrupted = null; publish(); return true; }
      return false;
    },
    /** Turn ended: hand every tab the conversation held back to the person. */
    release(threadId, generation) {
      for (const [k, t] of threads) if (t.threadId === threadId && (generation === undefined || t.generation === generation)) { t.released = true; for (const [tabId, h] of [...holders]) if (h.key === k) releaseTab(tabId); threads.delete(k); }
    },
    /** Conversation ids holding browser state, so a workspace can release its own. */
    threadIds() { return [...new Set([...threads.values()].map(t => t.threadId))]; },
    /** The private server exited: no conversation still has browser authority. */
    releaseAll() {
      for (const t of threads.values()) t.released = true;
      for (const tabId of [...holders.keys()]) releaseTab(tabId);
      threads.clear();
    },
    async rpc(botId, threadId, method, params = {}, deadline = Date.now() + 20000, authority = {}) {
      if (typeof botId !== 'string' || !botId || typeof threadId !== 'string' || !threadId) throw new Error('Unknown conversation');
      if (authority.profileId && view.profileId && authority.profileId !== view.profileId) throw new Error('Select the bot configured browser profile before continuing.');
      if (method === 'tools/list') return host.available?.() ? { tools: desktopBrowserTools } : { unavailable: true };
      if (method !== 'tools/call') throw new Error('Unsupported browser method');
      if (!host.available?.()) return { unavailable: true };
      const name = params?.name; if (!TOOL_NAMES.has(name)) throw new Error('Unknown browser tool');
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const k = key(botId, threadId);
      let t = threads.get(k);
      if (t && t.generation !== authority.generation) { this.release(threadId, t.generation); t = undefined; }
      if (!t) { t = { key: k, botId, threadId, generation: authority.generation, profileId: authority.profileId || view.profileId, released: false, tabId: '', created: new Set(), refs: new Map(), refsTab: '', interrupted: null, chain: Promise.resolve() }; threads.set(k, t); }
      // The server reads the conversation's access on every call, so a
      // downgrade mid-turn brings the prompts back on the next one.
      t.fullAccess = authority.fullAccess === true;
      const conversation = t;
      // One call at a time per conversation; queued calls keep their deadline.
      const next = conversation.chain.then(() => { if (Date.now() >= deadline) throw new Error('The browser was busy and this call expired. Try again.'); return call(conversation, name, args, deadline); });
      conversation.chain = next.catch(() => {});
      try { return await next; }
      catch (error) { if (error?.unavailable) return { unavailable: true }; throw error; }
    },
  };
}
