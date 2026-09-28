# BOS Free relay

Hosted relay behind Start free. Serves one model, "DeepSeek V4 Flash" (public id `bos-free/deepseek-v4-flash:free`, upstream OpenRouter `deepseek/deepseek-v4.1-flash`, override with `BOS_FREE_MODEL`). Routed to DeepSeek's own endpoint first for prompt caching, with a price cap (`MAX_PROMPT_PRICE` 0.1, `MAX_COMPLETION_PRICE` 0.5, $ per million tokens) so a reroute can't overspend. The owner `OPENROUTER_API_KEY` lives only in the host's `.env`; installs register for a capped per-install token (`PER_INSTALL_DAILY` 100, `GLOBAL_DAILY` 2000, `CHAT_PER_IP_DAILY` 150). Older installs asking for `openrouter/free` or any `:free` id are served by the same model.

Deployed on aihlete: `~/bos-free` (pm2 `bos-free`, fork mode, 127.0.0.1:3370) behind its own Cloudflare tunnel `bos-free` (pm2 `bos-free-tunnel`) at https://bos-free.aihlete.com. Test: `for f in *.test.mjs; do node --test $f; done`.
