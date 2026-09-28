# Free-model evaluation — 28 September 2026

## Result and limits

Configured: reproducible synthetic smoke harness. Tested: offline pricing, fallback, structured scoring and release gates. Verified: unauthenticated OpenRouter model catalog retrieval, saved beside this document. Not tested: live inference, UI code generation, model tool execution or end-to-end BOS onboarding. No smartest-model winner is established.

The official OpenRouter quickstart requires an API key. OpenCode Zen describes login and API-key setup. No account credential was sought, and no authenticated call, payment, installation or publication occurred. Missing task-authorized inference access blocks a fair live comparison. The harness never accesses credential stores. Authenticated inference is opt-in and reads only an explicitly designated `OPENROUTER_API_KEY` environment variable when `--run` is supplied. No real key was read or used during this work.

## Repeatable procedure

Run from repository root (Node 22):

```sh
node --test scripts/bos-readiness.test.mjs
node scripts/bos-free-benchmark.mjs
node scripts/bos-free-benchmark.mjs --catalog
# After the operator has securely supplied OPENROUTER_API_KEY externally:
node scripts/bos-free-benchmark.mjs --run --models=cohere/north-mini-code:free,google/gemma-4-31b-it:free
```

`--catalog` performs one public read. `--run` requires 1–3 explicit unique `:free` IDs plus the designated key; a missing key stops before any network request. Recheck the catalog before choosing IDs; the command example is a shortlist, not a recommendation or permanent availability claim. Authentication is transmitted only to the fixed OpenRouter completion endpoint, never to catalog requests. Keys are not logged or included in prompts; provider errors are reduced to safe status codes. Do not put real keys in shell command history or artifacts. `--run-public` is an explicit unauthenticated-only inference probe: maximum three candidates, three fixed tasks each, 900 output tokens, 30-second request deadlines, 3.1-second spacing, no retries and a global circuit breaker on the first failure. It refreshes public price evidence before every call. It never submits private repository content or user data. Authentication failure is a blocker, never an invitation to look for keys.

The whitelist accepts explicit `:free` IDs with known zero input/output prices and no nonzero or malformed price field. Requests pin the ID, disable provider fallback and cap provider input/output price at zero. Automatic free routers are excluded from a model comparison because routing can change the model. No tools, browsing, images, credit purchase, paid fallback or billing configuration is available in the harness. Both authenticated and unauthenticated runs retain these guards. The operator supplies the scoped key externally; the harness never searches for it or requests billing changes.

Three fixed probes cover an actual self-contained bakery HTML landing page, dashboard arithmetic and free-onboarding state order/auth-error behavior. The HTML is scored for semantic structure, viewport metadata, inline CSS, required product/contact content and absence of remote HTTP dependencies/scripts. These are basic static checks, not visual or accessibility certification. Scores are deterministic, 0–2 each, and raw synthetic answers and latency remain reviewable. This is a smoke test, not sufficient evidence of coding intelligence. Authenticated candidates are explicitly shortlisted by the operator; the optional public probe uses lexical order, not quality. Expand to multiple trials, isolated rendering and dashboard code generation, accessibility checks and human review before naming a default; compare all shortlisted candidates under identical prompts and budgets. Never execute generated code outside an isolated fixture.

## Primary sources and product implications

- [OpenRouter quickstart](https://openrouter.ai/docs/quickstart): authenticated API setup.
- [OpenRouter model catalog](https://openrouter.ai/api/v1/models): current IDs/prices; evidence is a dated snapshot, not a permanent guarantee.
- [OpenRouter limits](https://openrouter.ai/docs/api_reference/limits): free-model quotas/rate limits exist. Surface quota exhaustion and offer retry later; do not silently upgrade to a paid model.
- [OpenRouter free router](https://openrouter.ai/docs/guides/routing/routers/free-router): free routing is available, but routing does not demonstrate one model is smartest.
- [OpenCode Zen](https://opencode.ai/docs/zen/): current free offerings include Big Pickle and several explicitly free variants. Offers may expire and some free endpoints have training/trial-data conditions. Treat Zen separately from OpenRouter, validate the exact endpoint and price, and disclose relevant data terms before sending real user content. This harness intentionally does not infer zero price from a model name or enable Zen inference without an enforceable price gate.

Onboarding should distinguish a provider account/key from a model price. Show “free model, limits apply” with freshness and provider terms; confirm availability with a synthetic test after connection. Keep user-selected paid models distinct. A 401 should return to account connection; 429 should retain drafts and offer bounded retry. Do not advertise “smartest free” until comparable live evidence exists.
