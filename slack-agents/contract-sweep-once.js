'use strict';
/**
 * One-time floor-contract sweep (Oct 21, 2026 — CEO-ordered follow-up to the
 * delegation-stall repair). Stamps the M3 floor contract
 * (templates.verifiedWork, generic@v1 — identical to the #761/#112/#105
 * stall-repair stamps) onto every OPEN task in projects 2 and 16 that lacks
 * a parseable MACF-CONTRACT, excluding tasks whose persisted lifecycle is
 * DONE or BLOCKED.
 *
 * Uses ONLY the engine's own code path: engine/taskContract.stampContract +
 * templates, utils/vikunja.updateTask (the same path the stall repair used).
 *
 * SAFETY: utils/vikunja.updateTask's GET-merge-POST wipes assignees (known
 * bug). This sweep snapshots assignee ids before each write and verifies
 * them after, restoring via assignTask/unassignTask when needed. If any
 * task's assignees cannot be verified identical after the write, the sweep
 * ABORTS immediately (exit 2) and reports.
 *
 * Usage: node contract-sweep-once.js pilot [n]   — stamp first n candidates
 *        node contract-sweep-once.js full        — stamp all candidates
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const vikunja = require('./utils/vikunja');
const { parseContract, stampContract, templates } = require('./engine/taskContract');

const AGENT = 'execPM';
const PROJECTS = [2, 16];
const STATE_FILE = path.join(__dirname, '.state', 'memory-workEngine.json');
const LOG_FILE = path.join(__dirname, '.state', 'contract-sweep-log.jsonl');
const DELAY_MS = 250;

const mode = process.argv[2] || 'pilot';
const pilotN = parseInt(process.argv[3] || '5', 10);

function log(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const idsOf = t => (t.assignees || []).map(a => a.id).sort((a, b) => a - b);
const sameIds = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function listAllOpen(projectId) {
  const all = [];
  let page = 1;
  for (;;) {
    const batch = await vikunja.listTasks(AGENT, projectId, { filter: 'done = false', page, perPage: 50 });
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 50) break;
    page++;
  }
  return all;
}

// Verify assignees equal wantIds; restore via assign/unassign if the
// updateTask POST wiped or altered them. Returns { ok, restored, have }.
async function ensureAssignees(taskId, wantIds) {
  let cur = await vikunja.getTask(AGENT, taskId);
  let have = idsOf(cur);
  if (sameIds(have, wantIds)) return { ok: true, restored: false, have };
  for (const id of wantIds) if (!have.includes(id)) await vikunja.assignTask(AGENT, taskId, id);
  cur = await vikunja.getTask(AGENT, taskId);
  have = idsOf(cur);
  for (const id of have.slice()) if (!wantIds.includes(id)) await vikunja.unassignTask(AGENT, taskId, id);
  cur = await vikunja.getTask(AGENT, taskId);
  have = idsOf(cur);
  return { ok: sameIds(have, wantIds), restored: true, have };
}

async function stampOne(c) {
  const before = await vikunja.getTask(AGENT, c.id);
  if (before.done) return { outcome: 'skip-now-done' };
  if (parseContract(before.description)) return { outcome: 'skip-now-contracted' };
  const want = idsOf(before);
  const newDesc = stampContract(before.description, templates.verifiedWork({ taskId: c.id }));
  await vikunja.updateTask(AGENT, c.id, { description: newDesc });
  const after = await vikunja.getTask(AGENT, c.id);
  const contractOk = !!parseContract(after.description);
  const aRes = await ensureAssignees(c.id, want);
  if (!aRes.ok) {
    log({ event: 'ABORT-assignees-unverifiable', id: c.id, want, have: aRes.have });
    console.error(`ABORT: assignees unverifiable on task #${c.id} (want ${want}, have ${aRes.have})`);
    process.exit(2);
  }
  if (!contractOk) return { outcome: 'fail', error: 'contract missing after stamp' };
  return { outcome: 'stamped', assigneesBefore: want, assigneesAfter: aRes.have, restored: aRes.restored };
}

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const excluded = new Set();
  for (const [tid, v] of Object.entries(state.taskLifecycle || {})) {
    if (v && (v.state === 'DONE' || v.state === 'BLOCKED')) excluded.add(Number(tid));
  }
  log({ event: 'start', mode, excludedLifecycle: [...excluded].sort((a, b) => a - b) });

  let candidates = [];
  let alreadyContracted = 0;
  let openTotal = 0;
  let excludedCount = 0;
  for (const pid of PROJECTS) {
    const tasks = await listAllOpen(pid);
    openTotal += tasks.length;
    for (const t of tasks) {
      if (excluded.has(t.id)) { excludedCount++; continue; }
      if (parseContract(t.description)) { alreadyContracted++; continue; }
      candidates.push({ id: t.id, project: pid });
    }
  }
  log({ event: 'scope', openTotal, alreadyContractedInScope: alreadyContracted, excludedLifecycle: excludedCount, candidates: candidates.length });

  if (mode === 'pilot') candidates = candidates.slice(0, pilotN);

  let stamped = 0;
  const failures = [];
  for (const c of candidates) {
    let result = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        result = await stampOne(c);
      } catch (e) {
        lastErr = e;
        if (attempt === 0 && /HTTP 5\d\d|SQLITE_BUSY|database is locked/i.test(e.message)) {
          log({ event: 'retry', id: c.id, error: e.message });
          await sleep(4000);
        }
      }
    }
    if (!result) {
      failures.push({ id: c.id, error: lastErr.message });
      log({ event: 'fail', id: c.id, error: lastErr.message });
    } else if (result.outcome === 'stamped') {
      stamped++;
      log({ event: 'stamped', id: c.id, project: c.project, assigneesBefore: result.assigneesBefore, assigneesAfter: result.assigneesAfter, restored: result.restored });
    } else if (result.outcome === 'fail') {
      failures.push({ id: c.id, error: result.error });
      log({ event: 'fail', id: c.id, error: result.error });
    } else {
      log({ event: result.outcome, id: c.id });
    }
    await sleep(DELAY_MS);
  }
  const summary = { event: 'done', mode, stamped, failures, failureCount: failures.length };
  log(summary);
  fs.writeFileSync(path.join(__dirname, '.state', `contract-sweep-summary-${mode}.json`), JSON.stringify(summary, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
