# Conversation workbench

Run `node --experimental-strip-types scripts/verify-workbench.ts` (Node 24+) from an installed worktree. It launches control-omb's disposable fake-engine server, mounts the production React components via Vite, and uses the production preload, hardened native guests and primary-browser controller in a hidden Electron window. It never reads or mutates the installed app's data.

The fixture checks conversation rename, the shared tab strip, new-tab tools, file filtering, an actual browser guest, native PNG capture, device emulation, a real side-chat thread and terminal rendering. Evidence defaults to `.omb-scratch/verify-evidence/workbench`; pass an absolute output directory as the script's first argument to keep screenshots elsewhere. Use the printed verification JSON. `verify-primary-browser.mjs` additionally covers persistent profiles, imports, passwords, downloads and process restart. `--shared-only` covers the shared human/agent guest.

Page registration is documented at the top of `src/components/workbench/registry.ts`. The page placeholder hides page creation until a real editor replaces it. Fork, public share, conversation windows and presentation/spreadsheet/site creation are omitted because this panel has no supported backend for them. Pinning uses the existing per-device sidebar pin storage. The existing call/done/tools actions remain available beneath the conversation menu. Browser profiles, ad protection and saved-library actions stay reachable alongside browser settings.

No signed package, installation, live-account migration or physical-device acceptance is established by these checks.
