# Desktop recovery and update boundaries

The desktop's existing supervisor restarts only its utility server. The optional `scripts/host-recovery.mjs` runner lives outside Electron and can restart a dead, idle desktop host. This change does not install a launch agent, Windows service, login item or routine. No live runner configuration was created by the audit.

An operator must first verify the exact installed executable, channel and data directory, then explicitly start the runner using a private JSON configuration:

```json
{
  "dataDir": "/absolute/verified/bos-data-directory",
  "executable": "/absolute/verified/desktop-executable",
  "args": []
}
```

```sh
node scripts/host-recovery.mjs --config /absolute/private/recovery-config.json
```

This is a future activation procedure, not evidence of an installed supervisor. Staging bootstrap chooses its isolated staging data directory; a configuration must match that actual channel directory. A mismatch fails the recovery generation check. The runner pins `OMB_DATA_DIR` to its configured canonical path and never uses a shell command or installs software.

The runner claims a separate durable owner lease. It requires a valid host generation and checks the existing parent/delegated-child lease identities with the same conservative rules as normal acquisition. It never kills a surviving host, utility child or provider. Foreign, corrupt or unverifiable ownership holds recovery. PID reuse can conservatively hold recovery rather than start a competing instance.

Desktop startup, verified child readiness, child identities, intentional quit and maintenance/update intent are written atomically. Ordinary quit records intent before asynchronous shutdown; a persistence failure blocks the quit. Only a new explicit host launch clears a prior quit intent. Fatal exit handlers do not record an intentional quit.

Recovery reservations and launch tokens are durable and generation fenced. At most three attempts are allowed, with bounded backoff and a startup window. An uncertain spawn identity or a surviving successor prevents another launch. Restarting the runner does not reset the budget; sustained verified host/child readiness is required. A hung live process is held, not killed. The script's polling trigger has only been exercised against disposable fixtures.

Unconfirmed direct and room turn dispatches, pending restore journals and prepared or committed update receipts hold automatic host recovery. Ordinary direct and room turns record a dispatch receipt before calling their provider. After an explicit restart, uncertain work receives an outcome-unknown notice in its original conversation and is never replayed automatically. This protects external effects; it does not provide seamless task continuation or automatically reconcile an orphan provider. Such work requires manual review. Its thread and overlapping workspace remain blocked until an authorized person explicitly confirms the request has finished or stopped and marks it reviewed. Unknown-outcome failures do not launch autonomous incident reporting or retry work. The durable receipt and warning remain visible; acknowledgment releases the hold without invoking a provider.

Native updates acquire a quiet server gate before installer dispatch. Admission includes public sign-in/pairing requests, ordinary API writers and direct/group/shared provider entry points. Active work and pending human decisions refuse preparation. A matching child PID, host generation and operation nonce identify the durable receipt. A serialized server commit makes the prepared hold durable and non-cancellable before the parent records update intent and invokes the native installer. Cancellation that wins before commit prevents installation; a committed receipt cannot release the gate. Installation on ordinary quit is disabled on every platform. Same-host child replacement restores a prepared or committed hold before recovery or schedulers can dispatch work. Ambiguous installer handoff stays held rather than exposing automatic retry.

Linux package-manager handoff remains an explicit command for the user to run; it does not claim the native quiet-install guarantee. No automatic binary/database rollback is implemented. Incompatible or uncertain updates require inspection; an older database is never silently restored over newer activity. Native signing, notarization, installed upgrade/rollback compatibility, real device retention and service activation are separate acceptance gates.

Portable workspace backups exclude host intent, update/private-dispatch receipts, runner state, ownership leases and their exact atomic temporary files. Restore preserves the destination's runtime ownership instead of importing another machine's recovery capabilities. Drafts, conversations, tasks and ordinary user files remain subject to the existing backup contract.

Fixture evidence covers actual external runner survival after host death, surviving-child exclusion, exactly one successor, durable quit across runner restart, persistent retry limits, corrupt-state holds, synthetic data retention, private request interruption without replay and retained update gates across child restart. These tests do not establish installed macOS/Windows/iPhone acceptance.
