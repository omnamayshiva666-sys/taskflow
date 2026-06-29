// Replaces the Apps Script time-driven trigger: autoRecurring()
// Vercel calls this automatically every day per vercel.json's "crons" config.
import { supabase } from '../lib/supabaseClient.js';

export default async function handler(req, res) {
  // Vercel automatically sends "Authorization: Bearer <CRON_SECRET>" for cron
  // requests if you set a CRON_SECRET env var — this blocks anyone else from
  // triggering the endpoint.
  if (process.env.CRON_SECRET && req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, msg: 'Unauthorized' });
  }

  const today = new Date().toISOString().slice(0, 10);
  const { data: tasks } = await supabase.from('tasks').select('*');
  const list = tasks || [];

  const pendingToday = {};
  list.forEach(t => {
    if (t.status === 'pending' && t.due_date === today && t.recurring_group_id) pendingToday[t.recurring_group_id] = true;
  });

  const newRows = [];
  list.forEach(t => {
    if (!t.id || t.active === false) return;
    if (t.status !== 'done' && t.status !== 'not-done') return;
    if (!t.recurring_group_id || t.frequency === 'ott') return;
    if (pendingToday[t.recurring_group_id]) return;

    const start = new Date(t.start_date || t.due_date);
    const next = new Date(t.due_date);
    if (t.frequency === 'daily') next.setDate(next.getDate() + 1);
    else if (t.frequency === 'weekly') next.setDate(next.getDate() + 7);
    else if (t.frequency === 'monthly') { next.setMonth(next.getMonth() + 1); next.setDate(start.getDate()); }
    else if (t.frequency === 'yearly') { next.setFullYear(next.getFullYear() + 1); next.setMonth(start.getMonth()); next.setDate(start.getDate()); }

    const nextStr = next.toISOString().slice(0, 10);
    if (nextStr !== today) return;

    newRows.push({
      id: 'T' + Date.now() + Math.floor(Math.random() * 999),
      title: t.title, description: t.description, frequency: t.frequency, department: t.department,
      assignee_id: t.assignee_id, assignee_name: t.assignee_name,
      assigned_by_id: t.assigned_by_id, assigned_by_name: t.assigned_by_name,
      priority: t.priority, start_date: today, due_date: today, status: 'pending', remarks: '',
      recurring_group_id: t.recurring_group_id, active: true
    });
    pendingToday[t.recurring_group_id] = true;
  });

  if (newRows.length) await supabase.from('tasks').insert(newRows);
  return res.status(200).json({ ok: true, created: newRows.length });
}
