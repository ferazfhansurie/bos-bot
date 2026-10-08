/**
 * Sign-in code email in the BOS app's default (Midnight) skin: tokens from src/styles.css.
 * The code sits alone in its own box with no spaces inside it, so a double-click, a
 * long-press or the subject line copies exactly the digits. Table layout and inline
 * styles only, so Gmail, Outlook and Apple Mail render it the same.
 */
const C = {
  app: '#070707', panel: '#111111', card: '#262626', hairline: '#333333',
  ink: '#fcfcfc', inkSecondary: '#a3a3a3', accent: '#1084fe', accentText: '#7fc0ff',
};
const FONT = `Inter,-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',system-ui,sans-serif`;
const MONO = `'SF Mono',ui-monospace,Menlo,Consolas,'Liberation Mono',monospace`;

const HEADINGS: Record<string, string> = {
  'sign-in': 'Your sign-in code',
  'email-verification': 'Verify your email',
  'forget-password': 'Reset your password',
  'change-email': 'Confirm your new email',
};

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export function buildOTPEmail(input: { otp: string; type: string; publicURL: string }) {
  const heading = HEADINGS[input.type] ?? HEADINGS['sign-in'];
  const otp = esc(input.otp);
  const host = esc(new URL(input.publicURL).host);
  const kind = input.type === 'sign-in' || !HEADINGS[input.type] ? 'sign-in' : 'verification';
  const subject = `${input.otp} is your BOS ${kind} code`;
  const text = [
    `${heading} for BOS`, '', input.otp, '',
    `Paste it on ${new URL(input.publicURL).host}. It expires in 10 minutes and works once.`,
    '', `Didn't ask for this? Ignore this email. Nobody can sign in without the code.`,
  ].join('\n');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.app};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${otp} is your BOS ${kind} code. It expires in 10 minutes.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.app}" style="background:${C.app};">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="max-width:440px;background:${C.panel};border:1px solid ${C.hairline};border-radius:14px;">
<tr><td style="padding:28px 28px 0;font-family:${FONT};font-size:18px;font-weight:700;color:${C.ink};letter-spacing:-0.01em;">bos<span style="color:${C.accent};">.</span></td></tr>
<tr><td style="padding:20px 28px 0;font-family:${FONT};font-size:20px;line-height:28px;font-weight:600;color:${C.ink};">${heading}</td></tr>
<tr><td style="padding:6px 28px 0;font-family:${FONT};font-size:14px;line-height:22px;color:${C.inkSecondary};">Copy this code and paste it where you signed in.</td></tr>
<tr><td style="padding:20px 28px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.hairline};border-radius:8px;">
<tr><td align="center" style="padding:18px 12px;font-family:${MONO};font-size:34px;line-height:40px;font-weight:700;color:${C.ink};letter-spacing:6px;-webkit-user-select:all;user-select:all;">${otp}</td></tr>
</table></td></tr>
<tr><td style="padding:12px 28px 0;font-family:${FONT};font-size:13px;line-height:20px;color:${C.inkSecondary};">Double-click or long-press the code to select it. It expires in 10 minutes and works once.</td></tr>
<tr><td style="padding:24px 28px 0;"><div style="height:1px;line-height:1px;background:${C.hairline};">&nbsp;</div></td></tr>
<tr><td style="padding:16px 28px 28px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.inkSecondary};">Sent by <a href="${esc(input.publicURL)}" style="color:${C.accentText};text-decoration:none;">${host}</a>. Didn't ask for this? Ignore this email. Nobody can sign in without the code.</td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { subject, text, html };
}
