'use strict';

// CEO BUILD 8 (Oct 22, 2026) — THE MANAGER LOOP.
//
// Builds 4+5 gave the team a scoreboard (the morning roll-up) and a
// daily prompt (the proactivity sweep). What was still missing is a
// manager who acts DURING the day: on Oct 21 seven agents were silent
// for a full day and nothing intervened until the next morning's
// report. This module posts a twice-daily standup directive to ExecPM
// carrying today's ledger-so-far — per-agent calls and deliverables
// (artifactLedger.rollupDay over primary sources), owned queue depths
// (Vikunja, resolved through tasks.resolveOwner), directives stuck in
// retry, and today's dead letters — and it makes ExecPM responsible
// for acting in the same pass: wake or reassign silent owners, decide
// stuck retries, and report every action in the thread with ticket
// IDs. Build 4's roll-up grades whether it happened (ExecPM's reply
// and Vikunja writes are deliverables like anyone else's).
//
// Slots: 16:05 UTC (10:05 MDT / 09:05 MST) and 20:05 UTC (14:05 MDT /
// 13:05 MST), derived from the UTC hour so one timer pair serves both.
// Idempotent per Denver day + slot via .state/manager-standups.json.

const fs = require('fs');
const path = require('path');

const MANAGEMENT_CHANNEL = 'C0ASH4TF604';
const ROSTER = ['cco', 'cfo', 'cmo', 'cro', 'cto', 'cuxo', 'execpm', 'facebook', 'hr', 'jobcoach', 'lawyer'];
const DISPLAY = { execpm: 'ExecPM', cco: 'CCO', cfo: 'CFO', cmo: 'CMO', cro: 'CRO', cto: 'CTO', cuxo: 'CUXO', facebook: 'Facebook', hr: 'HR', jobcoach: 'Job Coach', lawyer: 'Lawyer' };

function denverDay(isoTs) {
  const d = new Date(isoTs);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function slotForHour(utcHour) {
  return utcHour < 18 ? 'am' : 'pm';
}

function stateFilePath() {
  return path.join(__dirname, '..', '.state', 'manager-standups.json');
}

function loadState(file = stateFilePath()) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function saveState(state, file = stateFilePath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function standupDue(state, day, slot) {
  return !state[`${day}:${slot}`];
}

function recordStandup(state, day, slot, ts) {
  return { ...state, [`${day}:${slot}`]: { ts, postedAt: new Date().toISOString() } };
}

// Per-owner open-queue depths from a task list, resolved exactly the
// way the picker resolves them (assignee first, keyword fallback).
function queueDepths(tasks, resolveOwner) {
  const depths = {};
  for (const t of tasks || []) {
    const owner = resolveOwner(t);
    depths[owner] = (depths[owner] || 0) + 1;
  }
  return depths;
}

// CEO BUILD 8b: a completed directive reply addressed to the CEO is a
// package the CEO owes Jesse a presentation of. It stays on this list
// until the CEO records its key in .state/ceo-relay-cleared.json.
function relayDebt(intakeRecords, clearedKeys, nowMs, windowMs = 72 * 3600 * 1000) {
  const cleared = new Set(clearedKeys || []);
  const debt = [];
  for (const rec of intakeRecords || []) {
    if (!rec || !rec.agentId || !rec.ts) continue;
    const key = `${rec.channel}:${rec.ts}`;
    if (cleared.has(key)) continue;
    const r = (rec.result || {})['execute-directive'] || {};
    if (!r.completed) continue;
    const resp = typeof r.response === 'string' ? r.response : '';
    if (!/^\s*\[from:[^\]]+(?:\u2192|->)\s*CEO\]/i.test(resp)) continue;
    if (resp.replace(/^\s*\[from:[^\]]+\]\s*/i, ).trim().length < 200) continue; // header-only stubs are not packages
    const when = Date.parse(rec.replyPostedAt || rec.registeredAt || '') || 0;
    if (nowMs - when > windowMs) continue;
    debt.push({ agentId: rec.agentId, ts: rec.ts, chars: resp.length });
  }
  return debt;
}

function clearedFilePath() {
  return path.join(__dirname, '..', '.state', 'ceo-relay-cleared.json');
}

function loadCleared(file = clearedFilePath()) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function buildStandupText({ day, slot, rollup, queues, stuckRetries, deadLettersToday, relayDebt: debt = [] }) {
  const agents = (rollup && rollup.agents) || {};
  const lines = [];
  lines.push(`[from: CEO → ExecPM] MANAGER STANDUP — ${day} (${slot === 'am' ? 'morning' : 'afternoon'} pass)`);
  lines.push('');
  lines.push('Today so far (receipts + intake only — claims do not count):');
  for (const id of ROSTER) {
    const s = agents[id] || { toolCalls: 0, deliverables: 0 };
    const q = queues[id] || queues[id === 'execpm' ? 'execPM' : id] || 0;
    lines.push(`- ${DISPLAY[id] || id}: ${s.deliverables} deliverable(s), ${s.toolCalls} tool call(s), owned queue ${q}`);
  }
  const silent = ROSTER.filter(id => {
    const s = agents[id] || { toolCalls: 0 };
    const q = queues[id] || queues[id === 'execpm' ? 'execPM' : id] || 0;
    return s.toolCalls === 0 && q > 0;
  });
  lines.push('');
  if (silent.length) {
    lines.push(`ZERO ACTIVITY with work waiting: ${silent.map(id => DISPLAY[id] || id).join(', ')}.`);
  } else {
    lines.push('No agent is silent while owning work.');
  }
  if (stuckRetries && stuckRetries.length) {
    lines.push('');
    lines.push(`Directives stuck in retry (count ≥ 2): ${stuckRetries.slice(0, 8).map(r => `${r.channel}:${r.ts} (x${r.count})`).join('; ')}.`);
  }
  if (deadLettersToday) {
    lines.push(`Dead-lettered directives today: ${deadLettersToday}. Check engine/.directive-poll-state.json _deadLetter before assuming an agent ignored work.`);
  }
  if (debt.length) {
    lines.push('');
    lines.push('CEO RELAY DEBT — these agents delivered packages to the CEO that have NOT been presented to Jesse yet:');
    for (const d of debt.slice(0, 8)) lines.push(`- ${DISPLAY[d.agentId] || d.agentId}: directive ${d.ts} (${d.chars} chars)`);
    lines.push('This is the CEO\'s debt, not the agents\'. Keep it listed in your standup reply until it clears.');
  }
  lines.push('');
  lines.push('Your job in THIS pass (you are the manager on duty):');
  lines.push('1. For every zero-activity agent above with a queue: post a directive to them in #management assigning their stalest owned task by ID, or reassign that task to an active agent — your choice, but the work moves today.');
  lines.push('2. For every stuck retry: decide now — re-scope it, reassign it, or park it BLOCKED with a new Vikunja ticket explaining why.');
  lines.push('3. Reply in THIS thread listing every action you took, with the Vikunja ticket IDs or Slack timestamps as evidence. A standup with no reply counts as a failed standup in tomorrow\'s roll-up.');
  lines.push('4. NEVER-IDLE LADDER (Jesse, Oct 23): work is 24/7 and never stops. For every owner whose eligible queue above is empty, or whose work is fully blocked, state in your reply what they were redirected to: (a) the next backlog user story pulled forward (ticket ID), (b) product/revenue ideas filed as new backlog tickets (IDs), or (c) a release-planning breakdown of the next significant project into user stories with Fibonacci points and acceptance criteria, filed as Vikunja tasks (IDs). An agent with no work, no filed idea, and no breakdown in progress is a standup failure — name it and fix it in this pass.');
  return lines.join('\n');
}

function readEnvToken(name, envPath = path.join(__dirname, '..', '.env')) {
  const text = fs.readFileSync(envPath, 'utf8');
  const m = text.match(new RegExp(`^${name}=(\\S+)\\s*$`, 'm'));
  if (!m) throw new Error(`${name} not found in slack-agents/.env`);
  return m[1];
}

async function fetchOpenTasks(token) {
  const out = [];
  for (const pid of [2, 16]) {
    for (let page = 1; page <= 25; page++) {
      const url = `http://127.0.0.1:3456/api/v1/projects/${pid}/tasks?filter=${encodeURIComponent('done = false')}&per_page=100&page=${page}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`vikunja list project ${pid} -> ${r.status}`);
      const items = await r.json().catch(() => []);
      if (!Array.isArray(items) || !items.length) break;
      out.push(...items);
      if (items.length < 50) break;
    }
  }
  return out;
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const now = new Date();
  const day = denverDay(now.toISOString());
  const slotIdx = argv.indexOf('--slot');
  const slot = slotIdx >= 0 ? argv[slotIdx + 1] : slotForHour(now.getUTCHours());

  const state = loadState();
  if (!force && !standupDue(state, day, slot)) {
    console.log(`[managerStandup] ${day}:${slot} already posted, nothing to do`);
    return 0;
  }

  const ledger = require('./artifactLedger');
  const receipts = require('./receipts');
  const allReceipts = receipts.readAllReceipts ? receipts.readAllReceipts() : [];
  let intakeRecords = [];
  try {
    const dir = path.join(__dirname, '..', '.state', 'directive-intake');
    intakeRecords = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { /* intake dir may not exist yet */ }
  let pollState = {};
  try { pollState = JSON.parse(fs.readFileSync(path.join(__dirname, '.directive-poll-state.json'), 'utf8')); } catch { /* optional */ }
  const deadLetters = Array.isArray(pollState._deadLetter) ? pollState._deadLetter : [];
  const rollup = ledger.rollupDay({ receipts: allReceipts, intakeRecords, deadLetters, day });
  // rollupDay already day-filters dead letters by their failedAt stamp.
  const deadLettersToday = Object.values(rollup.agents || {}).reduce((n, s) => n + (s.deadLetters || 0), 0);
  const stuckRetries = Object.entries(pollState._retries || {})
    .map(([key, v]) => {
      const [channel, ts] = key.split(':');
      return { channel, ts, count: (v && v.count) || 0 };
    })
    .filter(r => r.count >= 2);

  const { resolveOwner } = require('../utils/tasks');
  const openTasks = await fetchOpenTasks(readEnvToken('VIKUNJA_TOKEN'));
  const queues = queueDepths(openTasks, resolveOwner);
  // resolveOwner returns engine ids (execPM camel-case); normalize to roster keys.
  const queuesByRoster = {};
  for (const [k, v] of Object.entries(queues)) queuesByRoster[k.toLowerCase()] = v;

  const debt = relayDebt(intakeRecords, loadCleared(), Date.now());
  const text = buildStandupText({ day, slot, rollup, queues: queuesByRoster, stuckRetries, deadLettersToday, relayDebt: debt });
  if (dryRun) {
    console.log(text);
    return 0;
  }
  const { WebClient } = require('@slack/web-api');
  const client = new WebClient(readEnvToken('SLACK_BOT_TOKEN'));
  const res = await client.chat.postMessage({ channel: MANAGEMENT_CHANNEL, text });
  saveState(recordStandup(state, day, slot, res.ts));
  console.log(`[managerStandup] ${day}:${slot} posted ts=${res.ts}`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code || 0)).catch(err => {
    console.error('[managerStandup] fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { buildStandupText, queueDepths, standupDue, recordStandup, slotForHour, denverDay, relayDebt };
