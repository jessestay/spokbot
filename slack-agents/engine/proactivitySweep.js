/**
 * Proactivity Sweep (Oct 22, 2026 — CEO Build 5, audit F8)
 *
 * The Proactivity Charter was a DOCUMENT, not scheduled work (F8): agents
 * were told to be proactive and then waited to be tasked, because nothing
 * ever tasked them with it. This module makes the charter an engine
 * mechanism: once a day it posts one sweep directive per agent into
 * #management through the normal directive path — the exact header format
 * directiveScan registers — so every sweep rides the Build 1+2 outcome
 * contract (empty/header-only results fail), the finalize evidence gate,
 * and the Build 4 artifact roll-up that measures what the sweep produced.
 *
 * Idempotent per agent per Denver day (state: .state/proactivity-sweeps.json).
 * One agent's post failure never blocks the others; the run exits non-zero
 * if any post failed, so the systemd journal shows it loudly.
 *
 * CLI: node engine/proactivitySweep.js [--day YYYY-MM-DD] [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const MANAGEMENT_CHANNEL = process.env.MACF_MGMT_CHANNEL || 'C0ASH4TF604';

// Header names must resolve through directiveScan's DELEGATION_TARGETS
// (lowercased, spaces/dashes stripped) to the agent id — the Build 5
// tests assert this against the live config so a rename fails in tests,
// not silently in production (the Oct 21 header-format lesson).
const AGENTS = [
  { id: 'execPM', name: 'ExecPM', focus: 'board throughput: stalled deliverables, blocked tickets, and pitches from the team that need triage into tickets or a recorded no' },
  { id: 'cmo', name: 'CMO', focus: 'revenue content and the Canva engine: affiliate pushes, the canvabook hub, and content that sells the books and courses' },
  { id: 'cco', name: 'CCO', focus: 'the content pipeline: drafts Jesse can approve, hooks and packaging in the Holiday/Eves standard, nothing published without approval' },
  { id: 'cfo', name: 'CFO', focus: 'cash and risk: upcoming bills, debt payoff order, money leaks, and anything that changes what Jesse can afford this month' },
  { id: 'cro', name: 'CRO', focus: 'revenue offers and funnels: the audit offer, the workshop, pricing and conversion on live pages' },
  { id: 'cto', name: 'CTO', focus: 'system reliability and the Repeats engine: failure modes, missing tools, and automation that removes manual work' },
  { id: 'cuxo', name: 'CUXO', focus: 'conversion and clarity on live pages: staynalive.com and canvabook flows a visitor actually hits' },
  { id: 'jobcoach', name: 'Job Coach', focus: "Jesse's job search and teaching path: best-fit roles, tailored applications with portal confirmations, and the AEL/APPEL steps" },
  { id: 'lawyer', name: 'Lawyer', focus: 'legal exposure: the #766 judgment identification, deadlines, and anything that creates or reduces legal risk' },
  { id: 'facebook', name: 'Facebook', focus: 'Facebook channels: Marketplace finds, page/group opportunities, and audience growth that feeds revenue' },
  { id: 'hr', name: 'HR', focus: 'team process: documentation gaps, role clarity, and anything that makes the other agents faster or less error-prone' },
];

function denverDay(isoTs) {
  const d = new Date(isoTs);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// Pure: one agent's feedback line from a parsed artifact roll-up (the
// Build 4 JSON). Agents cannot all read the .state path (sandbox grants
// differ — CRO proved it Oct 22), so the numbers travel INSIDE the
// directive text; the path stays for the intake scanner's rule.
function rollupLineFor(rollup, agentId) {
  if (!rollup || !rollup.agents) return '';
  const s = rollup.agents[String(agentId).toLowerCase()];
  if (!s) return '';
  let line = `Yesterday's roll-up (${rollup.day}): you made ${s.okCalls} successful tool calls and produced ${s.deliverables} deliverable(s)`;
  if (s.repliesPosted) line += ` and posted ${s.repliesPosted} directive reply(ies)`;
  line += `; the team produced ${rollup.totals ? rollup.totals.deliverables : 0} deliverables in total.`;
  if ((rollup.alarms || []).includes(String(agentId).toLowerCase())) {
    line += ' You were flagged ZERO-ARTIFACT yesterday — today needs a deliverable, not activity.';
  }
  if ((rollup.silent || []).includes(String(agentId).toLowerCase())) {
    line += ' You were flagged SILENT yesterday — no receipts, no directives. Today must not repeat that.';
  }
  return line;
}

function buildSweepText(agent, day, rollupLine = '') {
  return [
    `[from: CEO → ${agent.name}] DAILY PROACTIVITY SWEEP — ${day}`,
    '',
    `Domain: ${agent.focus}.`,
    '',
    'Standing order (Proactivity Charter, Oct 22, 2026): waiting to be tasked is a failure mode. Today, before anything else:',
    '',
    '1. SWEEP your domain for opportunities: anything that makes Jesse money, saves him money or time, reduces his risk, or unblocks a stalled deliverable. Flag cross-domain finds to their owner.',
    '2. FILE at least one opportunity in Vikunja today — a real ticket titled "[Opportunity] ..." with the estimated value and the first concrete step. An opportunity that lives only in your head does not exist. If your sweep genuinely finds nothing, reply here with the exact searches/checks you ran and what they covered — "nothing found" without search evidence does not settle this directive.',
    '3. REPLY in this thread with the ticket ID(s) you created. Participation is measured in artifacts (ticket IDs, files, links), never in messages about work.',
    '',
    'Proof standard: nothing counts until it is verified against a live source. Self-reported activity without an artifact is not activity.',
    '',
    // The path below is load-bearing, not decoration: the intake scanner
    // dead-letters any directive that mentions artifact words + review
    // words without a URL or path (directiveScan artifact validation).
    // The first CRO sweep died that way on Oct 22, 2026. The roll-up is
    // also genuinely the first thing the agent should read: it is
    // yesterday's measured output for the whole team.
    'Start from yesterday\'s measured roll-up: slack-agents/.state/artifact-rollups/latest.md — if it is missing, say so in your reply.',
    ...(rollupLine ? ['', rollupLine] : []),
  ].join('\n');
}

// Pure: which agents are due a sweep for `day`, given the recorded state.
function planSweeps(state, day, agents = AGENTS) {
  return agents.filter((a) => !(state && state[a.id] && state[a.id].day === day));
}

// Pure: returns a NEW state object with the sweep recorded.
function recordSweep(state, agentId, day, ts) {
  return { ...(state || {}), [agentId]: { day, ts, postedAt: new Date().toISOString() } };
}

function stateFilePath() {
  const { stateDir } = require('./artifactLedger');
  return path.join(stateDir(), 'proactivity-sweeps.json');
}

function loadState(file = stateFilePath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(state, file = stateFilePath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function readBotToken(envPath = path.join(__dirname, '..', '.env')) {
  const text = fs.readFileSync(envPath, 'utf8');
  const m = text.match(/^SLACK_BOT_TOKEN=(\S+)\s*$/m);
  if (!m) throw new Error('SLACK_BOT_TOKEN not found in slack-agents/.env');
  return m[1];
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  let day = denverDay(new Date().toISOString());
  const dayIdx = argv.indexOf('--day');
  if (dayIdx >= 0 && argv[dayIdx + 1]) day = argv[dayIdx + 1];

  const state = loadState();
  const due = planSweeps(state, day);
  if (!due.length) {
    console.log(`[proactivitySweep] ${day}: all agents already swept, nothing to post`);
    return 0;
  }

  let client = null;
  if (!dryRun) {
    const { WebClient } = require('@slack/web-api');
    client = new WebClient(readBotToken());
  }

  // Yesterday's artifact roll-up, for the per-agent feedback line.
  let yesterdayRollup = null;
  try {
    const { stateDir } = require('./artifactLedger');
    const [y, m, dd] = day.split('-').map(Number);
    const prev = new Date(Date.UTC(y, m - 1, dd - 1)).toISOString().slice(0, 10);
    yesterdayRollup = JSON.parse(
      fs.readFileSync(path.join(stateDir(), 'artifact-rollups', `${prev}.json`), 'utf8'),
    );
  } catch { /* no roll-up yet — sweeps post without the feedback line */ }

  let failures = 0;
  let nextState = state;
  for (const agent of due) {
    const text = buildSweepText(agent, day, rollupLineFor(yesterdayRollup, agent.id));
    if (dryRun) {
      console.log(`--- DRY RUN ${agent.id} ---\n${text}\n`);
      continue;
    }
    try {
      const res = await client.chat.postMessage({ channel: MANAGEMENT_CHANNEL, text });
      nextState = recordSweep(nextState, agent.id, day, res.ts);
      console.log(`[proactivitySweep] ${agent.id}: posted ts=${res.ts}`);
    } catch (e) {
      failures += 1;
      console.error(`[proactivitySweep] ${agent.id}: POST FAILED: ${e.message}`);
    }
  }
  if (!dryRun) saveState(nextState);
  if (failures) {
    console.error(`[proactivitySweep] ${failures} of ${due.length} posts failed`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => { console.error(`[proactivitySweep] FATAL: ${e.message}`); process.exit(2); },
  );
}

module.exports = { AGENTS, MANAGEMENT_CHANNEL, buildSweepText, rollupLineFor, planSweeps, recordSweep, denverDay };
