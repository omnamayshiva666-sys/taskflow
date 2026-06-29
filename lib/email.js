// Optional email sending. Google Apps Script had MailApp built in for free;
// on Vercel there's no equivalent, so this uses Resend (https://resend.com)
// which has a generous free tier.
//
// If you don't set RESEND_API_KEY, emails are simply skipped (logged to the
// Vercel function logs) — everything else in the app keeps working fine.

const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.EMAIL_FROM || 'Task Management <onboarding@resend.dev>';

export async function sendEmail(to, subject, html) {
  if (!RESEND_KEY) {
    console.log('[email skipped — RESEND_API_KEY not set]', subject, '->', to);
    return;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: FROM, to, subject, html })
    });
    if (!r.ok) {
      console.error('Resend email failed:', r.status, await r.text());
    }
  } catch (e) {
    console.error('Email send error:', e);
  }
}
