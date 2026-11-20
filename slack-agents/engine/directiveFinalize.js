// engine/directiveFinalize.js — Phase F (Vikunja #789): the shared
// directive finalize machinery.
//
// Through Phase B this code lived inside engine/directivePoll.js and
// only the poller could run it: validation of a delegation result,
// posting the validated reply, the verification queue, task auto-link,
// agent-health bookkeeping, and the retry / dead-letter / auto-requeue
// machinery that decides what an unresolved directive's fate is.
//
// Phase F gives the work a second driver — the engine's intake cycle —
// so the machinery is extracted here VERBATIM (same predicates, same
// order, same bookkeeping) and shared. There is exactly ONE
// implementation of the evidence gate and the retry semantics; the
// poller and the engine cycle both call it. Do not fork it back.
//
// The only coupling the machinery needs is "resolve an agent ID to its
// module" (the drains). That is injected via init(), the same pattern
// utils/delegation.js uses: the poller injects its loader, the engine
// injects the directive-workflow agent loader.
//
// Phase F additions (new behavior, kept beside the machinery it uses):
//   - consumeSettledIntakeRecords: the engine-side finalize loop. Lists
//     settled intake records (completed/failed, not yet finalized),
//     runs each through finalizeDelegation with the record's result
//     (null for failed), and marks the record finalized. Roadblock
//     records are consumed silently — the poller's roadblock branch is
//     fire-and-forget and the engine mirrors that.
//   - adoptOrphanedIntakeRecords: the fallback poller's adoption step.
//     Records a dead engine left unsettled past the stale threshold are
//     force-settled as failed so the consume stage routes them into
//     the retry machinery — no directive is stranded by an engine death.
'use strict';

const fs = require('fs');
const path = require('path');
const { logEngineGap } = require('./engineGap');
const { suggestCollaboration } = require('./collaboration');

const VERIFY_PATH = path.join(__dirname, '.directive-verify-state.json');
const AGENT_HEALTH_PATH = path.join(__dirname, '.agent-health.json');

// ─── Agent resolution (injected) ─────────────────────────────────────
let _getAgent = null;
let _agentIds = [];
function init({ getAgent, agentIds } = {}) {
  if (typeof getAgent === 'function') _getAgent = getAgent;
  if (Array.isArray(agentIds)) _agentIds = agentIds.slice();
}
function resolveAgent(agentId) {
  if (!_getAgent) throw new Error('directiveFinalize.init({ getAgent, agentIds }) was never called');
  return _getAgent(agentId);
}
function knownAgentIds() { return _agentIds; }

// Verify a Slack post actually landed (read-after-write).
// ROOT-CAUSE FIX (Oct 6, 2026): The poller logged "Posted validated reply"
// without checking. In the CCO workshop test the thread had 0 replies despite
// the success log. This reads back the thread (or channel) and confirms a
// message with the posted ts exists before the directive is marked complete.
async function verifyPostLanded(client, channelId, threadTs, postedTs) {
  if (!postedTs) return false;
  try {
    let messages = [];
    if (threadTs) {
      const res = await client.conversations.replies({
        channel: channelId, ts: threadTs, limit: 10,
      });
      messages = res.messages || [];
    } else {
      const res = await client.conversations.history({
        channel: channelId, limit: 10,
      });
      messages = res.messages || [];
    }
    return messages.some(m => m.ts === postedTs);
  } catch (e) {
    console.error(`[directivePoll] post verification readback failed:`, e.message);
    return false;
  }
}

function queueForVerification(directiveText, agentId, result) {
  // Queue EVERY directive for verification, not just pattern-matched ones.
  // The verifier extracts artifacts (URLs, post IDs, task refs) from the
  // agent's response and checks them against external systems.
  let verifyState;
  try { verifyState = JSON.parse(fs.readFileSync(VERIFY_PATH, 'utf8')); }
  catch { verifyState = { pending: [], verified: [], failed: [] }; }
  if (!verifyState.pending) verifyState.pending = [];

  verifyState.pending.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agentId: agentId,
    directive: directiveText.slice(0, 500),
    response: (result?.response || '').slice(0, 2000),
    evidence: (result?.evidence || '').slice(0, 500),
    timestamp: Date.now()
  });

  // Keep pending bounded
  if (verifyState.pending.length > 200) {
    verifyState.pending = verifyState.pending.slice(-200);
  }

  fs.writeFileSync(VERIFY_PATH, JSON.stringify(verifyState, null, 2));
  console.log(`[directivePoll] queued for external verification: ${agentId}`);
}

// HEALTH TRACKING (Oct 4, 2026 — architectural fix):
// The self-healer was blind because nothing ever updated these counters.
// Every directive outcome per agent is tracked:
//   - directivesReceived: incremented when a directive is routed to the agent
//   - directivesCompleted: incremented when the agent returns validated evidence
//   - directivesFailed: incremented on timeout, error, or no-evidence after retries
//   - lastActivity: timestamp of last directive handled
//   - consecutiveFailures: reset on success, incremented on failure
function updateAgentHealth(agentId, outcome) {
  // outcome: 'received' | 'completed' | 'failed'
  try {
    let health = {};
    try { health = JSON.parse(fs.readFileSync(AGENT_HEALTH_PATH, 'utf8')); } catch {}
    if (!health[agentId]) {
      health[agentId] = {
        agentId, directivesReceived: 0, directivesCompleted: 0,
        directivesFailed: 0, lastActivity: null, consecutiveFailures: 0,
        status: 'unknown',
      };
    }
    const h = health[agentId];
    const now = new Date().toISOString();
    if (outcome === 'received') {
      h.directivesReceived++;
      h.lastActivity = now;
    } else if (outcome === 'completed') {
      h.directivesCompleted++;
      h.consecutiveFailures = 0;
      h.lastActivity = now;
      h.status = 'healthy';
    } else if (outcome === 'failed') {
      h.directivesFailed++;
      h.consecutiveFailures = (h.consecutiveFailures || 0) + 1;
      h.lastActivity = now;
      h.status = h.consecutiveFailures >= 3 ? 'failing' : 'degraded';
    }
    h.lastChecked = now;
    fs.writeFileSync(AGENT_HEALTH_PATH, JSON.stringify(health, null, 2));
  } catch (e) {
    console.error(`[directivePoll] Health update failed for ${agentId}:`, e.message);
  }
}

// AUTO-LINK: Every Slack directive creates or updates a Vikunja task.
// This is the engine fix that makes staleness impossible — writeback is a
// POST-CONDITION of delegation, not optional agent behavior.
//
// P1.5 (Oct 12, 2026): the old version only matched tasks whose title
// started with an [AGENT] prefix that almost no task has — so directives
// silently never wrote back (e.g. #46: one comment, from the self-healer,
// Oct 10). The "create a directive-tracking task" fallback was promised in
// the comment but never implemented. New resolution order:
//   1. Explicit task reference in the directive text (task #N) wins.
//   2. The agent's most recently updated active task, matched by ASSIGNEE
//      (Vikunja usernames are lowercase), not title prefix.
//   3. Create a per-agent directive-log task and comment there.
async function linkDirectiveToTask(agentId, directiveText, responseText) {
  const vikunjaToken = process.env.VIKUNJA_TOKEN;
  const vikunjaUrl = process.env.VIKUNJA_URL || 'http://127.0.0.1:3456';
  if (!vikunjaToken) return null;

  const comment = `[Directive ${new Date().toISOString()}]\n` +
    `Directive: ${directiveText.slice(0, 300)}\n` +
    `Response: ${(responseText || 'No response').slice(0, 500)}`;

  async function postComment(taskId) {
    const res = await fetch(`${vikunjaUrl}/api/v1/tasks/${taskId}/comments`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${vikunjaToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment })
    });
    if (!res.ok) throw new Error(`comment PUT -> ${res.status}`);
    console.log(`[directivePoll] Auto-linked directive to task #${taskId} for ${agentId}`);
    return taskId;
  }

  try {
    // 1. Explicit task reference wins.
    const refMatch = directiveText.match(/task\s*#?(\d+)/i);
    if (refMatch) {
      return await postComment(parseInt(refMatch[1], 10));
    }

    // 2. Agent's most recently updated active task (by assignee).
    // P1.6: skip WIP-cap parked tasks — writeback goes to actionable work.
    const who = agentId.toLowerCase();
    const DORMANT_RE = /hold-001|on hold|\bparked\b|guardrail/i;
    for (const pid of [2, 16]) {
      const res = await fetch(`${vikunjaUrl}/api/v1/projects/${pid}/tasks`, {
        headers: { 'Authorization': `Bearer ${vikunjaToken}` }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const tasks = Array.isArray(data) ? data : (data.tasks || []);

      const mine = tasks
        .filter(t => !t.done && !DORMANT_RE.test(`${t.title || ''} ${t.description || ''}`) && (t.assignees || [])
          .some(a => (a.username || '').toLowerCase() === who))
        .sort((a, b) => new Date(b.updated) - new Date(a.updated));

      if (mine.length > 0) {
        return await postComment(mine[0].id);
      }
    }

    // 3. Last resort: create the per-agent directive-log task.
    const createRes = await fetch(`${vikunjaUrl}/api/v1/projects/2/tasks`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${vikunjaToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: `[${agentId.toUpperCase()}] Directive log`,
        description: 'Auto-created: every CEO directive to this agent is logged here as a comment with the agent response.',
      }),
    });
    if (createRes.ok) {
      const created = await createRes.json();
      return await postComment(created.id);
    }
    console.error(`[directivePoll] Auto-link: could not create directive-log task (HTTP ${createRes.status})`);
  } catch (e) {
    console.error(`[directivePoll] Auto-link failed for ${agentId}:`, e.message);
  }
  return null;
}

// RETRY QUEUE (Oct 11, 2026 — root-cause fix): the scan-phase watermark
// advances for non-directive messages WHILE queued delegations are still
// running. When a delegation then fails (garbled output, null result,
// finalize throw), the directive sits BELOW the watermark, so the "retry
// next cycle" comment was a lie — the directive was silently swallowed.
// Fix: unresolved directives go into state._pendingRetry (with their full
// text), and the cycle drains that list at the start of every run,
// INDEPENDENT of the watermark. Three consecutive failures dead-letter
// the directive.
const MAX_PENDING_RETRY = 50;
// AUTO-REQUEUE (Oct 15, 2026): dead-lettered directives resurrect after a
// cooldown, up to MAX_REQUEUES times (~4h of coverage), then stay dead.
const REQUEUE_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_REQUEUES = 8;
function queueRetry(state, item, strategyNoteText) {
  const key = `${item.channel}:${item.m.ts}`;
  if (!Array.isArray(state._pendingRetry)) state._pendingRetry = [];
  const existing = state._pendingRetry.find(e => e.channel === item.channel && e.ts === item.m.ts);
  if (!existing) {
    state._pendingRetry.push({
      channel: item.channel,
      ts: item.m.ts,
      msgTs: item.msgTs,
      agentId: item.agentId,
      text: ((item.text || '') + (strategyNoteText || '')).slice(0, 4000),
      requeues: item.requeues || 0,
    });
    if (state._pendingRetry.length > MAX_PENDING_RETRY) {
      state._pendingRetry = state._pendingRetry.slice(-MAX_PENDING_RETRY);
    }
    console.log(`[directivePoll] queued for retry: ${key} (${item.agentId})`);
  } else if (strategyNoteText && !existing.text.includes('[RETRY')) {
    // #807 US-P3.3: a retried directive carries the strategy re-route
    // note so the next attempt changes approach instead of re-running
    // the failed one verbatim.
    existing.text = (existing.text + strategyNoteText).slice(0, 4000);
  }
}
function dropPendingRetry(state, channel, ts) {
  if (Array.isArray(state._pendingRetry)) {
    state._pendingRetry = state._pendingRetry.filter(e => !(e.channel === channel && e.ts === ts));
  }
}
// Drain state._pendingRetry into the delegation queue. client may be null
// in tests (agent.init is best-effort anyway).
function drainPendingRetry(state, client, pendingDelegations) {
  if (Array.isArray(state._pendingRetry) && state._pendingRetry.length) {
    console.log(`[directivePoll] draining ${state._pendingRetry.length} retry-queued directive(s)`);
    for (const e of state._pendingRetry) {
      const agent = knownAgentIds().includes(e.agentId) ? resolveAgent(e.agentId) : null;
      if (!agent || typeof agent.handleDelegation !== 'function') {
        console.log(`[directivePoll] retry drop (no agent): ${e.channel}:${e.ts}`);
        continue;
      }
      if (typeof agent.init === 'function') {
        try { agent.init({ client }); } catch (_) { /* already inited */ }
      }
      // 'received' was already counted at first scan — don't double-count.
      pendingDelegations.push({
        channel: e.channel,
        m: { ts: e.ts },
        text: e.text,
        msgTs: e.msgTs,
        agentId: e.agentId,
        agent,
        isRetry: true,
        requeues: e.requeues || 0,
      });
    }
  }
  // Items that fail to finalize are re-queued by queueRetry(); clear the
  // drained set now so only failures survive into next cycle.
  state._pendingRetry = [];
}

// RECEIPT SUMMARY (Phase A, US-A3 — Vikunja #789): when a directive
// dead-letters, summarize what the dying attempt actually DID from its
// tool receipts (the receipts ledger at MACF_RECEIPTS_FILE, filtered to
// this agent at or after the directive's timestamp). The summary rides
// on the dead-letter entry and is placed ahead of the assignment text
// when the entry is requeued, so the fresh attempt starts oriented.
// Artifacts are claimed only from successful receipts (see
// utils/receiptSummary.js); an attempt that completed no tool work says
// so plainly. Ledger read failures omit the summary rather than
// fabricating one.
function buildReceiptSummary(agentId, msgTs) {
  try {
    const { readAllReceipts } = require('./receipts');
    const { summarizeReceipts } = require('../utils/receiptSummary');
    const sinceMs = (parseFloat(msgTs) || 0) * 1000;
    const attemptReceipts = readAllReceipts().filter(r =>
      r && r.agentId === agentId && (Date.parse(r.ts) || 0) >= sinceMs);
    return summarizeReceipts(attemptReceipts);
  } catch (e) {
    console.error(`[directivePoll] receipt summary unavailable for ${agentId}:`, e.message);
    return undefined;
  }
}

// Record a terminal-failure attempt. After 3 consecutive failures the
// directive is dead-lettered (watermark advanced); otherwise it is queued
// for retry next cycle. Returns true when dead-lettered.
function recordRetryFailure(state, item, reason, healthFn, extra) {
  const onHealth = healthFn || updateAgentHealth;
  const { channel, m, text, msgTs, agentId } = item;
  const retryKey = `${channel}:${m.ts}`;
  const retries = (state._retries || {})[retryKey] || 0;
  if (retries >= 3) {
    console.log(`[directivePoll] ${agentId} directive failed 3x (${reason}) — dead-lettering (advancing watermark)`);
    if (!state._deadLetter) state._deadLetter = [];
    const deadLetterEntry = {
      channel, ts: m.ts, agentId,
      text: (text || '').slice(0, 200),
      // AUTO-REQUEUE (Oct 15, 2026 — Jesse's order): a dead-letter is no
      // longer a silent grave. The full text + a cooldown timestamp are
      // stored so drainDeadLetterRequeues() can resurrect the directive on a
      // later cycle without any human re-issue, up to MAX_REQUEUES times.
      fullText: (text || '').slice(0, 4000),
      msgTs,
      requeues: item.requeues || 0,
      requeueAt: new Date(Date.now() + REQUEUE_COOLDOWN_MS).toISOString(),
      failedAt: new Date().toISOString(),
      reason,
    };
    // #807 US-P3.2: a dead-letter carries the postcondition set and the
    // observed failures, so any retry (auto or human) starts from the
    // exact gap — not a 200-char summary of the ask.
    if (extra && Array.isArray(extra.postconditions)) deadLetterEntry.postconditions = extra.postconditions;
    if (extra && Array.isArray(extra.postconditionFailures)) deadLetterEntry.postconditionFailures = extra.postconditionFailures;
    // CEO BUILD 9: a parked directive files its own ticket (drained by
    // drainParkTickets) and keeps the last run's salvaged partial work,
    // so whoever picks it up starts from the failure, not from zero.
    deadLetterEntry.parkTicket = { status: 'queued' };
    if (extra && typeof extra.salvage === 'string' && extra.salvage.trim()) {
      deadLetterEntry.salvage = extra.salvage.slice(0, 2000);
    }
    const receiptSummary = buildReceiptSummary(agentId, msgTs);
    if (receiptSummary) deadLetterEntry.receiptSummary = receiptSummary;
    state._deadLetter.push(deadLetterEntry);
    // DEAD-LETTER ALARM (Oct 12, 2026 — CEO mechanism repair): a dead-letter
    // used to exist only inside this state file, invisible until someone
    // grepped it. Raise a CEO-visible engine gap in the same cycle.
    try {
      logEngineGap(
        'directive_dead_letter',
        `${agentId} directive dead-lettered after 3 failures (${reason}): ${(text || '').slice(0, 140)}`,
        'directivePoll'
      );
    } catch {}
    if (msgTs > parseFloat(state[channel] || '0')) state[channel] = m.ts;
    if (state._retries) delete state._retries[retryKey];
    dropPendingRetry(state, channel, m.ts);
    onHealth(agentId, 'failed');
    return true;
  }
  if (!state._retries) state._retries = {};
  state._retries[retryKey] = retries + 1;
  console.log(`[directivePoll] Retry ${retries + 1}/3 for ${agentId} directive (${reason})`);
  // #807 US-P3.3: from the second failure onward (or whenever concrete
  // postcondition gaps are known), the retry carries a strategy-change
  // note built from the observed failure.
  // CEO BUILD 9: the note also carries the failed run's SALVAGE (the
  // partial work Build 7 rescued) so the next attempt builds on it
  // instead of redoing it, and the final retry narrows scope: a
  // partial verified deliverable beats another full-scope death.
  const noteParts = [];
  if (retries >= 1 || (extra && Array.isArray(extra.postconditionFailures) && extra.postconditionFailures.length)) {
    try {
      noteParts.push(require('./directivePostconditions').strategyNote(reason, (extra && extra.postconditionFailures) || [], retries + 2));
    } catch { /* note is an enhancement */ }
  }
  const salvageText = extra && typeof extra.salvage === 'string' ? extra.salvage.trim() : '';
  if (salvageText) {
    noteParts.push(`\n\n[PRIOR ATTEMPT'S PARTIAL WORK \u2014 build on this, do not redo it:\n${salvageText.slice(0, 1200)}]`);
  }
  if (retries >= 2) {
    noteParts.push('\n\n[FINAL ATTEMPT: narrow the scope \u2014 produce the deliverable from what you already have. A partial verified deliverable beats another full-scope failure.]');
  }
  const note = noteParts.length ? noteParts.join('') : null;
  queueRetry(state, item, note);
  return false;
}

// AUTO-REQUEUE DRAIN (Oct 15, 2026 — Jesse's order: "when a job dies,
// nothing picks it back up" was the architectural flaw). Dead-lettered
// directives whose cooldown has elapsed re-enter the delegation queue with a
// fresh 3-attempt budget and an incremented requeue count. Entries that have
// exhausted MAX_REQUEUES stay in _deadLetter permanently (the dead-letter
// alarm already fired when they first died). Watermark-independent, like
// _pendingRetry: the directive sits below the watermark by design.
function drainDeadLetterRequeues(state, client, pendingDelegations, now = Date.now()) {
  if (!Array.isArray(state._deadLetter) || !state._deadLetter.length) return 0;
  let drained = 0;
  const remaining = [];
  for (const e of state._deadLetter) {
    const requeues = e.requeues || 0;
    const due = e.requeueAt && Date.parse(e.requeueAt) <= now;
    if (!due || requeues >= MAX_REQUEUES || !e.fullText) {
      if (due && requeues >= MAX_REQUEUES && !e.finalLogged) {
        console.log(`[directivePoll] permanently dead-lettered after ${requeues} requeues: ${e.channel}:${e.ts} (${e.agentId})`);
        e.finalLogged = true;
      }
      remaining.push(e);
      continue;
    }
    const agent = knownAgentIds().includes(e.agentId) ? resolveAgent(e.agentId) : null;
    if (!agent || typeof agent.handleDelegation !== 'function') {
      remaining.push(e);
      continue;
    }
    if (typeof agent.init === 'function') {
      try { agent.init({ client }); } catch (_) { /* already inited */ }
    }
    if (state._retries) delete state._retries[`${e.channel}:${e.ts}`];
    pendingDelegations.push({
      channel: e.channel,
      m: { ts: e.ts },
      // US-A3.2: the previous attempt's receipt summary leads the
      // requeued text, ahead of the original assignment, so the fresh
      // attempt starts oriented about what was already done.
      text: e.receiptSummary ? `${e.receiptSummary}\n\n${e.fullText}` : e.fullText,
      msgTs: e.msgTs,
      agentId: e.agentId,
      agent,
      isRetry: true,
      requeues: requeues + 1,
    });
    drained++;
    console.log(`[directivePoll] auto-requeue ${requeues + 1}/${MAX_REQUEUES} after cooldown: ${e.channel}:${e.ts} (${e.agentId})`);
  }
  state._deadLetter = remaining;
  return drained;
}

// Verifiable evidence must appear in the reply text itself as an externally
// checkable reference. A free-form evidence string is only a claim marker;
// it is not verification and never satisfies this predicate by itself.
function hasVerifiableEvidenceIn(text) {
  const value = String(text || '');
  return /https?:\/\/[^\s]+/.test(value) ||  // URL
    /\b\d{15,20}\b/.test(value) ||             // Post ID
    /\b\d+\s*(likes|views|clicks|signups|comments|shares)\b/i.test(value); // Metrics
}

// Count real, successful tool executions recorded in the receipts ledger
// for this agent at or after the directive timestamp. Ledger read errors
// fail closed to zero rather than manufacturing evidence.
function countToolReceiptsSince(agentId, sinceMs) {
  try {
    const { readAllReceipts } = require('./receipts');
    const since = Number(sinceMs) || 0;
    return readAllReceipts().filter(r =>
      r && r.agentId === agentId &&
      (Date.parse(r.ts) || 0) >= since &&
      r.status === 'ok'
    ).length;
  } catch {
    return 0;
  }
}

function hasEvidenceMarker(result) {
  return !!(result && typeof result.evidence === 'string' && result.evidence.trim().length > 0);
}

// Sanitize a reply for posting while preserving a leading [from: X → Y]
// routing header. sanitizeForSlack removes an entire first line when it
// starts with that header, which would also delete body text sharing the
// line; detach and restore only the header token before sanitizing.
function sanitizePostText(raw) {
  const { sanitizeForSlack } = require('../utils/delegation');
  const text = String(raw || '');
  const header = text.match(/^\s*(\[from:\s*[^\]]+?(?:\u2192|->)[^\]]+?\])\s*/i);
  if (!header) return sanitizeForSlack(text);
  const body = sanitizeForSlack(text.slice(header[0].length));
  return body ? `${header[1]} ${body}` : header[1];
}

// Validate one delegation result, post the reply, update task/state.
// Runs serially in original message order. Returns 1 if the directive was
// resolved (posted or dead-lettered), 0 if it will retry next cycle.
async function finalizeDelegation(client, state, item, result) {
  const { channel, m, text, msgTs, agentId } = item;
  let processed = 0;
  // CEO BUILD 9: the run's salvaged partial work (Build 7) rides into
  // every retry this failure produces.
  const retryExtra = result && typeof result.salvage === 'string' && result.salvage.trim()
    ? { salvage: result.salvage }
    : {};

  if (!result) {
    console.log(`[directivePoll] ${agentId} produced no result — skipping (will retry next cycle)`);
    // HEALTH: Null result (timeout/error) counts as a failure
    updateAgentHealth(agentId, 'failed');
    recordRetryFailure(state, item, 'no_result');
    return processed;
  }

  // ROOT-CAUSE FIX: Poller is the sole poster. Agents return content,
  // poller validates BEFORE posting. This prevents empty "on it"
  // messages from ever reaching Slack.

  // CEO BUILD (Oct 22, 2026): normalize the EFFECTIVE result. A record
  // settled by the directive-work workflow carries the step output nested
  // ({ 'execute-directive': { completed, response, ... } }); the poller
  // shape carries it at top level. Every gate below must judge the real
  // step result, not the wrapper (audit F2).
  // NOV 2, 2026: the normalization moves ABOVE the two safety rejections.
  // They used to read only the top-level result.response, so for the
  // workflow shape both were silently skipped — the 2026-11-02 content
  // batch's retry emitted raw <tool_call> markup as its "response",
  // banked tavily receipts as evidence, and finalized as a COMPLETION
  // with no deliverable. The rejections now judge the effective
  // response exactly like the evidence/body gates already did.
  const stepResult = (result && typeof result === 'object' && typeof result.response !== 'string')
    ? (result['execute-directive'] || null)
    : null;
  const effectiveResult = stepResult || result || {};
  const responseText = effectiveResult?.response || '';

  // UNEXECUTED TOOL MARKUP REJECTION (#758): A reply that contains the
  // syntax of a tool call instead of a tool execution is not a deliverable.
  // Reject it before evidence or garble heuristics can reinterpret it.
  const { findUnexecutedCallSyntax } = require('../utils/anthropic');
  const unexecutedSyntax = responseText
    ? findUnexecutedCallSyntax(responseText)
    : null;
  if (unexecutedSyntax) {
    console.log(`[directivePoll] ${agentId} returned ${unexecutedSyntax} without executing it — REJECTED, will retry`);
    updateAgentHealth(agentId, 'failed');
    recordRetryFailure(state, item, 'unexecuted_tool_markup', undefined, retryExtra);
    return processed;
  }

  // Validate the response content for verifiable evidence.
  // EVIDENCE FIX (Oct 5, 2026): Check sub-results too. When CMO delegates
  // to CCO via relay(), the actual deliverable (copy, links) lives in the
  // sub-result, not the CMO's wrapper response. Gating only on the main
  // response discarded completed sub-agent work and left CMO/CUXO at
  // 0 completions.
  const directiveSinceMs = (parseFloat(msgTs) || 0) * 1000;
  let hasVerifiableEvidence = hasVerifiableEvidenceIn(responseText) ||
    countToolReceiptsSince(agentId, directiveSinceMs) > 0;

  // GARBLED OUTPUT REJECTION (Oct 9, 2026): Reject incoherent LLM output
  // before it creates junk tasks or confuses the delegation chain.
  const { isGarbledOutput } = require('../utils/delegation');
  if (responseText && isGarbledOutput(responseText)) {
    console.log(`[directivePoll] ${agentId} produced garbled output — REJECTED, will retry`);
    console.log(`[directivePoll] Garbled text preview: ${responseText.slice(0, 100)}...`);
    // Don't mark as evidence, don't advance watermark — retry next cycle
    // via the _pendingRetry queue (watermark may already have moved past).
    updateAgentHealth(agentId, 'failed');
    recordRetryFailure(state, item, 'garbled_output', undefined, retryExtra);
    return processed;
  }

  // Check sub-agent results for evidence (the actual deliverable often lives here)
  const subResultsForEvidence = (effectiveResult.subResults && Array.isArray(effectiveResult.subResults))
    ? effectiveResult.subResults
    : ((result.subResults && Array.isArray(result.subResults)) ? result.subResults : []);

  // CEO BUILD (Oct 22, 2026): EMPTY-BODY GATE (audit F2). The deliverable
  // is the response BODY — the text after the [from: X -> Y] header. A
  // header-only or trivial body is not a deliverable, no matter how many
  // tool receipts the run banked: receipts prove the agent MOVED, not that
  // it DELIVERED. (The Oct 22 directives all "completed" header-only this
  // way.) A genuine sub-result body can still carry the delivery (the
  // CMO/CCO pattern), so subs are checked before failing the run.
  const bodyAfterHeader = responseText.replace(/^\s*\[from:\s*[^\]]+?(?:\u2192|->)[^\]]+?\]\s*/i, '').trim();
  const subHasBody = subResultsForEvidence.some(s => {
    const sr = (s && s.result && typeof s.result.response === 'string') ? s.result.response : '';
    return sr.replace(/^\s*\[from:\s*[^\]]+?(?:\u2192|->)[^\]]+?\]\s*/i, '').trim().length >= 20;
  });
  if (bodyAfterHeader.length < 20 && !subHasBody) {
    console.log(`[directivePoll] ${agentId} returned an empty/trivial response body (${bodyAfterHeader.length} chars after header) — REJECTED as empty_response, will retry`);
    updateAgentHealth(agentId, 'failed');
    recordRetryFailure(state, item, 'empty_response', undefined, retryExtra);
    return processed;
  }

  for (const sub of subResultsForEvidence) {
    if (!sub.result) continue;
    // M1.1 (Oct 15, 2026 — live-run finding on the #734 acceptance): a
    // sub-result's bare taskId is NOT verifiable evidence. Auto-linking
    // creates a task for nearly every directive, so taskId-as-evidence
    // let a prose non-deliverable pass the action gate. Sub-evidence
    // must be checkable text (URL / ID / metrics) like the parent's.
    if (hasVerifiableEvidenceIn(sub.result.response || '')) {
      hasVerifiableEvidence = true;
      break;
    }
  }
  if (hasVerifiableEvidence) {
    console.log(`[directivePoll] ${agentId} evidence basis: ` +
      (hasVerifiableEvidenceIn(responseText) ? 'response-text' :
        countToolReceiptsSince(agentId, directiveSinceMs) > 0 ? 'tool-receipts' : 'sub-result-text'));
  }

  // ENFORCE EVIDENCE CONTRACT: Agents must return evidence of work done.
  // For action directives (publish, send, launch, create), text replies are
  // NOT sufficient — must show tool execution with IDs/links/counts.
  const lowerText = text.toLowerCase();
  const requiresAction = /publish|send|launch|create|post to|execute/.test(lowerText);

  let hasEvidence = hasVerifiableEvidence || !!effectiveResult?.taskId || hasEvidenceMarker(effectiveResult);

  // Sub-result task/evidence markers also count for non-action work. For
  // action directives, the enforcement below still requires verifiable
  // evidence (a checkable reference or a successful ledger receipt).
  if (!hasEvidence) {
    for (const sub of subResultsForEvidence) {
      if (sub.result && (sub.result.taskId || hasEvidenceMarker(sub.result))) {
        hasEvidence = true;
        break;
      }
    }
  }

  // For action directives, require tool execution evidence specifically
  if (requiresAction && !hasVerifiableEvidence) {
    console.log(`[directivePoll] ${agentId} action directive lacks verifiable evidence — NOT posting`);
    hasEvidence = false;
  }

  // POSTCONDITION GATE (#807 Phase 3, US-P3.1): when the directive itself
  // names deliverable artifacts (sandbox paths), the promised artifacts
  // must EXIST in the world before this can finalize — the evidence
  // proxies above (a URL in the text, any receipt) cannot substitute for
  // the named deliverable. Unmet → missing_artifacts failure carrying
  // the exact gap; the retry re-routes strategy (US-P3.3).
  try {
    const { derivePostconditions, verifyPostconditions, recordPostconditionOutcomes } = require('./directivePostconditions');
    const postconditions = derivePostconditions(text);
    if (postconditions.length) {
      const verification = verifyPostconditions(postconditions, { taskId: null });
      const { allSatisfied, failures } = verification;
      // #807 US-P3.5: every checked postcondition lands in the outcomes
      // ledger — the learner/healer score from this, not from reply text.
      recordPostconditionOutcomes(agentId, msgTs, verification.results);
      if (!allSatisfied) {
        console.log(`[directivePoll] ${agentId} postconditions unmet — NOT marked complete: ${failures.map(f => `${f.type}:${f.path}`).join(', ')}`);
        recordRetryFailure(state, item, 'missing_artifacts', undefined, { ...retryExtra, postconditions, postconditionFailures: failures });
        return processed;
      }
      console.log(`[directivePoll] ${agentId} postconditions verified: ${postconditions.map(p => p.path).join(', ')}`);
    }
  } catch (e) {
    console.error(`[directivePoll] postcondition gate error (continuing with legacy gates): ${e.message}`);
  }

  if (!hasEvidence) {
    console.log(`[directivePoll] ${agentId} provided no evidence — directive NOT marked complete`);

    // ROOT-CAUSE FIX: Track retry counts. Infinite retry without evidence
    // spams the channel with "on it" messages. After 3 failures, dead-letter
    // the directive (advance watermark) and log for human review. Unresolved
    // directives go into the _pendingRetry queue (not the watermark) because
    // the scan-phase watermark may already have advanced past them.
    recordRetryFailure(state, item, 'no_evidence_after_3_retries', undefined, retryExtra);
    return processed;
  }

  processed++;

  // ROOT-CAUSE FIX: Poller posts the validated response.
  // Agents return content, poller validates, THEN posts.
  // This is the only place directive replies are posted.
  if (result?.response) {
    try {
      // ROOT-CAUSE FIX (Oct 6, 2026): ALWAYS post directive replies in the
      // directive's channel. The agent's primaryChannel (e.g. CCO's "content")
      // is for proactive posts, not directive replies. Using it here posted
      // to the wrong channel, where the thread_ts didn't exist.
      const channelId = channel;
      const postParams = {
        channel: channelId,
        text: sanitizePostText(result.response),
        unfurl_links: false,
      };
      // Reply in thread if threadTs provided
      if (result.threadTs) {
        postParams.thread_ts = result.threadTs;
      }
      // Use the agent's identity for the post
      const { AGENTS } = require('../config');
      const agentCfg = AGENTS[agentId];
      if (agentCfg?.slackName) postParams.username = agentCfg.slackName;
      if (agentCfg?.icon) postParams.icon_emoji = agentCfg.icon;
      const postRes = await client.chat.postMessage(postParams);
      const postedTs = postRes && postRes.ts;

      // VERIFY (Oct 6, 2026): Read back the thread/channel and confirm the
      // post landed. Fail closed — do not mark complete on unverified posts.
      const landed = await verifyPostLanded(client, channelId, result.threadTs, postedTs);
      if (!landed) {
        console.error(`[directivePoll] ❌ Post verification FAILED for ${agentId} — ` +
          `posted ts ${postedTs || '(none)'} not found in ${result.threadTs ? 'thread' : 'channel'}. ` +
          `Directive NOT marked complete (will retry).`);
        updateAgentHealth(agentId, 'failed');
        return processed;
      }
      console.log(`[directivePoll] ✅ Posted validated reply for ${agentId} in ${result.threadTs ? 'thread' : 'channel'} (verified ts ${postedTs})`);
    } catch (postErr) {
      console.error(`[directivePoll] Failed to post validated reply:`, postErr.message);
      updateAgentHealth(agentId, 'failed');
      return processed;
    }
  }

  if (msgTs > parseFloat(state[channel] || '0')) state[channel] = m.ts;

  // HEALTH: Validated evidence posted = completed delivery
  updateAgentHealth(agentId, 'completed');

  // POST SUB-AGENT RESULTS (Oct 4, 2026 — poller is sole poster):
  // Sub-delegations return content via relay(). The poller validates
  // and posts each one. Sub-agents never post directly.
  if (result.subResults && Array.isArray(result.subResults)) {
    for (const sub of result.subResults) {
      if (!sub.result || !sub.result.response) continue;
      const subAgentId = sub.agentId;
      const subSyntax = findUnexecutedCallSyntax(sub.result.response);
      if (subSyntax) {
        console.log(`[directivePoll] ${subAgentId} sub-result returned ${subSyntax} without executing it — NOT posting`);
        updateAgentHealth(subAgentId, 'failed');
        continue;
      }
      try {
        const subPostParams = {
          channel: channel,
          text: sanitizePostText(sub.result.response),
          unfurl_links: false,
        };
        if (sub.result.threadTs) subPostParams.thread_ts = sub.result.threadTs;
        await client.chat.postMessage(subPostParams);
        console.log(`[directivePoll] ✅ Posted sub-agent reply for ${subAgentId}`);
        // HEALTH (Oct 6, 2026 — root-cause fix): sub-delegations via relay()
        // are real routed work. Count them as received so completed can never
        // exceed received (was: cfo/cro/facebook showed completed > received,
        // breaking the delivery-rate metric the self-healer checks).
        updateAgentHealth(subAgentId, 'received');
        updateAgentHealth(subAgentId, 'completed');
      } catch (subErr) {
        console.error(`[directivePoll] Failed to post sub-agent reply for ${subAgentId}:`, subErr.message);
        updateAgentHealth(subAgentId, 'failed');
      }
    }
  }

  // AUTO-LINK (Oct 4, 2026 — CEO fix): Every directive automatically
  // updates the agent's Vikunja task with the directive and response.
  // This unifies Slack and Vikunja — staleness becomes impossible
  // because the directive IS the task update.
  await linkDirectiveToTask(agentId, text, result?.response || result?.evidence).catch(e =>
    console.error(`[directivePoll] Auto-link failed for ${agentId}:`, e.message));
  // Queue for verification: the outcome will be checked by directiveVerify.js
  // against EXTERNAL systems (not just Slack text). This ensures "on it"
  // replies aren't mistaken for completed work.
  queueForVerification(text, agentId, result);
  // Suggest collaboration: if this directive overlaps with another agent's work,
  // connect them directly so they work like a real team.
  await suggestCollaboration(text, agentId).catch(e =>
    console.error(`[directivePoll] collaboration suggestion failed:`, e.message));

  return processed;
}

// ─── Phase F: the engine-side finalize loop ──────────────────────────
//
// The intake record IS the finalized-or-not ledger: a record is
// consumable when its status is 'completed' or 'failed' and it has no
// finalizedAt stamp. Consuming runs the record through the shared
// finalizeDelegation above (completed → its stored result; failed →
// null, which engages the same retry machinery a poller-side failure
// hits) and stamps finalizedAt ONLY after finalize returns — a finalize
// that throws leaves the record consumable for the next cycle.
// ─── Visible replies (Oct 21, 2026 — CEO mechanism repair) ───────────
//
// finalizeDelegation posts a reply only when the result carries a
// top-level `response` (the poller's inline shape). A record settled by
// the directive-work Hatchet workflow instead carries the workflow
// output — { [DIRECTIVE_WORK_TASK]: { completed, response, ... } } —
// so the agent's response never reached Slack: it existed only inside
// the intake record while the channel showed a team that never answers.
// This posts that response as a threaded reply under the original
// directive message, with the same author identity the finalize path
// uses (the agent's slackName/icon plus the preserved [from: X → Y]
// header in the text) and the same read-back verification.
//
// The evidence gate still decides completion bookkeeping inside
// finalizeDelegation, untouched. This mirror deliberately does NOT
// re-apply that gate — a reply reporting a tool gap or missing
// evidence is exactly what needs to be visible — but it DOES apply the
// finalize path's two content-safety rejections (unexecuted tool
// markup, #758; garbled output) so junk never becomes visible either.
//
// Double-post discipline: the intake record is the ledger. A record
// whose reply already landed carries replyPostedAt/replyPostedTs and
// is skipped; the marker is written in its OWN intake.update the
// moment the post verifies — before the caller's finalizedAt update —
// so a crash between the two writes can never re-post on the next
// consume pass. A record with a top-level response is skipped too:
// finalizeDelegation owns posting for that shape.
const VISIBLE_REPLY_MAX_CHARS = 4000;
async function postVisibleDirectiveReply({ intake, client, rec } = {}) {
  try {
    if (!rec || rec.replyPostedAt) return false;
    const result = rec.result;
    if (!result || typeof result !== 'object') return false;
    if (typeof result.response === 'string' && result.response) return false;
    let taskName = 'execute-directive';
    try { taskName = require('./directiveWorkflow').DIRECTIVE_WORK_TASK || taskName; } catch { /* keep the literal */ }
    const step = result[taskName];
    const response = step && typeof step.response === 'string' ? step.response : '';
    if (!response) return false;

    const { findUnexecutedCallSyntax } = require('../utils/anthropic');
    if (findUnexecutedCallSyntax(response)) {
      console.log(`[directiveFinalize] visible reply for ${rec.key} (${rec.agentId}) withheld — response contains unexecuted tool markup`);
      return false;
    }
    const { isGarbledOutput } = require('../utils/delegation');
    if (isGarbledOutput(response)) {
      console.log(`[directiveFinalize] visible reply for ${rec.key} (${rec.agentId}) withheld — response failed the garble check`);
      return false;
    }

    // CEO BUILD (Oct 22, 2026): never post a header-only reply (audit F2) —
    // an empty body in the thread reads as the team answering with silence.
    const visibleBody = response.replace(/^\s*\[from:\s*[^\]]+?(?:\u2192|->)[^\]]+?\]\s*/i, '').trim();
    if (visibleBody.length < 20) {
      console.log(`[directiveFinalize] visible reply for ${rec.key} (${rec.agentId}) withheld — response body is empty/trivial (${visibleBody.length} chars)`);
      return false;
    }

    let text = sanitizePostText(response);
    if (text.length > VISIBLE_REPLY_MAX_CHARS) {
      text = `${text.slice(0, VISIBLE_REPLY_MAX_CHARS)}\n…[truncated — the full response is in the directive intake record ${rec.key}]`;
    }
    const postParams = {
      channel: rec.channel,
      text,
      thread_ts: rec.ts,
      unfurl_links: false,
    };
    const { AGENTS } = require('../config');
    const agentCfg = AGENTS[rec.agentId];
    if (agentCfg?.slackName) postParams.username = agentCfg.slackName;
    if (agentCfg?.icon) postParams.icon_emoji = agentCfg.icon;
    const postRes = await client.chat.postMessage(postParams);
    const postedTs = postRes && postRes.ts;
    const landed = await verifyPostLanded(client, rec.channel, rec.ts, postedTs);
    if (!landed) {
      console.error(`[directiveFinalize] ❌ visible reply for ${rec.key} (${rec.agentId}): posted ts ${postedTs || '(none)'} did not verify in thread ${rec.ts} — replyPostedAt NOT stamped`);
      return false;
    }
    await intake.update(rec.key, {
      replyPostedAt: new Date().toISOString(),
      replyPostedTs: postedTs,
    });
    console.log(`[directiveFinalize] ✅ Posted visible threaded reply for ${rec.agentId} under directive ${rec.key} (verified ts ${postedTs})`);
    return true;
  } catch (e) {
    console.error(`[directiveFinalize] visible reply failed for ${rec && rec.key}:`, e.message);
    return false;
  }
}

// ─── Visible failure notice (Nov 2, 2026) ────────────────────────────
//
// The mirror of postVisibleDirectiveReply for FAILED records. Before
// this, a directive whose run failed settled and finalized without a
// word in its thread — the channel showed a team that never answers
// AND never explains. This posts one short notice into the directive's
// thread: the failure class, the step's own evidence line, and what
// happens next (the finalize loop above has already engaged the retry
// machinery). Same double-post discipline as the reply mirror: the
// failurePostedAt marker is written in its OWN intake.update the
// moment the post verifies, before the caller's finalizedAt update.
async function postVisibleDirectiveFailure({ intake, client, rec } = {}) {
  try {
    if (!rec || rec.failurePostedAt) return false;
    if (!rec.channel || !rec.ts) return false;
    let taskName = 'execute-directive';
    try { taskName = require('./directiveWorkflow').DIRECTIVE_WORK_TASK || taskName; } catch { /* keep the literal */ }
    const step = (rec.result && typeof rec.result === 'object') ? rec.result[taskName] : null;
    const errorClass = (step && typeof step.errorClass === 'string' && step.errorClass) || null;
    const evidence = (step && typeof step.evidence === 'string' && step.evidence)
      || (typeof rec.error === 'string' && rec.error)
      || 'the run produced no deliverable';
    const headline = errorClass
      ? `\u26a0\ufe0f Directive run failed (${errorClass}) \u2014 no deliverable was produced.`
      : '\u26a0\ufe0f Directive run failed \u2014 no deliverable was produced.';
    const text = sanitizePostText(`${headline}\n${evidence}\nThis failure has been queued for automatic retry; if it keeps failing it dead-letters and files a ticket.`);
    const postParams = {
      channel: rec.channel,
      text,
      thread_ts: rec.ts,
      unfurl_links: false,
    };
    const { AGENTS } = require('../config');
    const agentCfg = AGENTS[rec.agentId];
    if (agentCfg?.slackName) postParams.username = agentCfg.slackName;
    if (agentCfg?.icon) postParams.icon_emoji = agentCfg.icon;
    const postRes = await client.chat.postMessage(postParams);
    const postedTs = postRes && postRes.ts;
    const landed = await verifyPostLanded(client, rec.channel, rec.ts, postedTs);
    if (!landed) {
      console.error(`[directiveFinalize] \u274c failure notice for ${rec.key} (${rec.agentId}): posted ts ${postedTs || '(none)'} did not verify in thread ${rec.ts} \u2014 failurePostedAt NOT stamped`);
      return false;
    }
    await intake.update(rec.key, {
      failurePostedAt: new Date().toISOString(),
      failurePostedTs: postedTs,
    });
    console.log(`[directiveFinalize] \u26a0\ufe0f Posted visible failure notice for ${rec.agentId} under directive ${rec.key} (verified ts ${postedTs})`);
    return true;
  } catch (e) {
    console.error(`[directiveFinalize] failure notice failed for ${rec && rec.key}:`, e.message);
    return false;
  }
}

function itemFromRecord(rec) {
  return {
    channel: rec.channel,
    m: { ts: rec.ts },
    text: rec.text,
    msgTs: rec.msgTs,
    agentId: rec.agentId,
    requeues: rec.requeues || 0,
  };
}

async function consumeSettledIntakeRecords({ intake, state, client } = {}) {
  if (!intake || !state || !client) {
    throw new Error('consumeSettledIntakeRecords requires { intake, state, client }');
  }
  // CEO BUILD 9: file any parked-directive tickets queued by earlier
  // failures before processing new settlements.
  try { await drainParkTickets(state); } catch { /* ticketing never blocks finalize */ }
  const out = { consumed: 0, directives: 0, roadblocks: 0 };
  const settled = [
    ...(await intake.list('completed')),
    ...(await intake.list('failed')),
  ];
  for (const rec of settled) {
    if (!rec || rec.finalizedAt) continue;
    if (rec.kind === 'roadblock') {
      // Fire-and-forget, mirroring the poller's roadblock branch: the
      // routing already happened inside the workflow step; there is no
      // reply to validate or post and no retry bookkeeping.
      await intake.update(rec.key, { finalizedAt: new Date().toISOString(), finalizedBy: 'consume-loop' });
      out.consumed++;
      out.roadblocks++;
      continue;
    }
    const item = itemFromRecord(rec);
    const result = rec.status === 'completed' ? (rec.result === undefined ? null : rec.result) : null;
    await finalizeDelegation(client, state, item, result);
    // VISIBLE REPLY (Oct 21, 2026 — CEO mechanism repair): mirror a
    // completed workflow run's response into the directive's Slack
    // thread. finalizeDelegation above cannot post it — a workflow
    // result has no top-level response — so without this the agent's
    // answer existed only inside this intake record. Runs after
    // finalize; the helper is best-effort and the record still
    // finalizes if Slack posting fails.
    if (rec.status === 'completed') {
      await postVisibleDirectiveReply({ intake, client, rec });
    }
    // VISIBLE FAILURE NOTICE (Nov 2, 2026): a failed record finalizes
    // as FAILED above (retry machinery engaged by finalizeDelegation);
    // mirror the failure into the directive's thread the same way a
    // completion mirrors its response, so a dead run is never silent.
    if (rec.status === 'failed') {
      await postVisibleDirectiveFailure({ intake, client, rec });
    }
    await intake.update(rec.key, { finalizedAt: new Date().toISOString(), finalizedBy: 'consume-loop' });
    out.consumed++;
    out.directives++;
  }
  return out;
}

// Fallback adoption (Phase F): when the engine dies, intake records it
// claimed can never settle — their runs died with the process (the
// dispatch loop's own stale-recovery covers an engine RESTART; this
// covers the poller finding the engine still down). Records in a
// pre-settlement state older than staleMs are force-settled as failed
// so consumeSettledIntakeRecords routes them into the retry machinery
// (retry → requeue → eventual dead-letter; nothing strands). Fresh
// records are left alone: the engine may merely be restarting.
const DEFAULT_ADOPT_STALE_MS = 10 * 60 * 1000;
async function adoptOrphanedIntakeRecords({ intake, staleMs = DEFAULT_ADOPT_STALE_MS, now = Date.now() } = {}) {
  if (!intake) throw new Error('adoptOrphanedIntakeRecords requires { intake }');
  let forceFailed = 0;
  for (const status of ['registered', 'dispatching', 'dispatched']) {
    const records = await intake.list(status);
    for (const rec of records) {
      const claimedAt = Date.parse(rec.dispatchClaimedAt || rec.dispatchedAt || rec.registeredAt || '') || 0;
      if (!claimedAt || now - claimedAt <= staleMs) continue;
      await intake.update(rec.key, {
        status: 'failed',
        error: 'adopted by fallback poller: engine stale, run presumed dead',
        adoptedByFallback: true,
      });
      forceFailed++;
      console.log(`[directiveFinalize] adopted orphaned intake record ${rec.key} (was ${status})`);
    }
  }
  return { forceFailed };
}

// CEO BUILD 9 — park ticketing. Every dead-lettered directive queued a
// parkTicket on its entry; this drain files ONE Vikunja ticket per
// parked directive, addressed to ExecPM's queue (unassigned in project
// 2 resolves to execPM), carrying the failure history: reason, observed
// postcondition gaps, receipt summary, the salvaged partial work and
// the original text. Idempotent: an entry is filed exactly once.
async function drainParkTickets(state, createTaskFn) {
  const entries = (state && state._deadLetter) || [];
  let filed = 0;
  for (const e of entries) {
    if (!e || !e.parkTicket || e.parkTicket.status !== 'queued') continue;
    try {
      const create = createTaskFn || require('../utils/vikunja').createTask;
      const title = `[BLOCKED] ${e.agentId || 'unknown'} directive failed 3x (${e.reason || 'unknown'}) \u2014 ${(e.text || '').slice(0, 80)}`;
      const lines = [
        `A directive to ${e.agentId || 'unknown'} failed 3 times and was parked by the engine.`,
        `Channel/ts: ${e.channel}:${e.ts}`,
        `Failed at: ${e.failedAt || 'unknown'} \u2014 final reason: ${e.reason || 'unknown'}`,
      ];
      if (Array.isArray(e.postconditionFailures) && e.postconditionFailures.length) {
        lines.push(`Unmet postconditions: ${e.postconditionFailures.map(f => `${f.type}:${f.path || f.url || ''}`).join('; ')}`);
      }
      if (e.receiptSummary) lines.push(`Receipts from the failed runs: ${e.receiptSummary}`);
      if (e.salvage) lines.push(`\nSalvaged partial work from the last run:\n${e.salvage.slice(0, 1000)}`);
      lines.push(`\nOriginal directive:\n${(e.fullText || e.text || '').slice(0, 1500)}`);
      lines.push('\nOwner action (ExecPM): re-scope it, reassign it, or close this ticket with the reason it should stay parked.');
      const task = await create('execPM', 2, { title, description: lines.join('\n') });
      e.parkTicket = { status: 'filed', taskId: task && task.id, filedAt: new Date().toISOString() };
      filed++;
    } catch (err) {
      e.parkTicket = { status: 'error', error: String((err && err.message) || err).slice(0, 200), at: new Date().toISOString() };
    }
  }
  if (filed) console.log(`[directiveFinalize] BUILD 9: filed ${filed} park ticket(s) for dead-lettered directives`);
  return filed;
}

module.exports = {
  init,
  knownAgentIds,
  verifyPostLanded,
  queueForVerification,
  updateAgentHealth,
  linkDirectiveToTask,
  buildReceiptSummary,
  queueRetry,
  dropPendingRetry,
  drainPendingRetry,
  drainDeadLetterRequeues,
  recordRetryFailure,
  drainParkTickets,
  hasVerifiableEvidenceIn,
  countToolReceiptsSince,
  hasEvidenceMarker,
  sanitizePostText,
  finalizeDelegation,
  postVisibleDirectiveReply,
  postVisibleDirectiveFailure,
  itemFromRecord,
  consumeSettledIntakeRecords,
  adoptOrphanedIntakeRecords,
  MAX_PENDING_RETRY,
  REQUEUE_COOLDOWN_MS,
  MAX_REQUEUES,
  DEFAULT_ADOPT_STALE_MS,
};
