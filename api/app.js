// ================================================================
// /api/app.js
// Backend for the Task Management System.
//
// ROLE SYSTEM (5 levels):
//   superadmin -- full control over everything. ONLY superadmin can
//                 assign/change someone's L1/L2/L3 level (or promote
//                 to admin/superadmin).
//   admin      -- can ADD members and tasks. Can NEVER remove/delete
//                 anything (no employee removal, no task removal),
//                 no matter whose data it is.
//   l1 (HOD)   -- sees + updates ALL data of their team: themselves,
//                 every L2 who reports to them, and every L3 who
//                 reports to those L2s. Can also remove tasks/members
//                 within their own team.
//   l2 (manager) -- sees their L3 reports' data (read-only -- cannot
//                 update an L3's task status). Can update only their
//                 own tasks. Cannot remove anything.
//   l3 (user)  -- sees + updates only their own tasks. Cannot remove
//                 anything.
//
// Hierarchy is stored via users.reports_to (the id of the person one
// level above). L1s normally have reports_to = null.
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

// ---------------- role helpers ----------------

const ROLE_LABEL = { superadmin: 'Super Admin', admin: 'Admin', l1: 'L1 (HOD)', l2: 'L2 (Manager)', l3: 'L3 (User)' };

function canSeeEverything(role) {
  return role === 'superadmin' || role === 'admin';
}
function canRemoveAnything(role) {
  return role === 'superadmin';
}
function canManageTeam(role) {
  // who can add members / assign tasks to others
  return role === 'superadmin' || role === 'admin' || role === 'l1' || role === 'l2';
}

// Build a map of userId -> [direct reports] from the full user list.
function buildReportsMap(users) {
  const map = {};
  users.forEach(u => {
    const sup = u.reports_to;
    if (!sup) return;
    if (!map[sup]) map[sup] = [];
    map[sup].push(u.id);
  });
  return map;
}

// Returns: self + every descendant (direct and indirect reports) of rootId.
function getTeamIds(users, rootId) {
  const map = buildReportsMap(users);
  const result = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const cur = queue.shift();
    (map[cur] || []).forEach(child => {
      if (!result.has(child)) { result.add(child); queue.push(child); }
    });
  }
  return Array.from(result);
}

// Returns: self + everyone ABOVE rootId in the reports_to chain (their boss,
// their boss's boss, etc). Used so a message from an L3 can still reach
// their L2/L1 superiors, not just flow downward.
function getAncestorIds(users, rootId) {
  const byId = {};
  users.forEach(u => { byId[u.id] = u; });
  const result = [rootId];
  let cur = byId[rootId];
  while (cur && cur.reports_to && byId[cur.reports_to] && result.indexOf(cur.reports_to) < 0) {
    result.push(cur.reports_to);
    cur = byId[cur.reports_to];
  }
  return result;
}

// "Vertical team" for notices: self + everyone below (their team) +
// everyone above (their chain of superiors). This is what makes an L1's
// notice reach their whole team, and an L3's notice still reach their
// manager/HOD above them.
function getNoticeAudience(users, rootId) {
  const down = getTeamIds(users, rootId);
  const up = getAncestorIds(users, rootId);
  return Array.from(new Set([...down, ...up]));
}

// Given the caller and the full user list, returns the set of user ids
// whose TASKS the caller is allowed to see.
function visibleAssigneeIds(caller, users) {
  if (canSeeEverything(caller.role)) return null; // null = no restriction, see all
  if (caller.role === 'l1') return getTeamIds(users, caller.id);
  if (caller.role === 'l2') return getTeamIds(users, caller.id); // self + their l3 reports
  return [caller.id]; // l3: only self
}

// Whether `caller` is allowed to UPDATE (mark status of) a task assigned to `assigneeId`.
function canUpdateTaskOf(caller, assigneeId, users) {
  if (caller.role === 'superadmin' || caller.role === 'admin') return true;
  if (caller.role === 'l1') return getTeamIds(users, caller.id).includes(assigneeId);
  // l2 and l3 can only update their OWN tasks, never a subordinate's
  return assigneeId === caller.id;
}

// Whether `caller` is allowed to REMOVE/DELETE a task assigned to `assigneeId`.
function canRemoveTaskOf(caller, assigneeId, users) {
  if (caller.role === 'superadmin') return true;
  if (caller.role === 'l1') return getTeamIds(users, caller.id).includes(assigneeId);
  return false; // admin, l2, l3 can never remove tasks
}

// Whether `caller` can add a task FOR `assigneeId` (assign to them).
function canAssignTaskTo(caller, assigneeId, users) {
  if (caller.role === 'superadmin' || caller.role === 'admin') return true;
  if (caller.role === 'l1') return getTeamIds(users, caller.id).includes(assigneeId);
  if (caller.role === 'l2') return getTeamIds(users, caller.id).includes(assigneeId); // self or their l3s
  return false; // l3 cannot assign tasks to anyone
}

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
  return { id: u.id, name: u.name, email: u.email, role: u.role, roleLabel: ROLE_LABEL[u.role] || u.role, dept: u.department, reportsTo: u.reports_to || '' };
}

async function getCaller(uid) {
  const id = String(uid || '').trim();
  const { data, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
  if (error || !data) throw new Error('Session expired. Please sign in again.');
  return data;
}
async function getAllUsers() {
  const { data } = await supabase.from('users').select('*');
  return data || [];
}

async function logActivity(empCode, name, action, taskId, title) {
  try {
    await supabase.from('activity_log').insert({ emp_code: empCode, name, action, task_id: taskId || '', title: title || '' });
  } catch (e) { /* never break the request over a logging failure */ }
}

// ---------------- handlers ----------------

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
    if (!canManageTeam(caller.role) && caller.role !== 'l1') return { ok: false, msg: 'You do not have permission to add members.' };
    if (caller.role === 'l2' || caller.role === 'l3') return { ok: false, msg: 'You do not have permission to add members.' };

    const code = String(p.code || '').trim();
    const name = String(p.name || '').trim();
    const dept = String(p.dept || '').trim();
    const email = String(p.email || '').toLowerCase().trim();
    const pass = String(p.pass || '').trim();
    let role = String(p.role || 'l3').trim();
    let reportsTo = String(p.reportsTo || '').trim() || null;

    if (!code || !name || !dept || !email || !pass) return { ok: false, msg: 'All fields required.' };

    // Only superadmin may grant superadmin/admin/l1, or pick an arbitrary level.
    // admin and l1 can only create L2/L3 members under themselves.
    if (caller.role !== 'superadmin') {
      if (['superadmin', 'admin', 'l1'].includes(role)) {
        return { ok: false, msg: 'Only Super Admin can assign that role/level.' };
      }
      if (caller.role === 'l1') {
        // l1 adding members: must be l2 or l3 within their own team
        if (!['l2', 'l3'].includes(role)) role = 'l3';
        if (!reportsTo) reportsTo = caller.id;
      }
      if (caller.role === 'admin') {
        // admin can only create l3 (basic) members
        role = 'l3';
      }
    }

    const { data: existId } = await supabase.from('users').select('id').eq('id', code).maybeSingle();
    if (existId) return { ok: false, msg: 'Employee code already exists.' };
    const { data: existEmail } = await supabase.from('users').select('id').ilike('email', email).maybeSingle();
    if (existEmail) return { ok: false, msg: 'Email already registered.' };

    const { error } = await supabase.from('users').insert({
      id: code, department: dept, name, email, password: pass, role, reports_to: reportsTo
    });
    if (error) return { ok: false, msg: error.message };

    sendEmail(email, '[Task Management] Account Ready', welcomeHtml(name, code, email, pass, ROLE_LABEL[role] || role, dept));
    return { ok: true, msg: name + ' added successfully as ' + (ROLE_LABEL[role] || role) + '.' };
  },

  async removeEmployee(p) {
    const caller = await getCaller(p.uid);
    const empId = String(p.empId || '').trim();
    if (empId === caller.id) return { ok: false, msg: 'You cannot remove yourself.' };

    const users = await getAllUsers();
    const { data: emp } = await supabase.from('users').select('*').eq('id', empId).maybeSingle();
    if (!emp) return { ok: false, msg: 'Employee not found.' };

    const allowed = caller.role === 'superadmin' || (caller.role === 'l1' && getTeamIds(users, caller.id).includes(empId));
    if (!allowed) return { ok: false, msg: 'You do not have permission to remove this employee.' };

    await supabase.from('tasks').update({ active: false }).eq('assignee_id', empId);
    const { error } = await supabase.from('users').delete().eq('id', empId);
    if (error) return { ok: false, msg: error.message };

    await logActivity(caller.id, caller.name, 'REMOVE_EMP', empId, emp.name);
    return { ok: true, msg: 'Employee removed and tasks deactivated.' };
  },

  async getTasks(p) {
    const caller = await getCaller(p.uid);
    const users = await getAllUsers();
    const visible = visibleAssigneeIds(caller, users); // null = everyone

    let q = supabase.from('tasks').select('*').neq('active', false);
    if (visible) q = q.in('assignee_id', visible);
    if (p.freq && p.freq !== 'all') q = q.eq('frequency', p.freq);
    if (p.status && p.status !== 'all') q = q.eq('status', p.status);
    const { data, error } = await q.order('created_at', { ascending: true });
    if (error) return { ok: false, msg: error.message };

    const out = (data || []).map(t => {
      const o = taskOut(t);
      o.canUpdate = canUpdateTaskOf(caller, t.assignee_id, users);
      o.canRemove = canRemoveTaskOf(caller, t.assignee_id, users);
      return o;
    });
    return { ok: true, tasks: out };
  },

  async addTask(p) {
    const caller = await getCaller(p.uid);
    if (caller.role === 'l3') return { ok: false, msg: 'You do not have permission to assign tasks.' };

    const title = String(p.title || '').trim();
    const freq = String(p.freq || '').trim();
    const aId = String(p.assigneeId || '').trim();
    const dept = String(p.dept || '').trim();
    const start = String(p.startDate || '').trim();
    const due = String(p.dueDate || '').trim();
    if (!title || !freq || !aId || !dept || !start || !due) return { ok: false, msg: 'All fields required.' };
    if (start > due) return { ok: false, msg: 'Start date cannot be after due date.' };

    const users = await getAllUsers();
    if (!canAssignTaskTo(caller, aId, users)) return { ok: false, msg: 'You can only assign tasks within your own team.' };

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

    const users = await getAllUsers();
    if (!canUpdateTaskOf(caller, t.assignee_id, users)) return { ok: false, msg: 'You do not have permission to update this task.' };

    const update = { status, remarks };
    if (status === 'done' || status === 'not-done') update.completed_at = new Date().toISOString();

    const { error } = await supabase.from('tasks').update(update).eq('id', taskId);
    if (error) return { ok: false, msg: error.message };

    await logActivity(caller.id, caller.name, 'STATUS:' + status, taskId, t.title);
    return { ok: true, msg: 'Task updated to: ' + status };
  },

  async removeTask(p) {
    const caller = await getCaller(p.uid);
    const taskId = String(p.taskId || '').trim();
    const stopAll = p.stopAll === true;

    const { data: t } = await supabase.from('tasks').select('*').eq('id', taskId).maybeSingle();
    if (!t) return { ok: false, msg: 'Task not found.' };

    const users = await getAllUsers();
    if (!canRemoveTaskOf(caller, t.assignee_id, users)) {
      return { ok: false, msg: 'You do not have permission to remove tasks. (Admin can add tasks but not remove them; L2/L3 can only update their own tasks.)' };
    }

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
    const allTasks = (await supabase.from('tasks').select('*').neq('active', false)).data || [];
    const allUsers = await getAllUsers();

    const visible = visibleAssigneeIds(caller, allUsers);
    const scope = visible ? allTasks.filter(t => visible.includes(t.assignee_id)) : allTasks;

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

    // Team stats: who shows up in the "Team Stats" table
    let teamStats = [];
    if (canSeeEverything(caller.role)) {
      teamStats = allUsers;
    } else if (caller.role === 'l1' || caller.role === 'l2') {
      const ids = getTeamIds(allUsers, caller.id);
      teamStats = allUsers.filter(u => ids.includes(u.id));
    } // l3 sees no team table (handled in frontend by hiding the nav item)

    teamStats = teamStats.map(u => {
      const ut = allTasks.filter(t => t.assignee_id === u.id);
      return {
        id: u.id, name: u.name, email: u.email, role: u.role, roleLabel: ROLE_LABEL[u.role] || u.role, dept: u.department,
        total: ut.length,
        done: ut.filter(t => t.status === 'done').length,
        prog: ut.filter(t => t.status === 'in-progress').length,
        pending: ut.filter(t => t.status === 'pending').length,
        notDone: ut.filter(t => t.status === 'not-done').length,
        hold: ut.filter(t => t.status === 'hold').length,
        canRemove: caller.role === 'superadmin' || (caller.role === 'l1' && u.id !== caller.id && getTeamIds(allUsers, caller.id).includes(u.id))
      };
    });

    const recent = scope.slice(-5).reverse().map(taskOut);
    const myPending = allTasks
      .filter(t => t.assignee_id === caller.id && (t.status === 'pending' || t.status === 'in-progress'))
      .slice(0, 8).map(taskOut);

    return { ok: true, stats: { total, done, prog, pending, notDone, hold, onTime, delayed }, freqStats, teamStats, recent, myPending };
  },

  async bulkAddTasks(p) {
    const caller = await getCaller(p.uid);
    if (caller.role === 'l3') return { ok: false, msg: 'You do not have permission to assign tasks.' };

    const tasksIn = p.tasks || [];
    const freq = String(p.freq || '').trim();
    const dept = String(p.dept || '').trim();
    const assignId = String(p.assigneeId || '').trim();
    const priority = String(p.priority || 'medium');
    if (!tasksIn.length || !freq || !dept || !assignId) return { ok: false, msg: 'Missing required fields.' };

    const users = await getAllUsers();
    if (!canAssignTaskTo(caller, assignId, users)) return { ok: false, msg: 'You can only assign tasks within your own team.' };

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

    const users = await getAllUsers();
    const { data: rows } = await supabase.from('tasks').select('id, assignee_id, title').in('id', taskIds);
    const allowedIds = (rows || []).filter(r => canUpdateTaskOf(caller, r.assignee_id, users)).map(r => r.id);
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
    const caller = await getCaller(p.uid);
    const users = await getAllUsers();
    const { data, error } = await supabase.from('notices').select('*').order('created_at', { ascending: true });
    if (error) return { ok: false, msg: error.message };

    const seeAll = canSeeEverything(caller.role); // superadmin/admin see every notice
    const visible = (data || []).filter(n => {
      if (seeAll) return true;
      if (n.by_id === caller.id) return true;
      const aud = n.audience || [];
      return aud.includes(caller.id);
    });

    return {
      ok: true,
      notices: visible.map(n => ({
        id: n.id, byId: n.by_id, byName: n.by_name, byRole: n.by_role,
        msg: n.msg, meetLink: n.meet_link || '', time: fmtTime(n.created_at),
        canDelete: caller.role === 'superadmin' || caller.role === 'admin'
      }))
    };
  },

  async addNotice(p) {
    const caller = await getCaller(p.uid);
    const msg = String(p.msg || '').trim();
    const meetLink = String(p.meetLink || '').trim();
    if (!msg) return { ok: false, msg: 'Message cannot be empty.' };

    const users = await getAllUsers();
    // A notice reaches the sender's "vertical team": everyone below them
    // (their reports) and everyone above them (their managers/HOD), so an
    // L1 reaches their whole team and an L3's message still reaches their
    // manager chain. Super Admin/Admin can always see every notice anyway.
    const audience = getNoticeAudience(users, caller.id);

    const nid = 'N' + Date.now();
    const { error } = await supabase.from('notices').insert({
      id: nid, by_id: caller.id, by_name: caller.name, by_role: caller.role, msg, meet_link: meetLink, audience
    });
    if (error) return { ok: false, msg: error.message };

    return { ok: true, msg: 'Announcement posted to your team.' };
  },

  async deleteNotice(p) {
    const caller = await getCaller(p.uid);
    if (caller.role !== 'superadmin' && caller.role !== 'admin') {
      return { ok: false, msg: 'Only Admin or Super Admin can delete notices.' };
    }
    const noticeId = String(p.noticeId || '').trim();
    if (!noticeId) return { ok: false, msg: 'Invalid notice.' };
    const { error } = await supabase.from('notices').delete().eq('id', noticeId);
    if (error) return { ok: false, msg: error.message };
    return { ok: true, msg: 'Notice deleted.' };
  },

  // ---------------- MEETINGS ----------------

  async createMeeting(p) {
    const caller = await getCaller(p.uid);
    const title = String(p.title || '').trim();
    const date = String(p.date || '').trim();
    const time = String(p.time || '').trim();
    let participants = Array.isArray(p.participantIds) ? p.participantIds.map(String) : [];
    if (!title || !date) return { ok: false, msg: 'Meeting title and date are required.' };
    if (!participants.length) return { ok: false, msg: 'Select at least one participant.' };
    if (!participants.includes(caller.id)) participants.push(caller.id);

    const users = await getAllUsers();
    const byId = {}; users.forEach(u => { byId[u.id] = u; });
    participants = participants.filter(id => byId[id]); // drop unknown ids

    const mid = 'M' + Date.now();
    const meetLink = 'https://meet.google.com/new';
    const { error } = await supabase.from('meetings').insert({
      id: mid, title, meeting_date: date, meeting_time: time,
      created_by: caller.id, created_by_name: caller.name,
      participants, meet_link: meetLink
    });
    if (error) return { ok: false, msg: error.message };

    // Auto-post a notice visible ONLY to the invited participants, so it
    // shows up in Notices with just the meeting link (per your request).
    const dateLabel = time ? `${date} at ${time}` : date;
    const nid = 'N' + Date.now();
    await supabase.from('notices').insert({
      id: nid, by_id: caller.id, by_name: caller.name, by_role: caller.role,
      msg: `📅 Meeting scheduled: "${title}" on ${dateLabel}`,
      meet_link: meetLink, audience: participants
    });

    participants.filter(id => id !== caller.id).forEach(id => {
      const u = byId[id];
      if (u) sendEmail(u.email, `[Task Management] Meeting scheduled: ${title}`, meetingHtml(caller.name, title, dateLabel, meetLink));
    });

    return { ok: true, msg: 'Meeting scheduled with ' + participants.length + ' participant(s).' };
  },

  async getMeetings(p) {
    const caller = await getCaller(p.uid);
    const { data, error } = await supabase.from('meetings').select('*').order('meeting_date', { ascending: true });
    if (error) return { ok: false, msg: error.message };
    const seeAll = canSeeEverything(caller.role);
    const list = (data || []).filter(m => seeAll || (m.participants || []).includes(caller.id));
    return {
      ok: true,
      meetings: list.map(m => ({
        id: m.id, title: m.title, date: m.meeting_date, time: m.meeting_time || '',
        createdBy: m.created_by, createdByName: m.created_by_name,
        participants: m.participants || [], meetLink: m.meet_link,
        canCancel: caller.role === 'superadmin' || caller.role === 'admin' || m.created_by === caller.id
      }))
    };
  },

  async cancelMeeting(p) {
    const caller = await getCaller(p.uid);
    const meetingId = String(p.meetingId || '').trim();
    const { data: m } = await supabase.from('meetings').select('*').eq('id', meetingId).maybeSingle();
    if (!m) return { ok: false, msg: 'Meeting not found.' };
    const allowed = caller.role === 'superadmin' || caller.role === 'admin' || m.created_by === caller.id;
    if (!allowed) return { ok: false, msg: 'You cannot cancel this meeting.' };
    const { error } = await supabase.from('meetings').delete().eq('id', meetingId);
    if (error) return { ok: false, msg: error.message };
    return { ok: true, msg: 'Meeting cancelled.' };
  },

  // ---------------- CHAT / MESSAGES ----------------
  // Open to everyone -- any user can start a conversation (1:1 or group)
  // with any other user(s), regardless of team/role. Messages can never
  // be deleted by anyone.

  // Finds or creates a conversation for the given participant list.
  // If exactly 2 people (you + 1 other) and one already exists, reuse it
  // instead of creating duplicates every time you click the same person.
  async startConversation(p) {
    const caller = await getCaller(p.uid);
    let participantIds = Array.isArray(p.participantIds) ? p.participantIds.map(String) : [];
    let name = String(p.name || '').trim();
    if (!participantIds.includes(caller.id)) participantIds.push(caller.id);
    participantIds = Array.from(new Set(participantIds));
    if (participantIds.length < 2) return { ok: false, msg: 'Select at least one other person.' };

    const users = await getAllUsers();
    const byId = {}; users.forEach(u => { byId[u.id] = u; });
    participantIds = participantIds.filter(id => byId[id]);

    const isDm = participantIds.length === 2;

    if (isDm) {
      // try to reuse an existing 1:1 conversation between these two people
      const { data: existing } = await supabase.from('conversations').select('*').eq('type', 'dm');
      const found = (existing || []).find(c => {
        const ps = c.participants || [];
        return ps.length === 2 && ps.includes(participantIds[0]) && ps.includes(participantIds[1]);
      });
      if (found) return { ok: true, conversationId: found.id, msg: 'ok' };
    }

    if (!name) {
      name = isDm ? null : participantIds.filter(id => id !== caller.id).map(id => byId[id].name).join(', ');
    }

    const cid = 'C' + Date.now();
    const { error } = await supabase.from('conversations').insert({
      id: cid, type: isDm ? 'dm' : 'group', name,
      participants: participantIds, created_by: caller.id, created_by_name: caller.name
    });
    if (error) return { ok: false, msg: error.message };
    return { ok: true, conversationId: cid, msg: 'Chat started.' };
  },

  async listConversations(p) {
    const caller = await getCaller(p.uid);
    const { data: convs, error } = await supabase.from('conversations').select('*');
    if (error) return { ok: false, msg: error.message };

    const mine = (convs || []).filter(c => (c.participants || []).includes(caller.id));
    if (!mine.length) return { ok: true, conversations: [] };

    const users = await getAllUsers();
    const byId = {}; users.forEach(u => { byId[u.id] = u; });

    const ids = mine.map(c => c.id);
    const { data: msgs } = await supabase.from('messages').select('*').in('conversation_id', ids).order('created_at', { ascending: false });

    const list = mine.map(c => {
      const convMsgs = (msgs || []).filter(m => m.conversation_id === c.id);
      const last = convMsgs[0]; // already sorted desc
      const unread = convMsgs.filter(m => m.from_id !== caller.id && !(m.read_by || []).includes(caller.id)).length;
      let displayName = c.name;
      if (c.type === 'dm') {
        const otherId = (c.participants || []).find(id => id !== caller.id);
        displayName = byId[otherId] ? byId[otherId].name : 'Unknown';
      }
      return {
        conversationId: c.id, type: c.type, name: displayName || 'Group Chat',
        participantCount: (c.participants || []).length,
        lastMsg: last ? last.body : '', lastTime: last ? last.created_at : c.created_at,
        unread
      };
    });
    list.sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
    return { ok: true, conversations: list };
  },

  async getConversation(p) {
    const caller = await getCaller(p.uid);
    const conversationId = String(p.conversationId || '').trim();
    const { data: conv } = await supabase.from('conversations').select('*').eq('id', conversationId).maybeSingle();
    if (!conv || !(conv.participants || []).includes(caller.id)) return { ok: false, msg: 'Conversation not found.' };

    const { data, error } = await supabase.from('messages').select('*').eq('conversation_id', conversationId).order('created_at', { ascending: true });
    if (error) return { ok: false, msg: error.message };

    // mark as read by me
    const toMark = (data || []).filter(m => m.from_id !== caller.id && !(m.read_by || []).includes(caller.id));
    for (const m of toMark) {
      const newReadBy = [...(m.read_by || []), caller.id];
      await supabase.from('messages').update({ read_by: newReadBy }).eq('id', m.id);
    }

    const users = await getAllUsers();
    const byId = {}; users.forEach(u => { byId[u.id] = u; });
    let convName = conv.name;
    if (conv.type === 'dm') {
      const otherId = (conv.participants || []).find(id => id !== caller.id);
      convName = byId[otherId] ? byId[otherId].name : 'Unknown';
    }

    return {
      ok: true,
      conversation: {
        id: conv.id, type: conv.type, name: convName || 'Group Chat',
        participants: (conv.participants || []).map(id => (byId[id] ? byId[id].name : id))
      },
      messages: (data || []).map(m => ({
        id: m.id, fromId: m.from_id, fromName: m.from_name, body: m.body,
        time: m.created_at, mine: m.from_id === caller.id
      }))
    };
  },

  async sendMessage(p) {
    const caller = await getCaller(p.uid);
    const conversationId = String(p.conversationId || '').trim();
    const body = String(p.body || '').trim();
    if (!conversationId || !body) return { ok: false, msg: 'Message cannot be empty.' };

    const { data: conv } = await supabase.from('conversations').select('*').eq('id', conversationId).maybeSingle();
    if (!conv || !(conv.participants || []).includes(caller.id)) return { ok: false, msg: 'You are not part of this conversation.' };

    const { error } = await supabase.from('messages').insert({
      conversation_id: conversationId, from_id: caller.id, from_name: caller.name,
      to_id: null, body, read_by: [caller.id]
    });
    if (error) return { ok: false, msg: error.message };
    return { ok: true, msg: 'sent' };
  }
};

// ---------------- email templates ----------------

function welcomeHtml(name, code, email, pass, roleLabel, dept) {
  return `<div style="font-family:Arial;max-width:460px;margin:0 auto">
    <div style="background:#0F172A;padding:16px 20px"><div style="font-size:15px;font-weight:700;color:#fff">Task Management System</div></div>
    <div style="padding:20px;background:#fff">
      <p style="font-size:14px;color:#1e293b">Welcome <strong>${name}</strong>! Your account is ready.</p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;margin:12px 0">
        <p style="margin:0 0 7px;font-size:13px"><strong>Employee Code:</strong> ${code}</p>
        <p style="margin:0 0 7px;font-size:13px"><strong>Email:</strong> ${email}</p>
        <p style="margin:0 0 7px;font-size:13px"><strong>Password:</strong> ${pass}</p>
        <p style="margin:0;font-size:13px"><strong>Access Level:</strong> ${roleLabel} / ${dept}</p>
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

function meetingHtml(by, title, dateLabel, link) {
  return `<div style="font-family:Arial;max-width:500px;margin:0 auto">
    <div style="background:#1E1B4B;padding:16px 20px;border-radius:10px 10px 0 0"><div style="font-size:15px;font-weight:700;color:#fff">Meeting Scheduled</div></div>
    <div style="padding:20px;background:#fff;border-radius:0 0 10px 10px;border:1px solid #E2E8F0">
      <p><strong>${by}</strong> scheduled a meeting with you.</p>
      <p style="margin:10px 0;padding:12px;background:#F8FAFF;border-radius:8px;border-left:3px solid #6366F1"><strong>${title}</strong><br>${dateLabel}</p>
      <a href="${link}" style="display:inline-block;background:#10B981;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:10px">📹 Join Meeting</a>
    </div></div>`;
}
