// ================================================================
// /api/app.js
// One serverless endpoint that replaces the whole Google Apps Script
// backend (Code.gs). The frontend posts { fn, params } here — same
// shape as the old google.script.run calls — and gets back the same
// { ok, ... } shaped responses, so index.html barely had to change.
// ================================================================
import { supabase } from '../lib/supabaseClient.js';
import { sendEmail } from '../lib/email.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, msg: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { fn, params } = body || {};

  if (!fn || typeof handlers[fn] !== 'function') {
    return res.status(400).json({ ok: false, msg: 'Unknown action: ' + fn });
  }

  try {
    const result = await handlers[fn](params || {});
    return res.status(200).json(result);
  } catch (e) {
    return res.status(200).json({ ok: false, msg: e.message || String(e) });
  }
}

// ---------------- shared helpers ----------------

function freqLabel(f) {
  return { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly', ott: 'One-Time' }[f] || f;
}

function fmtTime(d) {
  try {
    return new Date(d).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
    });
  } catch (e) { return String(d || ''); }
}

// DB rows are snake_case; the frontend expects the same camelCase
// field names the old Apps Script code used. These mappers bridge that.
function taskOut(t) {
  return {
    id: t.id, title: t.title, description: t.description || '', frequency: t.frequency,
    department: t.department, assigneeId: t.assignee_id, assigneeName: t.assignee_name,
    assignedById: t.assigned_by_id, assignedByName: t.assigned_by_name, priority: t.priority,
    startDate: t.start_date, dueDate: t.due_date, status: t.status, remarks: t.remarks || '',
    createdAt: t.created_at, completedAt: t.completed_at, recurringGroupId: t.recurring_group_id,
    active: t.active === false ? 'no' : 'yes'
  };
}
function userOut(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, dept: u.department };
}

async function getCaller(uid) {
  const id = String(uid || '').trim();
  const { data, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
  if (error || !data) throw new Error('Session expired. Please sign in again.');
  return data;
}

async function logActivity(empCode, name, action, taskId, title) {
  try {
    await supabase.from('activity_log').insert({
      emp_code: empCode, name, action, task_id: taskId || '', title: title || ''
    });
  } catch (e) { /* logging failures should never break the request */ }
}

// ---------------- handlers (1:1 with the old Code.gs functions) ----------------

const handlers = {

  async loginUser(p) {
    const email = String(p.email || '').toLowerCase().trim();
    const pass = String(p.password || '').trim();
    const { data: u } = await supabase.from('users').select('*').ilike('email', email).maybeSingle();
    if (!u || u.password !== pass) return { ok: false, msg: 'Invalid email or password.' };
    await logActivity(u.id, u.name, 'LOGIN', '', '');
    return { ok: true, user: userOut(u) };
  },

  async changePassword(p) {
    const caller = await getCaller(p.uid);
    if (caller.password !== String(p.oldPass || '')) return { ok: false, msg: 'Current password incorrect.' };
    const newp = String(p.newPass || '').trim();
    if (newp.length < 4) return { ok: false, msg: 'Password must be at least 4 characters.' };
    const { error } = await supabase.from('users').update({ password: newp }).eq('id', caller.id);
    if (error) return { ok: false, msg: error.message };
    return { ok: true, msg: 'Password updated.' };
  },

  async getUsers(p) {
    await getCaller(p.uid);
    const { data, error } = await supabase.from('users').select('*');
    if (error) return { ok: false, msg: error.message };
    return { ok: true, users: (data || []).map(userOut) };
  },

  async addUser(p) {
    const caller = await getCaller(p.uid);
    if (caller.role !== 'admin') return { ok: false, msg: 'Only admin can add users.' };
    const code = String(p.code || '').trim();
    const name = String(p.name || '').trim();
    const dept = String(p.dept || '').trim();
    const email = String(p.email || '').toLowerCase().trim();
    const pass = String(p.pass || '').trim();
    const role = String(p.role || 'user');
    if (!code || !name || !dept || !email || !pass) return { ok: false, msg: 'All fields required.' };

    const { data: existId } = await supabase.from('users').select('id').eq('id', code).maybeSingle();
    if (existId) return { ok: false, msg: 'Employee code already exists.' };
    const { data: existEmail } = await supabase.from('users').select('id').ilike('email', email).maybeSingle();
    if (existEmail) return { ok: false, msg: 'Email already registered.' };

    const { error } = await supabase.from('users').insert({ id: code, department: dept, name, email, password: pass, role });
    if (error) return { ok: false, msg: error.message };

    sendEmail(email, '[Task Management] Account Ready', welcomeHtml(name, code, email, pass, role, dept));
    return { ok: true, msg: name + ' added successfully.' };
  },

  async removeEmployee(p) {
    const caller = await getCaller(p.uid);
    if (caller.role !== 'admin') return { ok: false, msg: 'Only admin can remove employees.' };
    const empId = String(p.empId || '').trim();
    if (empId === caller.id) return { ok: false, msg: 'You cannot remove yourself.' };

    const { data: emp } = await supabase.from('users').select('*').eq('id', empId).maybeSingle();
    if (!emp) return { ok: false, msg: 'Employee not found.' };

    await supabase.from('tasks').update({ active: false }).eq('assignee_id', empId);
    const { error } = await supabase.from('users').delete().eq('id', empId);
    if (error) return { ok: false, msg: error.message };

    await logActivity(caller.id, caller.name, 'REMOVE_EMP', empId, emp.name);
    return { ok: true, msg: 'Employee removed and tasks deactivated.' };
  },

  async getTasks(p) {
    const caller = await getCaller(p.uid);
    let q = supabase.from('tasks').select('*').neq('active', false);
    if (caller.role === 'user') q = q.eq('assignee_id', caller.id);
    else if (caller.role === 'manager') q = q.ilike('department', caller.department || '');
    if (p.freq && p.freq !== 'all') q = q.eq('frequency', p.freq);
    if (p.status && p.status !== 'all') q = q.eq('status', p.status);
    const { data, error } = await q.order('created_at', { ascending: true });
    if (error) return { ok: false, msg: error.message };
    return { ok: true, tasks: (data || []).map(taskOut) };
  },

  async addTask(p) {
    const caller = await getCaller(p.uid);
    if (caller.role === 'user') return { ok: false, msg: 'Only admin or manager can assign tasks.' };
    const title = String(p.title || '').trim();
    const freq = String(p.freq || '').trim();
    const aId = String(p.assigneeId || '').trim();
    const dept = String(p.dept || '').trim();
    const start = String(p.startDate || '').trim();
    const due = String(p.dueDate || '').trim();
    if (!title || !freq || !aId || !dept || !start || !due) return { ok: false, msg: 'All fields required.' };
    if (start > due) return { ok: false, msg: 'Start date cannot be after due date.' };

    const { data: assignee } = await supabase.from('users').select('*').eq('id', aId).maybeSingle();
    if (!assignee) return { ok: false, msg: 'Assignee not found.' };

    const gid = 'GRP' + Date.now();
    const taskId = 'T' + Date.now();
    const prio = String(p.priority || 'medium');
    const desc = String(p.description || '');

    const { error } = await supabase.from('tasks').insert({
      id: taskId, title, description: desc, frequency: freq, department: dept,
      assignee_id: assignee.id, assignee_name: assignee.name,
      assigned_by_id: caller.id, assigned_by_name: caller.name,
      priority: prio, start_date: start, due_date: due, status: 'pending',
      remarks: '', recurring_group_id: gid, active: true
    });
    if (error) return { ok: false, msg: error.message };

    await logActivity(caller.id, caller.name, 'ASSIGN', taskId, title);
    sendEmail(assignee.email, '[Task Management] New Task: ' + title,
      taskHtml(assignee.name, { title, desc, freq, dept, prio, start, due, by: caller.name, code: assignee.id }));

    return { ok: true, msg: 'Task assigned to ' + assignee.name + '.' };
  },

  async updateStatus(p) {
    const caller = await getCaller(p.uid);
    const taskId = String(p.taskId || '').trim();
    const status = String(p.status || '').trim();
    const remarks = String(p.remarks || '').trim();
    const valid = ['pending', 'in-progress', 'done', 'not-done', 'hold'];
    if (!taskId || valid.indexOf(status) < 0) return { ok: false, msg: 'Invalid request.' };
    if ((status === 'not-done' || status === 'hold') && !remarks) return { ok: false, msg: 'Remarks required for Not Done / On Hold.' };

    const { data: t } = await supabase.from('tasks').select('*').eq('id', taskId).maybeSingle();
    if (!t) return { ok: false, msg: 'Task not found.' };
    if (caller.role === 'user' && t.assignee_id !== caller.id) return { ok: false, msg: 'You can only update your own tasks.' };

    const update = { status, remarks };
    if (status === 'done' || status === 'not-done') update.completed_at = new Date().toISOString();

    const { error } = await supabase.from('tasks').update(update).eq('id', taskId);
    if (error) return { ok: false, msg: error.message };

    await logActivity(caller.id, caller.name, 'STATUS:' + status, taskId, t.title);
    return { ok: true, msg: 'Task updated to: ' + status };
  },

  async removeTask(p) {
    const caller = await getCaller(p.uid);
    if (caller.role === 'user') return { ok: false, msg: 'Only admin or manager can remove tasks.' };
    const taskId = String(p.taskId || '').trim();
    const stopAll = p.stopAll === true;

    const { data: t } = await supabase.from('tasks').select('*').eq('id', taskId).maybeSingle();
    if (!t) return { ok: false, msg: 'Task not found.' };

    if (stopAll && t.recurring_group_id) {
      const { data: group } = await supabase.from('tasks').select('id, status').eq('recurring_group_id', t.recurring_group_id);
      await supabase.from('tasks').update({ active: false }).eq('recurring_group_id', t.recurring_group_id);
      const pendingIds = (group || []).filter(x => x.status === 'pending').map(x => x.id);
      if (pendingIds.length) await supabase.from('tasks').delete().in('id', pendingIds);
      await logActivity(caller.id, caller.name, 'STOP_RECUR', t.recurring_group_id, t.title);
      return { ok: true, msg: 'Recurring task stopped. ' + pendingIds.length + ' pending instance(s) removed.' };
    } else {
      await supabase.from('tasks').delete().eq('id', taskId);
      await logActivity(caller.id, caller.name, 'DELETE', taskId, t.title);
      return { ok: true, msg: 'Task deleted.' };
    }
  },

  async getDashboard(p) {
    const caller = await getCaller(p.uid);
    const callerDept = (caller.department || '').toLowerCase();

    const { data: allTasks } = await supabase.from('tasks').select('*').neq('active', false);
    const { data: allUsers } = await supabase.from('users').select('*');
    const tasks = allTasks || [];
    const users = allUsers || [];

    let scope;
    if (caller.role === 'user') scope = tasks.filter(t => t.assignee_id === caller.id);
    else if (caller.role === 'manager') scope = tasks.filter(t => (t.department || '').toLowerCase() === callerDept);
    else scope = tasks;

    const total = scope.length;
    const done = scope.filter(t => t.status === 'done').length;
    const prog = scope.filter(t => t.status === 'in-progress').length;
    const pending = scope.filter(t => t.status === 'pending').length;
    const notDone = scope.filter(t => t.status === 'not-done').length;
    const hold = scope.filter(t => t.status === 'hold').length;

    let onTime = 0, delayed = 0;
    scope.forEach(t => {
      if ((t.status === 'done' || t.status === 'not-done') && t.completed_at && t.due_date) {
        const due = new Date(t.due_date); due.setHours(23, 59, 59);
        const comp = new Date(t.completed_at);
        if (!isNaN(due) && !isNaN(comp)) { if (comp <= due) onTime++; else delayed++; }
      }
    });

    const freqStats = {};
    ['daily', 'weekly', 'monthly', 'yearly', 'ott'].forEach(f => {
      const ft = scope.filter(t => t.frequency === f);
      freqStats[f] = { total: ft.length, done: ft.filter(t => t.status === 'done').length };
    });

    let teamStats = [];
    if (caller.role !== 'user') {
      const showUsers = caller.role === 'manager'
        ? users.filter(u => (u.department || '').toLowerCase() === callerDept)
        : users;
      teamStats = showUsers.map(u => {
        const ut = tasks.filter(t => t.assignee_id === u.id);
        return {
          id: u.id, name: u.name, email: u.email, role: u.role, dept: u.department,
          total: ut.length,
          done: ut.filter(t => t.status === 'done').length,
          prog: ut.filter(t => t.status === 'in-progress').length,
          pending: ut.filter(t => t.status === 'pending').length,
          notDone: ut.filter(t => t.status === 'not-done').length,
          hold: ut.filter(t => t.status === 'hold').length
        };
      });
    }

    const recent = tasks.slice(-5).reverse().map(taskOut);
    const myPending = tasks
      .filter(t => t.assignee_id === caller.id && (t.status === 'pending' || t.status === 'in-progress'))
      .slice(0, 8).map(taskOut);

    return { ok: true, stats: { total, done, prog, pending, notDone, hold, onTime, delayed }, freqStats, teamStats, recent, myPending };
  },

  async bulkAddTasks(p) {
    const caller = await getCaller(p.uid);
    if (caller.role !== 'admin' && caller.role !== 'manager') return { ok: false, msg: 'Only admin or manager can assign tasks.' };

    const tasksIn = p.tasks || [];
    const freq = String(p.freq || '').trim();
    const dept = String(p.dept || '').trim();
    const assignId = String(p.assigneeId || '').trim();
    const priority = String(p.priority || 'medium');
    if (!tasksIn.length || !freq || !dept || !assignId) return { ok: false, msg: 'Missing required fields.' };

    const { data: assignee } = await supabase.from('users').select('*').eq('id', assignId).maybeSingle();
    if (!assignee) return { ok: false, msg: 'Assignee not found.' };

    const rows = [];
    const errors = [];
    tasksIn.forEach((t, i) => {
      const title = String(t.title || '').trim();
      const start = String(t.startDate || '').trim();
      const due = String(t.dueDate || '').trim();
      if (!title || !start || !due) { errors.push('Skipped empty row'); return; }
      if (start > due) { errors.push(title + ': start > due'); return; }
      rows.push({
        id: 'T' + Date.now() + i, title, description: '', frequency: freq, department: dept,
        assignee_id: assignee.id, assignee_name: assignee.name,
        assigned_by_id: caller.id, assigned_by_name: caller.name,
        priority, start_date: start, due_date: due, status: 'pending', remarks: '',
        recurring_group_id: 'GRP' + Date.now() + i, active: true
      });
    });

    if (rows.length) {
      const { error } = await supabase.from('tasks').insert(rows);
      if (error) return { ok: false, msg: error.message };
    }

    await logActivity(caller.id, caller.name, 'BULK_ASSIGN', '', rows.length + ' tasks to ' + assignee.name);
    if (rows.length) {
      sendEmail(assignee.email, `[Task Management] ${rows.length} new tasks assigned to you`,
        bulkHtml(assignee.name, rows.length, dept, freq, caller.name));
    }

    let msg = rows.length + ' task' + (rows.length !== 1 ? 's' : '') + ' assigned to ' + assignee.name + '.';
    if (errors.length) msg += ' (' + errors.length + ' skipped)';
    return { ok: true, msg, created: rows.length, errors };
  },

  async bulkUpdateStatus(p) {
    const caller = await getCaller(p.uid);
    const taskIds = p.taskIds || [];
    const status = String(p.status || 'done');
    const remarks = String(p.remarks || '');
    if (!taskIds.length) return { ok: false, msg: 'No task IDs provided.' };
    const valid = ['pending', 'in-progress', 'done', 'not-done', 'hold'];
    if (valid.indexOf(status) < 0) return { ok: false, msg: 'Invalid status.' };

    const { data: rows } = await supabase.from('tasks').select('id, assignee_id, title').in('id', taskIds);
    let allowedIds = (rows || []).map(r => r.id);
    if (caller.role === 'user') allowedIds = (rows || []).filter(r => r.assignee_id === caller.id).map(r => r.id);
    if (!allowedIds.length) return { ok: true, msg: '0 task(s) updated.', updated: 0 };

    const update = { status, remarks };
    if (status === 'done' || status === 'not-done') update.completed_at = new Date().toISOString();

    const { error } = await supabase.from('tasks').update(update).in('id', allowedIds);
    if (error) return { ok: false, msg: error.message };

    for (const r of (rows || []).filter(r => allowedIds.includes(r.id))) {
      await logActivity(caller.id, caller.name, 'BULK_STATUS:' + status, r.id, r.title);
    }
    return { ok: true, msg: allowedIds.length + ' task(s) marked as ' + status + '.', updated: allowedIds.length };
  },

  async getNotices(p) {
    await getCaller(p.uid);
    const { data, error } = await supabase.from('notices').select('*').order('created_at', { ascending: true });
    if (error) return { ok: false, msg: error.message };
    return {
      ok: true,
      notices: (data || []).map(n => ({
        id: n.id, byId: n.by_id, byName: n.by_name, byRole: n.by_role,
        msg: n.msg, meetLink: n.meet_link || '', time: fmtTime(n.created_at)
      }))
    };
  },

  async addNotice(p) {
    const caller = await getCaller(p.uid);
    const msg = String(p.msg || '').trim();
    const meetLink = String(p.meetLink || '').trim();
    if (!msg) return { ok: false, msg: 'Message cannot be empty.' };

    const nid = 'N' + Date.now();
    const { error } = await supabase.from('notices').insert({
      id: nid, by_id: caller.id, by_name: caller.name, by_role: caller.role, msg, meet_link: meetLink
    });
    if (error) return { ok: false, msg: error.message };

    if (meetLink) {
      const { data: users } = await supabase.from('users').select('*');
      (users || []).forEach(u => {
        if (u.id === caller.id) return;
        sendEmail(u.email, `[Task Management] ${caller.name} shared a meeting link`, meetHtml(caller.name, msg, meetLink));
      });
    }
    return { ok: true, msg: 'Announcement posted.' + (meetLink ? ' Meeting link shared with team!' : '') };
  },

  async deleteNotice(p) {
    const caller = await getCaller(p.uid);
    const { data: list } = await supabase.from('notices').select('*').order('created_at', { ascending: true });
    const idx = parseInt(p.noticeIdx, 10);
    if (isNaN(idx) || !list || idx < 0 || idx >= list.length) return { ok: false, msg: 'Invalid notice index.' };
    const n = list[idx];
    if (caller.role !== 'admin' && n.by_id !== caller.id) return { ok: false, msg: 'You can only delete your own notices.' };
    const { error } = await supabase.from('notices').delete().eq('id', n.id);
    if (error) return { ok: false, msg: error.message };
    return { ok: true, msg: 'Notice deleted.' };
  }
};

// ---------------- email templates (trimmed versions of the Apps Script originals) ----------------

function welcomeHtml(name, code, email, pass, role, dept) {
  return `<div style="font-family:Arial;max-width:460px;margin:0 auto">
    <div style="background:#0F172A;padding:16px 20px"><div style="font-size:15px;font-weight:700;color:#fff">Task Management System</div></div>
    <div style="padding:20px;background:#fff">
      <p style="font-size:14px;color:#1e293b">Welcome <strong>${name}</strong>! Your account is ready.</p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;margin:12px 0">
        <p style="margin:0 0 7px;font-size:13px"><strong>Employee Code:</strong> ${code}</p>
        <p style="margin:0 0 7px;font-size:13px"><strong>Email:</strong> ${email}</p>
        <p style="margin:0 0 7px;font-size:13px"><strong>Password:</strong> ${pass}</p>
        <p style="margin:0 0 7px;font-size:13px"><strong>Role:</strong> ${role}</p>
        <p style="margin:0;font-size:13px"><strong>Department:</strong> ${dept}</p>
      </div>
      <p style="font-size:12px;color:#94a3b8">Please change your password after first login.</p>
    </div></div>`;
}

function taskHtml(name, t) {
  return `<div style="font-family:Arial;max-width:520px;margin:0 auto">
    <div style="background:#0F172A;padding:20px 24px"><div style="font-size:16px;font-weight:700;color:#fff">Task Management System</div>
    <div style="font-size:12px;color:#94a3b8;margin-top:2px">New task assigned to you</div></div>
    <div style="padding:22px;background:#fff">
      <p style="font-size:14px;color:#1e293b">Hi <strong>${name}</strong>,</p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:14px 0">
        <div style="font-size:15px;font-weight:700;color:#0f172a;margin-bottom:12px">${t.title}</div>
        <p style="font-size:13px;color:#334155;margin:4px 0"><strong>Dept:</strong> ${t.dept} &nbsp; <strong>Frequency:</strong> ${freqLabel(t.freq)}</p>
        <p style="font-size:13px;color:#334155;margin:4px 0"><strong>Assigned By:</strong> ${t.by} &nbsp; <strong>Priority:</strong> ${String(t.prio).toUpperCase()}</p>
        <p style="font-size:13px;color:#334155;margin:4px 0"><strong>Start:</strong> ${t.start} &nbsp; <strong>Due:</strong> ${t.due}</p>
        ${t.desc ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0;font-size:13px;color:#475569">${t.desc}</div>` : ''}
      </div></div></div>`;
}

function bulkHtml(name, count, dept, freq, by) {
  return `<div style="font-family:Arial;max-width:500px;margin:0 auto">
    <div style="background:#0F172A;padding:18px 22px"><div style="font-size:15px;font-weight:700;color:#fff">Task Management System</div></div>
    <div style="padding:20px;background:#fff">
      <p style="font-size:14px;color:#1e293b">Hi <strong>${name}</strong>,</p>
      <p style="font-size:13px;color:#475569"><strong>${count}</strong> new tasks have been assigned to you by <strong>${by}</strong> (${dept}, ${freqLabel(freq)}).</p>
    </div></div>`;
}

function meetHtml(by, msg, link) {
  return `<div style="font-family:Arial;max-width:500px;margin:0 auto">
    <div style="background:#1E1B4B;padding:16px 20px;border-radius:10px 10px 0 0"><div style="font-size:15px;font-weight:700;color:#fff">Meeting Invitation</div></div>
    <div style="padding:20px;background:#fff;border-radius:0 0 10px 10px;border:1px solid #E2E8F0">
      <p><strong>${by}</strong> has invited you to a meeting.</p>
      <p style="margin:10px 0;padding:12px;background:#F8FAFF;border-radius:8px;border-left:3px solid #6366F1">${msg}</p>
      <a href="${link}" style="display:inline-block;background:#10B981;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:10px">📹 Join Meeting</a>
    </div></div>`;
}
