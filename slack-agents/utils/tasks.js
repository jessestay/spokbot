// utils/tasks.js — Agent-facing Vikunja task helpers
//
// The MACF task model:
//   - Every agent has their own Vikunja account (see SETUP.md Part 5) and can
//     create tasks, assign them, and be assigned tasks.
//   - Every delegation dispatched through the relay (utils/delegation.js) is
//     automatically tracked as a task owned by the receiving agent — so work
//     never disappears into chat scroll.
//   - Exec PM owns the board: triageBoard() runs on a schedule and keeps the
//     backlog ordered, assigned, and prioritized by revenue impact.
//
// All functions are safe no-ops (return null) when Vikunja isn't configured,
// and never throw into the delegation chain.
'use strict';

const { VIKUNJA, TASK_ROUTING } = require('../config');
const vikunja = require('./vikunja');

function isEnabled() {
  return vikunja.isConfigured() && !!VIKUNJA.projectId;
}

function agentUserId(agentId) {
  return (VIKUNJA.users && VIKUNJA.users[agentId]) || null;
}

function agentName(agentId) {
  const { AGENTS } = require('../config');
  return (AGENTS[agentId] && AGENTS[agentId].slackName) || agentId;
}

// ─── Create / complete ───────────────────────────────────────────────────────
async function createTask(agentId, { title, description = '', priority = vikunja.PRIORITY.NORMAL, dueDate = null, assignee = null, projectId = null } = {}) {
  if (!isEnabled()) return null;
  const pid = projectId || VIKUNJA.projectId;
  try {
    const task = await vikunja.createTask(agentId, pid, { title, description, priority, dueDate });
    const uid = assignee ? agentUserId(assignee) : null;
    if (uid) {
      await vikunja.assignTask(agentId, task.id, uid).catch(err =>
        console.error(`[tasks] Could not assign task #${task.id} to ${assignee}:`, err.message));
    }
    console.log(`[tasks] ✅ Task #${task.id} "${String(title).slice(0, 60)}" → ${assignee || 'unassigned'}`);
    return task;
  } catch (err) {
    console.error('[tasks] createTask failed:', err.message);
    return null;
  }
}

// REMOVED (Oct 12, 2026 — #724): the completeTask wrapper. vikunja
// .completeTask now has exactly one call site — engine/completion.js —
// so no code path can complete a task around the verifier. Callers that
// need completion go through completion.completeVerifiedTask (contracted)
// or completion.completeLegacyTask (legacy path, Phase 2 transitional).

// ─── Delegation → task tracking ──────────────────────────────────────────────
function stripDelegationPrefix(text) {
  return String(text || '').replace(/^\s*\[from:\s*[^\]→]+→[^\]]+\]\s*/i, '').trim();
}

// Short acks ("On it.", "Got it") are noise — the delegation itself routes the
// work and the agent's reply is the record. Longer acks that describe the work
// still become tasks.
const ACK_RE = /^(on it|got it|working on it|will do|done|thanks|thank you|noted|roger)\b/i;
function isNoise(text) {
  const t = String(text || '').trim();
  if (t.length < 12) return true;
  if (t.length < 60 && ACK_RE.test(t)) return true;
  return false;
}

// Called from the delegation relay after each dispatch: the receiving agent
// becomes the task owner. Attribution uses the delegating agent's token.
async function trackDelegation(fromAgentId, toAgentId, requestText) {
  if (!isEnabled()) return null;
  const clean = stripDelegationPrefix(requestText);
  if (isNoise(clean)) {
    console.log(`[tasks] Skipping task for ack/noise: "${clean.slice(0, 50)}"`);
    return null;
  }
  const firstLine = clean.split('\n')[0].trim();
  const title = firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
  return createTask(fromAgentId, {
    title,
    description: `Delegated ${agentName(fromAgentId)} → ${agentName(toAgentId)} via MACF relay.\n\n${clean}`,
    assignee: toAgentId,
    priority: vikunja.PRIORITY.NORMAL,
  });
}

// ─── Triage (Exec PM owns this) ──────────────────────────────────────────────
// Rules, run in order per task:
//   1. Overdue & open → priority HIGH (4)
//   2. Revenue-impacting & open → priority HIGH (4) — money first
//   3. Unassigned & open → routed to an owner by keyword, else Exec PM
// Returns a human-voice summary string (or null when disabled/nothing to do).
const REVENUE_RE = /revenue|sales|client|sponsor|donation|customer|launch|monetiz|paid|invoice/i;

function routeAgent(text) {
  // CEO BUILD 6: the stamped MACF-CONTRACT block is metadata, not task
  // content — its own text ("contract") keyword-routed every contracted
  // task to the lawyer. Strip it before matching.
  const t = String(text || '').replace(/<!--\s*MACF-CONTRACT\s*[\s\S]*?\s*MACF-CONTRACT\s*-->/g, ' ');
  for (const { pattern, agent } of TASK_ROUTING) {
    if (pattern.test(t)) return agent;
  }
  return 'execPM';
}

// ─── Ownership (CEO BUILD 6, Oct 22, 2026) ──────────────────────────────────
// Vikunja assignees are the board's statement of who owns a task. Before
// this build the engine ignored them: workTask re-derived an owner from
// title keywords and the picker never looked at queues at all, so the
// board's ownership had no effect on who got work (Oct 21: seven agents
// produced nothing while assigned queues sat untouched). Resolution
// order: (1) a recognized assignee (Vikunja username -> agent id);
// (2) keyword routing, unchanged. jarvis-jr (the CEO account) is not a
// worker assignee and falls through to keyword routing.
const ASSIGNEE_AGENT = {
  execpm: 'execPM', cmo: 'cmo', cco: 'cco', cfo: 'cfo', cro: 'cro',
  cto: 'cto', cuxo: 'cuxo', lawyer: 'lawyer', jobcoach: 'jobcoach',
  facebook: 'facebook',
};

function resolveOwner(task) {
  const assignees = (task && task.assignees) || [];
  for (const a of assignees) {
    const id = ASSIGNEE_AGENT[String((a && a.username) || '').toLowerCase()];
    if (id) return id;
  }
  return routeAgent(`${(task && task.title) || ''} ${(task && task.description) || ''}`);
}

// Batch diversity: order-preserving selection that takes one task per
// owner first, then fills remaining slots in the original order — one
// agent can no longer consume a whole batch while other owners' eligible
// work waits. Diversity applies WITHIN a lane segment only (segmentOf
// returns the segment key; segments are contiguous in the picker's
// ordered list): promoting across lanes would let a fail-closed legacy
// task jump contracted work, which the Build 3 batch contract forbids.
function diversifyBatch(list, n, segmentOf) {
  const items = Array.isArray(list) ? list : [];
  if (items.length <= n) return items.slice();
  const segOf = typeof segmentOf === 'function' ? segmentOf : () => 0;
  const segments = [];
  for (const t of items) {
    const key = segOf(t);
    const tail = segments[segments.length - 1];
    if (tail && tail.key === key) tail.items.push(t);
    else segments.push({ key, items: [t] });
  }
  const out = [];
  for (const seg of segments) {
    const seen = new Set();
    const first = [];
    const rest = [];
    for (const t of seg.items) {
      const o = resolveOwner(t);
      if (!seen.has(o)) { seen.add(o); first.push(t); } else rest.push(t);
    }
    out.push(...first, ...rest);
  }
  return out.slice(0, n);
}

async function triageBoard() {
  if (!isEnabled()) return null;
  let raw;
  try {
    raw = await vikunja.listTasks('execPM', VIKUNJA.projectId, { filter: 'done = false', sortBy: 'priority', orderBy: 'desc' });
  } catch (err) {
    console.error('[tasks] triage: could not list tasks:', err.message);
    return null;
  }
  const list = Array.isArray(raw) ? raw : (raw && raw.tasks) || [];
  const now = Date.now();
  const changes = [];
  let open = 0;

  for (const t of list) {
    if (t.done) continue;
    open++;
    const updates = {};
    const haystack = `${t.title || ''} ${t.description || ''}`;

    // 1. Overdue → escalate
    if (t.due_date && new Date(t.due_date).getTime() < now && (t.priority || 0) < vikunja.PRIORITY.HIGH) {
      updates.priority = vikunja.PRIORITY.HIGH;
      changes.push(`"${t.title}" is overdue — bumped to high priority`);
    }
    // 2. Revenue impact → prioritize (money first)
    if (REVENUE_RE.test(haystack) && (t.priority || 0) < vikunja.PRIORITY.HIGH && !updates.priority) {
      updates.priority = vikunja.PRIORITY.HIGH;
      changes.push(`"${t.title}" affects revenue — bumped to high priority`);
    }
    // 3. Unassigned → find an owner
    const assignees = t.assignees || [];
    if (assignees.length === 0) {
      const owner = routeAgent(haystack);
      const uid = agentUserId(owner);
      if (uid) {
        await vikunja.assignTask('execPM', t.id, uid).catch(err =>
          console.error(`[tasks] triage: assign failed for #${t.id}:`, err.message));
        changes.push(`"${t.title}" had no owner — assigned to ${agentName(owner)}`);
      } else {
        changes.push(`"${t.title}" had no owner and ${agentName(owner)} has no Vikunja user mapped — needs Jesse's attention`);
      }
    }

    if (Object.keys(updates).length > 0) {
      await vikunja.updateTask('execPM', t.id, updates).catch(err =>
        console.error(`[tasks] triage: update failed for #${t.id}:`, err.message));
    }
  }

  if (open === 0) return 'Task board triage: nothing open. The board is clean.';

  const lines = [
    `Task board triage: ${open} open task${open === 1 ? '' : 's'}.`,
  ];
  if (changes.length > 0) {
    lines.push('What I did:');
    changes.slice(0, 15).forEach(c => lines.push(`• ${c}`));
    if (changes.length > 15) lines.push(`• …and ${changes.length - 15} more`);
  } else {
    lines.push('Everything is assigned and prioritized — no changes needed.');
  }
  return lines.join('\n');
}

// One-line-per-task summary of open work, for /tasks.
async function openTasksSummary() {
  if (!isEnabled()) return null;
  let raw;
  try {
    raw = await vikunja.listTasks('execPM', VIKUNJA.projectId, { filter: 'done = false', sortBy: 'priority', orderBy: 'desc', perPage: 20 });
  } catch (err) {
    console.error('[tasks] openTasksSummary failed:', err.message);
    return null;
  }
  const list = Array.isArray(raw) ? raw : (raw && raw.tasks) || [];
  const open = list.filter(t => !t.done);
  if (open.length === 0) return 'No open tasks on the board.';
  const prioName = p => (p >= 5 ? 'urgent' : p >= 4 ? 'high' : p >= 3 ? 'normal' : p >= 2 ? 'low' : 'backlog');
  const lines = open.slice(0, 15).map(t => {
    const owner = (t.assignees && t.assignees[0] && (t.assignees[0].username || t.assignees[0].name)) || 'unassigned';
    const due = t.due_date ? ` (due ${new Date(t.due_date).toLocaleDateString('en-US')})` : '';
    return `• #${t.id} [${prioName(t.priority || 0)}] ${t.title} — ${owner}${due}`;
  });
  if (open.length > 15) lines.push(`…and ${open.length - 15} more`);
  return `*Open tasks (${open.length}):*\n${lines.join('\n')}`;
}

module.exports = {
  isEnabled,
  agentUserId,
  createTask,
  trackDelegation,
  stripDelegationPrefix,
  isNoise,
  routeAgent,
  resolveOwner,
  diversifyBatch,
  ASSIGNEE_AGENT,
  triageBoard,
  openTasksSummary,
};
