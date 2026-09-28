# BOS Free relay

Hosted zero-price OpenRouter relay behind Start free. The owner key lives only in the host's `.env`; installs register for a capped per-install token.

Deployed on aihlete: `~/bos-free` (pm2 `bos-free`, fork mode, 127.0.0.1:3370) behind its own Cloudflare tunnel `bos-free` (pm2 `bos-free-tunnel`) at https://bos-free.aihlete.com. Test: `node --test server.test.mjs`.
