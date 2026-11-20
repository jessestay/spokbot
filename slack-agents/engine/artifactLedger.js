/**
 * Artifact Ledger + Daily Roll-Up (Oct 22, 2026 — CEO Build 4, audit F6/F7)
 *
 * The engine counted RUNS, not ARTIFACTS (F6): a day could show a thousand
 * workflow completions and zero deliverables, and nothing anywhere said so.
 * Dead letters accumulated silently the same way (F7). This module computes
 * the per-agent daily truth from primary sources only — the receipts ledger
 * (engine/receipts.js) and the directive-intake records — never from an
 * agent's own prose:
 *
 *   - activity    = tool calls (ok / error), distinct tasks touched
 *   - artifacts   = the receipts' own artifacts[] on ok receipts
 *   - deliverables= file artifacts + Vikunja writes (comment / update /
 *                   evidence) — the things a principal can open and check
 *   - directives  = intake records: registered / completed / replies posted
 *                   / dead-lettered, per agent per day
 *
 * Alarms (printed at the TOP of the roll-up, not buried):
 *   - ZERO-ARTIFACT: agent was active but produced no deliverable and
 *     posted no directive reply that day.
 *   - SILENT: agent had no receipts and no directives at all.
 *
 * CLI: node engine/artifactLedger.js [--day YYYY-MM-DD] [--out <dir>]
 * Default day = yesterday (America/Denver). Writes <day>.json and
 * latest.md into .state/artifact-rollups/ and prints the markdown.
 * Reader failures are fail-closed (exit 2): a roll-up that cannot read
 * its sources must say so loudly, never publish zeros.
 */

const fs = require('fs');
const path = require('path');

const ROSTER = ['cco', 'cfo', 'cmo', 'cro', 'cto', 'cuxo', 'execpm', 'facebook', 'hr', 'jobcoach', 'lawyer'];
const DISPLAY = { execpm: 'execPM' };

// Artifact kinds that are deliverables a principal can open and verify.
const DELIVERABLE_KINDS = new Set(['file']);
// Mutating tools whose ok receipt IS a deliverable even when the tool
// recorded no explicit artifacts[] entry (verified against the live
// ledger Oct 22, 2026: vikunjaComment/vikunjaUpdateTask/
// vikunjaAttachEvidence receipts carry empty artifacts arrays).
const IMPLICIT_DELIVERABLE_TOOLS = new Set(['vikunjaComment', 'vikunjaUpdateTask', 'vikunjaAttachEvidence']);

function displayName(agentId) {
  return DISPLAY[agentId] || agentId;
}

function denverDay(isoTs) {
  const d = new Date(isoTs);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function yesterdayDenver(now = new Date()) {
  const todayDenver = denverDay(now.toISOString());
  const [y, m, dd] = todayDenver.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, dd - 1));
  return prev.toISOString().slice(0, 10);
}

// Classify one receipt. Only ok receipts produce artifacts. Returns the
// artifact descriptors [{kind, ref}] the receipt evidences.
function classifyReceipt(r) {
  if (!r || r.status !== 'ok') return [];
  const out = [];
  const explicit = Array.isArray(r.artifacts) ? r.artifacts : [];
  for (const a of explicit) {
    if (a && a.kind) out.push({ kind: a.kind, ref: a.ref || null });
  }
  if (out.length === 0 && IMPLICIT_DELIVERABLE_TOOLS.has(r.tool)) {
    out.push({ kind: 'vikunja_write', ref: r.taskId != null ? `task:${r.taskId}` : null });
  }
  return out;
}

function isDeliverable(artifact) {
  return DELIVERABLE_KINDS.has(artifact.kind) || artifact.kind === 'vikunja_write';
}

function emptyAgentStats() {
  return {
    toolCalls: 0, okCalls: 0, errorCalls: 0, tasksTouched: 0,
    artifactsByKind: {}, deliverables: 0,
    directivesRegistered: 0, directivesCompleted: 0, repliesPosted: 0, deadLetters: 0,
  };
}

function rollupDay({ receipts = [], intakeRecords = [], deadLetters = [], day, roster = ROSTER }) {
  const agents = {};
  const taskSets = {};
  const ensure = (rawId) => {
    const id = String(rawId || 'unknown').toLowerCase();
    if (!agents[id]) { agents[id] = emptyAgentStats(); taskSets[id] = new Set(); }
    return id;
  };
  for (const id of roster) ensure(id);

  for (const r of receipts) {
    if (!r || denverDay(r.ts) !== day) continue;
    const id = ensure(r.agentId);
    const s = agents[id];
    s.toolCalls += 1;
    if (r.status === 'ok') s.okCalls += 1; else s.errorCalls += 1;
    if (r.taskId != null) taskSets[id].add(r.taskId);
    for (const a of classifyReceipt(r)) {
      s.artifactsByKind[a.kind] = (s.artifactsByKind[a.kind] || 0) + 1;
      if (isDeliverable(a)) s.deliverables += 1;
    }
  }

  for (const rec of intakeRecords) {
    if (!rec || !rec.agentId || !rec.registeredAt) continue;
    if (denverDay(rec.registeredAt) !== day) continue;
    const id = ensure(rec.agentId);
    const s = agents[id];
    s.directivesRegistered += 1;
    if (rec.status === 'completed') s.directivesCompleted += 1;
    if (rec.status === 'dead_letter' || rec.status === 'dead-letter') s.deadLetters += 1;
    if (rec.replyPostedAt && denverDay(rec.replyPostedAt) === day) s.repliesPosted += 1;
  }

  // Dead letters live in the poll state's _deadLetter array (found
  // Oct 22, 2026 — 108 entries, incl. two CEO directives killed by an
  // HTML-escaped header arrow). agentId is null when the header itself
  // was unparseable; those count under 'unknown'.
  for (const e of deadLetters) {
    if (!e || !e.failedAt) continue;
    if (denverDay(e.failedAt) !== day) continue;
    const id = ensure(e.agentId || 'unknown');
    agents[id].deadLetters += 1;
  }

  for (const id of Object.keys(agents)) agents[id].tasksTouched = taskSets[id].size;

  const alarms = [];
  const silent = [];
  for (const id of Object.keys(agents)) {
    const s = agents[id];
    const active = s.toolCalls > 0 || s.directivesRegistered > 0;
    if (!active) { silent.push(id); continue; }
    if (s.deliverables === 0 && s.repliesPosted === 0) alarms.push(id);
  }

  const totals = emptyAgentStats();
  for (const s of Object.values(agents)) {
    totals.toolCalls += s.toolCalls;
    totals.okCalls += s.okCalls;
    totals.errorCalls += s.errorCalls;
    totals.tasksTouched += s.tasksTouched;
    totals.deliverables += s.deliverables;
    totals.directivesRegistered += s.directivesRegistered;
    totals.directivesCompleted += s.directivesCompleted;
    totals.repliesPosted += s.repliesPosted;
    totals.deadLetters += s.deadLetters;
    for (const [k, v] of Object.entries(s.artifactsByKind)) {
      totals.artifactsByKind[k] = (totals.artifactsByKind[k] || 0) + v;
    }
  }

  return { day, agents, totals, alarms, silent };
}

function renderMarkdown(rollup) {
  const { day, agents, totals, alarms, silent } = rollup;
  const lines = [];
  lines.push(`# Artifact roll-up — ${day} (America/Denver)`);
  lines.push('');
  lines.push('Computed from the receipts ledger + directive intake. Never from agent self-reports.');
  lines.push('');
  if (alarms.length) {
    lines.push('## ⚠ ZERO-ARTIFACT (active, no deliverable, no posted reply)');
    for (const id of alarms) lines.push(`- ${displayName(id)}`);
    lines.push('');
  }
  if (silent.length) {
    lines.push('## ⚠ SILENT (no receipts, no directives)');
    for (const id of silent) lines.push(`- ${displayName(id)}`);
    lines.push('');
  }
  if (!alarms.length && !silent.length) lines.push('No alarms: every agent produced a deliverable or a posted reply.');
  lines.push('');
  lines.push('| agent | calls | ok | err | tasks | deliverables | artifacts | directives done/reg | replies | dead-letters |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  const kindsStr = (s) => Object.entries(s.artifactsByKind).map(([k, v]) => `${k}:${v}`).join(', ') || '—';
  for (const id of Object.keys(agents).sort()) {
    const s = agents[id];
    lines.push(`| ${displayName(id)} | ${s.toolCalls} | ${s.okCalls} | ${s.errorCalls} | ${s.tasksTouched} | ${s.deliverables} | ${kindsStr(s)} | ${s.directivesCompleted}/${s.directivesRegistered} | ${s.repliesPosted} | ${s.deadLetters} |`);
  }
  lines.push(`| **total** | ${totals.toolCalls} | ${totals.okCalls} | ${totals.errorCalls} | ${totals.tasksTouched} | ${totals.deliverables} | ${kindsStr(totals)} | ${totals.directivesCompleted}/${totals.directivesRegistered} | ${totals.repliesPosted} | ${totals.deadLetters} |`);
  lines.push('');
  return lines.join('\n');
}

// --- live-source loaders (fail-closed) ---

// The single shared resolver in utils/instancePaths.js (US-FW-002):
// legacy env overrides win, then SPOKBOT_STATE_DIR, then the checkout's
// own .state — the same directory utils/state.js and receipts.js use.
const { resolvedStateDir } = require('../utils/instancePaths');
function stateDir() {
  return resolvedStateDir();
}

function loadDeadLetters(file = path.join(__dirname, '.directive-poll-state.json')) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(state && state._deadLetter) ? state._deadLetter : [];
  } catch {
    return []; // secondary source; receipts remain primary and fail-closed
  }
}

function loadReceipts() {
  const receipts = require('./receipts');
  if (typeof receipts.readAllReceipts !== 'function') {
    throw new Error('engine/receipts.js does not export readAllReceipts');
  }
  return receipts.readAllReceipts();
}

function loadIntakeRecords(dir = path.join(stateDir(), 'directive-intake')) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return []; // no intake dir yet is a fact, not a read failure
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (rec && rec.agentId && rec.registeredAt) out.push(rec);
    } catch { /* skip a torn record; receipts remain the primary source */ }
  }
  return out;
}

function main(argv) {
  let day = yesterdayDenver();
  let outDir = path.join(stateDir(), 'artifact-rollups');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--day' && argv[i + 1]) day = argv[++i];
    if (argv[i] === '--out' && argv[i + 1]) outDir = argv[++i];
  }
  let receipts;
  try {
    receipts = loadReceipts();
  } catch (e) {
    console.error(`[artifactLedger] FATAL: cannot read receipts ledger: ${e.message}`);
    process.exit(2);
  }
  const intakeRecords = loadIntakeRecords();
  const deadLetters = loadDeadLetters();
  const rollup = rollupDay({ receipts, intakeRecords, deadLetters, day });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${day}.json`), JSON.stringify(rollup, null, 2));
  const md = renderMarkdown(rollup);
  fs.writeFileSync(path.join(outDir, 'latest.md'), md);
  // CEO BUILD 10 (gap G5): mirror the roll-up into the agent sandbox so
  // every agent can actually read the shared scoreboard.
  try {
    const sandboxRollups = path.join(__dirname, '..', '..', 'engine-home', 'workspace', 'agent-sandbox', 'company', 'rollups');
    fs.mkdirSync(sandboxRollups, { recursive: true });
    fs.writeFileSync(path.join(sandboxRollups, `${day}.json`), JSON.stringify(rollup, null, 2));
    fs.writeFileSync(path.join(sandboxRollups, 'latest.md'), md);
  } catch (e) {
    console.error(`[artifactLedger] BUILD 10 sandbox mirror failed: ${e.message}`);
  }
  console.log(md);
  if (rollup.alarms.length || rollup.silent.length) {
    console.error(`[artifactLedger] ALARMS ${day}: zero-artifact=[${rollup.alarms.join(',')}] silent=[${rollup.silent.join(',')}]`);
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  ROSTER,
  DELIVERABLE_KINDS,
  IMPLICIT_DELIVERABLE_TOOLS,
  classifyReceipt,
  isDeliverable,
  denverDay,
  yesterdayDenver,
  rollupDay,
  renderMarkdown,
  loadReceipts,
  loadIntakeRecords,
  loadDeadLetters,
  stateDir,
};
