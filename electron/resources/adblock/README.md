# bundled content blocking

Ghostery @ghostery/adblocker 2.20.1 is bundled without modifications; its MPL-2.0
license and linked third-party notices ship in electron/vendor. Source:
https://github.com/ghostery/adblocker/tree/v2.20.1/packages/adblocker

EasyList and EasyPrivacy snapshots were retrieved from the official distribution
on 2026-10-13. The original headers contain dates, commit identifiers, attribution
and licensing links. Rules refresh with desktop releases.

- https://easylist.to/easylist/easylist.txt
- https://easylist.to/easylist/easyprivacy.txt
- https://easylist.to/pages/licence.html

BOS uses the network matcher and static CSS only. No filter-provided JavaScript,
scriptlet, remote preload, or Electron IPC is installed in website guests.
