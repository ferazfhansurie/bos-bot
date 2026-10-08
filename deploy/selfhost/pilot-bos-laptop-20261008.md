# bos-laptop pilot — 2026-10-08

Live pilot at https://rooms.aihlete.com, source 2db95c32f (bos/slice5-freeze-selfhost-20261008).
Host: bos-laptop WSL bos-server, ~/apps/bos-pilot, compose project bos-cloud-pilot,
private .env 0600 (secrets generated on host, never printed). No spend.

Ingress: own Cloudflare tunnel bos-pilot (9a3b9d0c), systemd cloudflared-bos-pilot,
-> Caddy on 127.0.0.1:18080 using Caddyfile.tunnel. TLS ends at Cloudflare. The
existing bos-server tunnel and its client sites were not touched or restarted.

Checked over the public https origin (real Cloudflare cert, verify result 0):
- /healthz 200, /v2/health 200, /v1/me without session 401.
- OTP send to a non-allowlisted email 403; allowlisted email 200.
- OTP reached the private issuer log (read in memory, never printed); sign-in 200
  with signed bearer; /v2/me 200; hostile origin 403; sign-out 200; bearer after
  sign-out 401.
- Sentry: room/worker/issuer carry the aihlete/bos-server DSN, env pilot,
  release bos@2db95c32f. No event forced on the live pilot.

Still open: OTP delivery is log, not email. Self-service colleague onboarding needs
a designated SMTP sender (ISSUER_OTP_DELIVERY=smtp, ISSUER_SMTP_URL,
ISSUER_EMAIL_FROM) and a real recipient check. Allowlist is Firaz's two addresses;
colleague emails/domains get added when known. Backups of this stack not yet set up.
