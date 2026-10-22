---
name: make-mod
description: "Build, edit or remove a desktop BOS UI mod when the user asks for a panel, composer band, status chip or slash command. Mods change BOS live without restarting."
---

# Make a mod

Use `mods_list`, `mod_read`, `mod_write`, `mod_delete`. These call the turn-scoped mods API; never write to a hardcoded home or restart BOS. Mods are desktop-only in v1. Do not overload connected apps or create prompt/tool hooks.

1. Pick the smallest surface matching the request: `panel` (right), `band` (above composer), `chip` (header), `command` (button or `/id` in chat). Read an existing mod before editing; preserve the user's intent.
2. Call `mod_write` with `{bundle:{manifest:{id,name,version,description,surfaces,permissions},files:{"index.html":"..."}}}`. IDs are lowercase slugs starting with a letter, at most 64 chars; version is semver. Only these manifest fields are accepted. Files may include flat `app.js`/`style.css` references. No folders, remote resources, external libraries or network calls. Keep the whole bundle under 512 KB.
3. Declare only the permissions needed: `threads:read`, `bots:ask`, `apps:call`, `storage`. None is fine. Every save turns it off. Say “saved; review permissions in settings → mods and enable it.” Never claim it is enabled, or that sample data is real. The UI reloads automatically.
4. For deletion, confirm the id by reading/listing, then `mod_delete` only when requested.

The iframe has `window.bos.call(method, params)` returning a promise. Handle errors in calm text. Render replies as `textContent`, never HTML.

- `await bos.call("threads:read", {})` returns up to 30 of this bot's direct thread summaries: `{title,createdAt,messages:[{role,text,at}]}` with up to 8 recent text messages each. Never infer a complete history, zero leads, or unavailable app data from this bounded list.
- `await bos.call("bots:ask", {prompt:"..."})` asks this mod's bot in a separate conversation with approval mode ask; returns its reply. A request times out after 120 seconds and stops its own work. Prefer a button so the person decides when work starts; no automatic prompt loops.
- `await bos.call("apps:call", {prompt:"Read today's leads from the connected CRM"})` routes to the bot and its normal app approval flow. No direct API credentials or network access.
- `await bos.call("storage:get", {key:"filter"})` / `await bos.call("storage:set", {key:"filter",value:...})`: JSON values, 64 KB total per mod. Keys are alphanumeric, underscore or dash, at most 80 chars. Storage is not for secrets and resets when files are replaced.

No parent DOM/storage, filesystem, popups, top navigation, raw fetch, cookies or secrets. Do not try to bypass sandbox/CSP. At most 30 bridge calls per minute, 3 concurrent, 8 KB prompts. Requests to another bot are refused.

Examples in `examples/*.bosmod` are the exact JSON bundle accepted by `mod_write`. Import/export uses that same single-file format; imports start off and settings shows their permissions before enabling.
