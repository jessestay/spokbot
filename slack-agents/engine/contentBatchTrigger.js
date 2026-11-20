'use strict';
/*
 * contentBatchTrigger.js — team-side trigger for the weekly content batch
 * (Nov 2, 2026).
 *
 * WHY THIS EXISTS: the weekly content batch was produced by a CEO-side cron
 * on the VM that impersonated the CCO. Jesse's ruling: it only counts when
 * the MACF team itself produces the batch on its own machinery. This script
 * is that machinery for the trigger. It runs on macf-server under the
 * macf-content-batch.timer systemd unit (Mondays 14:21 UTC = 07:21
 * America/Denver during MST), in engine context (HOME=engine-home, like
 * macf-engine.service), and:
 *
 *   1. computes the coming Monday (America/Denver) as the batch week,
 *   2. checks .state/content-batch-trigger.json — if this week was already
 *      triggered, it logs and exits 0 WITHOUT posting (idempotent),
 *   3. posts ONE directive to #management (C0ASH4TF604) as the bot
 *      (SLACK_BOT_TOKEN; the engine's directive scanner accepts bot-posted
 *      directives — verified Nov 2, 2026: the bot-posted standup directive
 *      ts 1793635501.331259 is in _receivedDirectives),
 *   4. records { lastWeekOf, ts } in the state file only AFTER a successful
 *      post, prints the posted ts, and exits 0.
 *
 * The CCO agent then executes the directive through the normal intake /
 * Hatchet dispatch path. This script never writes content itself.
 *
 * Round 3 (#925, Nov 2, 2026): (A) the directive carries a MACF-CONTRACT
 * block whose postconditions (batch JSON exists, drafts >= 3) the finalize
 * gate verifies — prose can no longer finalize it; (B) the trigger
 * refreshes sandbox mirrors of the voice guide + quality gate from the
 * live tree on every run (the CCO's tools are sandbox-rooted; the live
 * docs do not resolve for it); (C) the directive makes the CCO write the
 * batch file incrementally, one draft per fileWrite call, because single
 * oversized fileWrite calls arrived with their arguments dropped.
 *
 * Round 4 (#925, Nov 2, 2026): (1) the contract declares
 * params.maxToolRounds = 16 — the round-3 runs starved on the 6-round
 * generateWithTools default (reading + research consumed it before any
 * fileWrite); agents/cco.js honors the declared budget. STEP 2 research
 * is also capped at 2 tavily searches in the text. (2) The finalize gate
 * now unescapes Slack's HTML entities before parsing the contract
 * (engine/directivePostconditions.js) — round 3 proved the escaped
 * markers made the merge inert. (3) MESSAGE LENGTH: round 3 attempt 2's
 * ~4404-char text was split by Slack at ~4013 chars and the contract
 * tail landed in a separate fragment the scanner discarded. The contract
 * block is now rendered as single-line JSON, the prose is tightened,
 * and a hard guard below refuses to post a composed directive over
 * MAX_DIRECTIVE_CHARS — failing loudly beats posting a directive whose
 * tail is silently lost.
 *
 * Round 5 (#925, Nov 2, 2026): round 4 proved the batch produces and
 * verifies, but it could not LAND — no agent tool could post to a Slack
 * channel, so the verified batch ended in the #management thread.
 * utils/agentTools now defines a local slackPost tool (bot token,
 * cco+ceo role gate, receipted), STEP 5 directs the CCO to present the
 * batch in #content (C0ASA532BGD) with it — lead post plus one threaded
 * post per draft, every draft carrying media (Canva URL, else a
 * credited free-stock page URL) — and the contract gains a third
 * postcondition, receipt_count(slackPost, ok) >= 1, so finalize can
 * only pass when a slackPost receipt proves the presentation happened.
 */
const fs = require('fs');
const path = require('path');
const { WebClient } = require('@slack/web-api');
const { normalizeContract } = require('./taskContract');

const instancePaths = require('../utils/instancePaths');
const ROOT = path.join(__dirname, '..');
const STATE_PATH = instancePaths.statePath('content-batch-trigger.json');
const CHANNEL = 'C0ASH4TF604'; // #management

// Slack splits long messages at ~4000 chars; round 3 lost the contract
// tail of a 4404-char directive to a fragment the scanner discarded.
// The composed directive must stay under this cap, with margin.
const MAX_DIRECTIVE_CHARS = 3900;

// ─── Reference-doc mirrors (fix B, #925 round 3) ─────────────────────────
// The CCO's fileRead/fileWrite are sandbox-rooted (utils/agentTools): the
// live reference docs live OUTSIDE the sandbox and do not resolve for it.
// Proof runs on Nov 2, 2026 showed absolute-path fileReads failing, and a
// prior attempt only got unstuck because an agent hand-seeded sandbox
// mirrors of the two docs — copies that would silently drift from the
// live tree. So the trigger refreshes the mirrors from the live tree on
// EVERY run, before posting, and the directive names the sandbox-relative
// paths that actually resolve. If a mirror copy fails, the trigger exits
// non-zero WITHOUT posting: a directive pointing at unreadable docs is a
// guaranteed failed run.
const MACF_ROOT = instancePaths.frameworkRoot();
const SANDBOX = instancePaths.instancePath('engine-home', 'workspace', 'agent-sandbox');
const MIRRORS = [
  { src: instancePaths.personasPath('team-skills', 'jesse-voice.md'), dst: path.join(SANDBOX, 'team-skills', 'jesse-voice.md') },
  { src: path.join(__dirname, 'content-quality-gate.md'), dst: path.join(SANDBOX, 'engine', 'content-quality-gate.md') },
  { src: path.join(__dirname, 'content-quality-gate.md'), dst: path.join(SANDBOX, 'slack-agents', 'engine', 'content-quality-gate.md') },
];

function refreshMirrors() {
  for (const { src, dst } of MIRRORS) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    console.log(`[contentBatchTrigger] mirrored ${path.relative(MACF_ROOT, src)} -> sandbox/${path.relative(SANDBOX, dst)}`);
  }
}

function loadEnv() {
  const env = {};
  const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

// The coming Monday in America/Denver as YYYY-MM-DD. If today IS Monday in
// Denver, today is the date (the timer fires Monday morning Denver time).
function comingMondayDenver() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const base = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
  const delta = (8 - base.getUTCDay()) % 7; // Mon->0, Tue->6, ..., Sun->1
  base.setUTCDate(base.getUTCDate() + delta);
  return base.toISOString().slice(0, 10);
}

// Single-line contract render (round 4): taskContract.renderContractBlock
// pretty-prints with 2-space indent (~550 chars for this contract); the
// single-line form is ~425 and keeps the whole directive under the Slack
// split threshold. parseContract's BLOCK_RE matches either form.
function renderCompactContractBlock(contract) {
  const c = normalizeContract(contract) || contract;
  return `<!-- MACF-CONTRACT ${JSON.stringify(c)} MACF-CONTRACT -->`;
}

// ─── Directive text (#925 rounds 3-4) ────────────────────────────────────
// A: the directive carries a MACF-CONTRACT block (taskContract). The
// directive finalize gate merges its postconditions into the derived set
// (engine/directivePostconditions), so completion requires the batch JSON
// to EXIST at the sandbox path with a drafts array of >= 3 — a prose
// report can no longer finalize this directive as completed. The contract
// also declares params.maxToolRounds = 16 (round 4): the 6-round default
// was consumed by reading + research before any write.
// C: the CCO writes the batch file INCREMENTALLY — one draft per fileWrite
// call, the calls batched into a single turn. The batch is never generated
// as one giant first call — oversized single calls arrived with their
// arguments dropped entirely (truncated payloads, Nov 2 proof runs).
// Scoring happens as each draft is written (gate_scores inside the draft
// object), and the file is written and read back BEFORE anything is
// posted to #content.
function buildDirectiveText(date) {
  const batchPath = `content/weekly-batch-${date}.json`;
  const prose = '[from: CEO → CCO] WEEKLY CONTENT BATCH — week of {date}. DRAFTS ONLY — never publish or schedule. STEP 1 — READ FIRST (one turn, both fileReads together): team-skills/jesse-voice.md (write in Jesse\'s voice) and engine/content-quality-gate.md (all six rules). Paths are sandbox-relative; absolute paths do not resolve for your tools. STEP 2 — RESEARCH (one turn, AT MOST 2 tavily searches): find fresh hooks from the last 7 days (AI/tech, Meta, marketing). STEP 3 — WRITE THE BATCH FILE INCREMENTALLY: the deliverable is {batchPath} (sandbox-relative; this exact path is what finalize verifies). Draft 3-5 short posts (LinkedIn/Facebook length, 100-250 words), mixed formats (hot take, story, how-to, contrarian); one may be a headline plus 3-bullet outline. Score every draft against all six gate rules AS YOU WRITE IT and record the scores in its "gate_scores" object (keys r1-r6) in the same fileWrite that adds it — rewrite any draft scoring below 4 on any rule before moving on. Writes: issue the sequence in ONE turn — the first fileWrite creates {batchPath} with {"week_of": "{date}", "drafts": [draft 1]}, each next call rewrites the same path with the next draft appended, one call per draft, full updated JSON each time, compact (no pretty-printing). You authored every draft: do NOT re-read the file between write calls. Never put the whole batch in a single first call — oversized calls get truncated and lose their arguments. If a fileWrite fails, re-issue just that call with the correct full JSON next turn. Spend rounds on nothing else: no re-reading, no listing, no unrelated tools. Draft object: {"label": "1", "platform": "LinkedIn", "hook": "...", "body": "...", "gate_scores": {"r1": 0, "r2": 0, "r3": 0, "r4": 0, "r5": 0, "r6": 0}}. STEP 4 — VERIFY BEFORE POSTING: after the final write, fileRead {batchPath} back and count drafts (at least 3, each with gate_scores). Only then post. STEP 5 — POST TO #content VIA slackPost (channel C0ASA532BGD): a lead post framing the batch as drafts for Jesse\'s approval (approve / edit / skip per draft), then one threaded post per draft (thread_ts = the lead post\'s returned ts) with the draft text, hook, and gate scores. Put each draft\'s source link next to the first mention that pulls from it. EVERY draft post carries media: if Canva responds, create one design per draft and pass its URL as mediaUrl; if not, find a fitting Pexels photo or video per draft via tavily and pass its page URL as mediaUrl, crediting the source in the post (Pixabay/Unsplash acceptable). If a media source fails, post the blocker in this thread (blocker rule) and still post that draft with the failure noted in its post. NEVER ship a draft silently media-less; never use paid generation as the fallback. Hard rules: NO em dashes and NO emoji in the copy. No invented facts, handles, follower counts, or quotes. No money claims. Never imply paying automation or ad clients exist — there are none. HOLD-001 is active: the St. George groups post stays held, do not touch it. Blocker rule: if any tool fails during this run, post the blocker in this directive thread immediately (what failed, what it blocks, what you shipped anyway). A silent failure is a defect. Report completion in this thread: draft count, one-line hook per draft, gate scores, anything skipped.';
  const contract = {
    taskId: null,
    executor: null,
    requiredTools: [{ tool: 'fileWrite', minSuccess: 1 }],
    postconditions: [
      { type: 'file_exists', path: batchPath, minBytes: 200 },
      { type: 'json_array_min', path: batchPath, field: 'drafts', min: 3 },
      { type: 'receipt_count', tool: 'slackPost', status: 'ok', min: 1 },
    ],
    deliverable: { schema: 'generic@v1' },
    params: { maxToolRounds: 16 },
    maxAttempts: 3,
  };
  return `${prose.split('{date}').join(date).split('{batchPath}').join(batchPath)}\n\n${renderCompactContractBlock(contract)}`;
}

async function main() {
  const date = comingMondayDenver();

  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch {}
  if (state && state.lastWeekOf === date) {
    console.log(`[contentBatchTrigger] week of ${date} already triggered (ts ${state.ts || 'unknown'}); exiting without posting`);
    return;
  }

  const env = loadEnv();
  if (!env.SLACK_BOT_TOKEN) {
    console.error('[contentBatchTrigger] SLACK_BOT_TOKEN missing from .env — cannot post directive');
    process.exit(1);
  }

  const text = buildDirectiveText(date);

  // Length guard (round 4): a directive over the cap will be split by
  // Slack and its tail silently lost (round 3 attempt 2). Fail loudly
  // BEFORE any side effect instead of posting a doomed directive.
  if (text.length > MAX_DIRECTIVE_CHARS) {
    console.error(`[contentBatchTrigger] composed directive is ${text.length} chars — over the ${MAX_DIRECTIVE_CHARS}-char limit (Slack splits at ~4000 and the tail is lost). NOT posting. Compact the directive text in buildDirectiveText.`);
    process.exit(1);
  }

  // Fix B (#925): refresh the sandbox reference-doc mirrors from the live
  // tree before posting. If this fails the directive would point the CCO
  // at unreadable docs — exit non-zero and post nothing.
  try {
    refreshMirrors();
  } catch (e) {
    console.error('[contentBatchTrigger] reference-doc mirror refresh FAILED — not posting:', e.message);
    process.exit(1);
  }

  const client = new WebClient(env.SLACK_BOT_TOKEN);
  const res = await client.chat.postMessage({ channel: CHANNEL, text });
  if (!res || !res.ok || !res.ts) {
    console.error('[contentBatchTrigger] postMessage did not return ok/ts:', JSON.stringify(res).slice(0, 300));
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    lastWeekOf: date,
    ts: res.ts,
    channel: CHANNEL,
    postedAt: new Date().toISOString(),
  }, null, 2));

  console.log(`[contentBatchTrigger] posted weekly content batch directive for week of ${date} to #management, ts=${res.ts}`);
  console.log(res.ts);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[contentBatchTrigger] FAILED:', e.message);
    process.exit(1);
  });
}

module.exports = { buildDirectiveText, MAX_DIRECTIVE_CHARS, comingMondayDenver };
