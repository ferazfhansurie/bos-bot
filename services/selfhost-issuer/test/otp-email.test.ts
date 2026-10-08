import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOTPEmail } from '../otp-email.ts';

test('otp email: code leads the subject, stands alone in html and text', () => {
  const m = buildOTPEmail({ otp: '12345678', type: 'sign-in', publicURL: 'https://rooms.example.com' });
  assert.equal(m.subject, '12345678 is your BOS sign-in code');
  assert.match(m.html, />12345678<\/td>/);
  assert.ok(m.text.split('\n').includes('12345678'));
  assert.match(m.html, /rooms\.example\.com/);
  assert.match(m.html, /#1084fe/);
});

test('otp email: verification types and escaping', () => {
  const m = buildOTPEmail({ otp: '<b>', type: 'email-verification', publicURL: 'https://x.test' });
  assert.equal(m.subject, '<b> is your BOS verification code');
  assert.ok(!m.html.includes('<b>'));
  assert.match(m.html, /Verify your email/);
});
