# BOS Free relay

Hosted relay behind Start free. Serves one model, "BOS Free GPT-6 Luna" (public id `bos-free/gpt-6-luna:free`, upstream OpenAI `gpt-6-luna`, override with `BOS_FREE_MODEL`). The owner `OPENAI_API_KEY` lives only in the host's `.env`; installs register for a capped per-install token (`PER_INSTALL_DAILY` 100, `GLOBAL_DAILY` 2000, `CHAT_PER_IP_DAILY` 150). Older installs asking for `openrouter/free` or any `:free` id are served by Luna.

Deployed on aihlete: `~/bos-free` (pm2 `bos-free`, fork mode, 127.0.0.1:3370) behind its own Cloudflare tunnel `bos-free` (pm2 `bos-free-tunnel`) at https://bos-free.aihlete.com. Test: `for f in *.test.mjs; do node --test $f; done`.
