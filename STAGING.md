# BOS Staging

Branch: `staging`, based on private pilot source `1899bfb`.

Normal `pnpm package:mac` / `package:win` / `package:linux` commands on this branch select `electron-builder.staging.yml`; publishing is disabled. Only the mac artifact has been exercised locally. Do not publish mobile, Windows or Linux builds as verified.

Installed mac name: BOS Staging.app, bundle ai.bos.bot.staging. Packaged bosChannel metadata activates isolation before Electron stores are opened. Data lives in ~/.bos-bot-staging; Electron user/session data in Application Support/BOS Staging. Provider child processes receive a dedicated provider-home under staging; sign in separately. No automatic live import. Server ports 38799/48799/58799, matching webhook +1; companion38810/control38811/tunnel38812; relay38798/48798/58798. Staging package links use bosbot-staging. Updater disabled.

Application-state isolation is not an OS sandbox. Granted computer/file tools retain OS access; use synthetic tasks and dedicated workspaces. Development browser servers are not the packaged staging app: use isolated verification fixtures, never point dev UI at live BOS.

Promote reviewed feature commits into a release candidate; do not merge the staging packaging configuration blindly into live. Installation/publication on other users remains held until Firaz authorizes it. Mobile staging identities are not implemented in this desktop change.
