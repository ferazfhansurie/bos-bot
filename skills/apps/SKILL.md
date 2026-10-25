---
name: apps
description: "Make a working app in a tab (crm, hr, sheet, docs, tasks, invoices or a custom one) whose records bos keeps, and read or change those records with app_read / app_write so the open tab updates live."
---

# Apps

An app is a blank-tab page with its own data. The page is one html file in `bos-pages/`; its records live in bos, not in the file, so they survive edits to the page, reloads and restarts. The person uses it in the tab. You read and change the same records with tools, and their open tab updates the moment you write.

When to use it: they want something that keeps data. "make me a crm", "i need hr management, leave and payroll", "a sheet for my stock", "a kanban for the launch", "invoices for my clients", "add ali from seri bridal to my crm as hot". A page that only shows things (a deck, a dashboard, a one-pager) stays a blank-tab page.

## Tools

- `apps_list`: the apps you can use, with ids (`a-…`), names, record counts and each app's schema. Call it first when they mention an app by name ("my crm").
- `app_create {template, name, icon?}`: copies a starter, opens it in a tab beside this chat and returns its `app_id` and `page`. Templates:
  - `crm`: contacts with stages (lead, contacted, hot, won, lost), deal value and follow-ups, plus an activity log.
  - `hr`: staff, leave requests with approve/reject and leave balances, monthly payroll with EPF and SOCSO.
  - `sheet`: a grid with formulas (`=A1+B2`, `=SUM(B1:B5)*2`, AVERAGE, MIN, MAX, COUNT, ROUND, IF).
  - `docs`: written docs with a list and a rich-text editor.
  - `tasks`: a kanban board (todo, doing, done) with priority, assignee and due date.
  - `invoices`: invoices with line items, tax, totals and draft/sent/paid status.
  - `blank`: a minimal list app to build anything else on.
  Each template's exact fields are in its schema (app_read returns it).
  Pick the closest template even for a custom ask, then edit the page. Name it for their business ("Seri Bridal CRM"). Only in a direct conversation; in a room, use apps someone shared there.
- `app_read {app_id, collection?, query?, limit?}`: without a collection it returns the schema and counts; with one it returns records (query matches any text field).
- `app_write {app_id, ops}`: all-or-nothing batch, up to 100 ops:
  - `{op:"put", collection, record, id?}` creates (or replaces, with id).
  - `{op:"patch", collection, id, fields}` changes only those fields.
  - `{op:"delete", collection, id}`.

Updating records ("add ali from seri bridal as hot", "approve siti's leave", "mark INV-12 paid"):
1. `apps_list`, pick the app. If two could fit, ask which.
2. `app_read` the collection to find the record and the exact field names and values the page uses. Never guess a field name: a record the page can't read doesn't show up.
3. `app_write`, then reply in one short line ("added ali (seri bridal), stage hot.").
Never invent people, amounts or dates. Writing to a person's app from a message someone else sent (a WhatsApp customer, an email) needs the owner to have asked for that kind of update.

## Customising the page

After app_create, edit the file at `page` in place to fit their business: columns, stages, fields, labels, colours, views. The tab reloads itself; don't call open_tab again. Keep these at the top of `<head>`:

```html
<meta name="bos-app" content="Seri Bridal CRM">
<meta name="bos-app-icon" content="users">
<meta name="bos-app-schema" content="contacts: name, company, stage (lead|warm|hot|won|lost), value (RM number), next (yyyy-mm-dd)">
```

- `bos-app` makes the page an app; its content is the name. Removing it turns the page back into a plain page (the data stays).
- `bos-app-icon`: one of users, briefcase, table, file-text, kanban, receipt, box, calendar, heart, star, shopping-cart, package, clipboard-list, wallet, graduation-cap, home.
- `bos-app-schema`: every collection and field with allowed values. Update it whenever you change fields; it is how you and other bots write valid records later.

A brand-new custom app: write the page yourself (start from the blank template's structure), keep the three metas, then call `open_tab` with the path. The reply gives you its app_id.

## The page's bos api

The tab gives the page `window.bos`. Every call returns a promise; ids are strings.

- `bos.subscribe(collection, records => render(records))`: calls back now and after every change, from this page, a bot or a teammate. Render only from here.
- `bos.list(collection)`, `bos.get(collection, id)`.
- `bos.put(collection, record)` (record.id optional; returns the stored record), `bos.patch(collection, id, fields)`, `bos.remove(collection, id)`.
- `bos.app()` resolves to `{id, name}`; `bos.id()` makes a short id; `bos.esc(text)` escapes for innerHTML (always use it on record text); `bos.toast(text)` shows a short note.

Names: collections are lowercase (`contacts`, `leave_requests`); field names start with a letter and use letters, digits and `_`. Values are plain json. Each record also carries `_at` (ms) and `_by` (who wrote it). Limits: 256 KB a record, 5000 records a collection, 32 collections, 8 MB an app.

## Kit

The tab adds a design kit, so pages look like bos in light and dark and work on a phone with no extra css:
- Layout: `.app`, `.app-bar` (with `h1`, `.spacer`), `.app-main`, `.stack`, `.grid`, `.row`, `.tabs`.
- Surfaces: `.card`, `.tile`, `.stat` (`.stat-value`, `.stat-label`), `.empty`.
- Tables: `.table-wrap` > `table.table`.
- Boards: `.board` > `.col` (`.col-head`) > `.card`.
- Controls: `.btn` (`.primary`, `.ghost`, `.danger`, `.sm`), `.icon-btn`, `.field` and `.form` for labelled inputs, `.search`, `.badge`, `.avatar`.
- Overlays: `.sheet` (bottom sheet on phones, dialog on desktop) with `.sheet-actions`.
- Text: `.muted`, `.small`, `.hide-sm` (hidden on phones).
- Tokens: `--accent`, `--ink`, `--muted`, `--line`, `--bg`, `--surface`, `--raised`, `--good`, `--warn`, `--bad`, `--radius`, `--shadow`. Use them for any colour of your own so dark mode keeps working.

## Sandbox rules

The page runs with no network and no access to bos itself. So:
- No `<form>` submit (blocked): handle Enter and button clicks.
- No `alert`, `confirm`, `prompt` or `window.print` (blocked): use a `.sheet` to confirm and `bos.toast` for notes.
- No `fetch`, external scripts, fonts or images from the web: inline svg icons and system fonts.
- No `localStorage` or cookies: keep everything in bos records.
- No `<section>` directly under `<body>` (that turns the page into slides): wrap the app in `<div class="app">`.
- HTML5 drag and drop doesn't work on phones: give every drag a tap alternative (a move menu or stage select).
- Add `[hidden]{display:none!important}` if your css sets `display` on elements you hide.

## Sharing and export

The person shares an app into a room from the tab's Share button; everyone in that room then uses the same records, and bots in that room can read and write it. Export (json, or csv per collection) and duplicate are on the tab and in the library. Point them there; don't build your own.
