// Replaces the Apps Script time-driven trigger: dailyReminder()
import { supabase } from '../lib/supabaseClient.js';
import { sendEmail } from '../lib/email.js';

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, msg: 'Unauthorized' });
  }

  const today = new Date().toISOString().slice(0, 10);
  const { data: tasks } = await supabase.from('tasks').select('*').neq('active', false);
  const { data: users } = await supabase.from('users').select('*');

  const byEmp = {};
  (tasks || []).forEach(t => {
    if (t.status !== 'pending' && t.status !== 'in-progress') return;
    if (!byEmp[t.assignee_id]) byEmp[t.assignee_id] = [];
    byEmp[t.assignee_id].push(t);
  });

  let sent = 0;
  for (const u of (users || [])) {
    const mine = (byEmp[u.id] || []).filter(t => t.due_date <= today);
    if (!mine.length) continue;

    const rows = mine.map(t => {
      const late = t.due_date < today;
      return `<tr><td style="padding:7px 12px;border-bottom:1px solid #f1f5f9;font-size:13px">${t.title}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#64748B">${t.department}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;font-weight:600;color:${late ? '#F43F5E' : '#F59E0B'}">${t.due_date}${late ? ' (Overdue)' : ''}</td></tr>`;
    }).join('');

    const html = `<div style="font-family:Arial;max-width:500px;margin:0 auto">
      <div style="background:#0F172A;padding:16px 20px;border-radius:10px 10px 0 0"><div style="font-size:15px;font-weight:700;color:#fff">Daily Task Reminder</div></div>
      <div style="background:#fff;padding:20px;border:1px solid #e2e8f0;border-radius:0 0 10px 10px">
        <p style="font-size:14px;color:#1e293b">Hi <strong>${u.name}</strong>, you have <strong>${mine.length}</strong> task(s) due:</p>
        <table style="width:100%;border-collapse:collapse;margin:12px 0"><tbody>${rows}</tbody></table>
      </div></div>`;

    await sendEmail(u.email, `[Task Management] ${mine.length} task(s) due today`, html);
    sent++;
  }

  return res.status(200).json({ ok: true, remindersSent: sent });
}
