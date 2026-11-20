'use strict';
/**
 * Remediation for the floor-contract sweep (Oct 21, 2026).
 * 1) Seven tasks (280, 376, 455, 487, 548, 553, 647) each lost their SECOND
 *    assignee when the restore assignTask PUT hit HTTP 500 mid-sweep and the
 *    sweep's retry misclassified them as skip-now-contracted. Restore the
 *    missing assignee (originals from the 14:08Z pre-sweep backup DB,
 *    cross-checked against the live DB) with retrying assigns, then verify.
 * 2) Task #669 is open in the DB but invisible to the API list endpoint the
 *    sweep (and the picker) uses. Stamp it via getTask-by-id using the same
 *    engine path (stampContract + verifiedWork + updateTask + assignee
 *    preserve/verify) so the sweep covers every open task in scope.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const vikunja = require('./utils/vikunja');
const { parseContract, stampContract, templates } = require('./engine/taskContract');

const AGENT = 'execPM';
const LOG_FILE = path.join(__dirname, '.state', 'contract-sweep-remediation.jsonl');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const idsOf = t => (t.assignees || []).map(a => a.id).sort((a, b) => a - b);
const sameIds = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function log(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}

async function assignWithRetry(taskId, userId) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await vikunja.assignTask(AGENT, taskId, userId);
      return true;
    } catch (e) {
      lastErr = e;
      if (!/HTTP 5\d\d/.test(e.message)) throw e;
      const wait = 1500 * (attempt + 1);
      log({ event: 'assign-retry', taskId, userId, attempt: attempt + 1, error: e.message, wait });
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function ensureAssignees(taskId, wantIds) {
  let cur = await vikunja.getTask(AGENT, taskId);
  let have = idsOf(cur);
  if (sameIds(have, wantIds)) return { ok: true, restored: false, have };
  for (const id of wantIds) if (!have.includes(id)) await assignWithRetry(taskId, id);
  cur = await vikunja.getTask(AGENT, taskId);
  have = idsOf(cur);
  for (const id of have.slice()) if (!wantIds.includes(id)) await vikunja.unassignTask(AGENT, taskId, id);
  cur = await vikunja.getTask(AGENT, taskId);
  have = idsOf(cur);
  return { ok: sameIds(have, wantIds), restored: true, have };
}

const MISSING = { 280: [5], 376: [3], 455: [5], 487: [5], 548: [5], 553: [7], 647: [9] };
const WANT = { 280: [3, 5], 376: [2, 3], 455: [3, 5], 487: [3, 5], 548: [2, 5], 553: [2, 7], 647: [2, 9] };

async function main() {
  let allOk = true;
  for (const [tidStr, missing] of Object.entries(MISSING)) {
    const tid = Number(tidStr);
    for (const uid of missing) await assignWithRetry(tid, uid);
    const res = await ensureAssignees(tid, WANT[tidStr]);
    log({ event: 'assignees-remediated', id: tid, want: WANT[tidStr], have: res.have, ok: res.ok });
    if (!res.ok) allOk = false;
    await sleep(400);
  }
  // #669: stamp via by-id path
  const t669 = await vikunja.getTask(AGENT, 669);
  log({ event: 'task669-fetched', done: t669.done, hasContract: !!parseContract(t669.description), assignees: idsOf(t669) });
  if (!t669.done && !parseContract(t669.description)) {
    const want = idsOf(t669);
    const newDesc = stampContract(t669.description, templates.verifiedWork({ taskId: 669 }));
    await vikunja.updateTask(AGENT, 669, { description: newDesc });
    const after = await vikunja.getTask(AGENT, 669);
    const contractOk = !!parseContract(after.description);
    const aRes = await ensureAssignees(669, want);
    log({ event: 'task669-stamped', contractOk, assigneesBefore: want, assigneesAfter: aRes.have, assigneesOk: aRes.ok });
    if (!contractOk || !aRes.ok) allOk = false;
  }
  log({ event: 'remediation-done', allOk });
  if (!allOk) process.exit(2);
}

main().catch(e => { console.error(e); process.exit(1); });
