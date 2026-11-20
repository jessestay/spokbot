'use strict';
/*
 * jobHarvest.js — team-run Gmail job-alert harvester + feeder (Oct 29, 2026).
 *
 * WHY THIS EXISTS: the Oct 28 pipeline deployment proved the artifacts work
 * but the harvest behind them was a one-off CEO-side run. Jesse's ruling:
 * it only counts when the MACF team's own machinery produces the outcome.
 * This module is that machinery for ingestion (Vikunja #907). It runs on
 * macf-server under the macf-job-harvest.timer systemd unit, in engine
 * context (HOME=engine-home, like macf-engine.service), and:
 *
 *   1. connects to the google-workspace MCP server exactly as grants.json
 *      configures it (same spawn path the engine's agents use),
 *   2. searches Gmail for job-alert mail since the last run (sender-scoped,
 *      14-day lookback; per-message dedupe by Gmail id in the state file),
 *   3. extracts one record per REAL posting (LinkedIn alert cards are parsed
 *      deterministically from the plain-text body; formats that do not parse
 *      are logged as pending, never silently dropped and never fabricated),
 *   4. writes the run's records to .state/job-harvest/harvest-<ts>.json and
 *      feeds them through engine/alertFeeder.js into the sandbox inbox,
 *   5. records run state in .state/job-harvest.json for the outcome audit
 *      and the capability story.
 *
 * KNOWN WALL (diagnosed Oct 29, 2026): the stored workspace-mcp OAuth
 * credential carries drive/documents/spreadsheets/userinfo scopes only —
 * no Gmail scopes — and workspace-mcp refuses EVERY call with
 * "ACTION REQUIRED: Google Authentication Needed" until Jesse completes
 * one fresh OAuth consent (browser, signed in as jessestay@gmail.com,
 * redirect to the server-side localhost:8000 listener — the Oct 26
 * Canva/Buffer pattern). When that wall is hit this script exits 3 with
 * status BLOCKED_AUTH in the state file: loud, never a silent zero.
 *
 * It NEVER sends mail. Gmail access is read-only search + content fetch.
 */
const fs = require('fs');
const path = require('path');

const MACF_ROOT = path.join(__dirname, '..', '..');
const HANDS_DIR = path.join(MACF_ROOT, 'hands');
const STATE_DIR = path.join(__dirname, '..', '.state');
const STATE_FILE = path.join(STATE_DIR, 'job-harvest.json');
const HARVEST_DIR = path.join(STATE_DIR, 'job-harvest');
const CALL_TIMEOUT_MS = 45000;
const LOOKBACK_DAYS = 14;

const { feed } = require('./alertFeeder');
const { sandboxDir } = require('./jobPipeline');

const ALERT_QUERY = [
  'from:jobalerts-noreply@linkedin.com',
  'OR from:jobs-noreply@linkedin.com',
  'OR from:noreply@ziprecruiter.com',
  'OR from:ziprecruiter.com',
  'OR from:builtin.com',
  'OR from:indeed.com',
  'OR from:wellfound.com',
  'OR from:glassdoor.com',
].join(' ');

const SOURCE_LABELS = [
  [/linkedin\.com/i, 'LinkedIn Job Alerts'],
  [/ziprecruiter/i, 'ZipRecruiter'],
  [/builtin/i, 'Built In'],
  [/indeed/i, 'Indeed'],
  [/wellfound/i, 'Wellfound'],
  [/glassdoor/i, 'Glassdoor'],
];
function sourceLabel(from) {
  for (const [re, label] of SOURCE_LABELS) if (re.test(from || '')) return label;
  return 'Gmail Job Alert';
}

class BlockedAuth extends Error {}

/* ---------- LinkedIn alert-card extraction (deterministic) ----------
 * Plain-text LinkedIn job-alert bodies carry one card per posting:
 *     <Title>
 *     <Company>
 *     <Location>
 *     [optional badge lines / salary line]
 *     View job: https://www.linkedin.com/comm/jobs/view/<id>/?...
 * Cards are separated by dash lines. We anchor on each "View job:" URL and
 * read the trailing non-badge lines of the segment before it. */
const BADGE_LINE = /^(this company is actively hiring|apply with resume & profile|actively recruiting|easy apply|be an early applicant|new|promoted)$/i;
/* Social-proof lines LinkedIn interleaves into cards (e.g. "1 school alum",
 * "3 connections work here") — they sit between the location line and the
 * View job URL and must not be mistaken for card fields. */
const SOCIAL_PROOF_LINE = /^(\d+\s+(school alum|connections?|employees?|people)\b|.*\bschool alum\b.*)$/i;

/* Parse the salary band stated in an alert-card segment. Returns
 * { salaryMin, salaryMax, salaryBandText, salaryPeriod } or {}.
 * Fixes (Vikunja #1047, Nov 10, 2026):
 *  - shared-K inheritance: "$150-$240k" is 150000-240000, not 150-240000
 *    (the CyberCoders card parsed to salaryMin 150 for months);
 *  - a "/yr"-style period segment may sit between the first amount and
 *    the range separator ("$150,000/yr - $200,000/yr" used to lose the
 *    max to the single-amount fallback);
 *  - the matched text is carried verbatim (salaryBandText) so the queue
 *    entry can show the band exactly as the posting stated it. */
function parseSalary(segment) {
  const t = String(segment || '');
  const conv = (v, k, otherK) => {
    const n = parseFloat(String(v).replace(/,/g, ''));
    if (k) return Math.round(n * 1000);
    if (otherK && n < 1000) return Math.round(n * 1000); // shared K suffix
    return Math.round(n);
  };
  const m = t.match(/\$\s?([\d,]+(?:\.\d+)?)\s*([Kk])?(?:\s*\/\s?(?:yr|year|hr|hour))?\s*(?:-|–|—|to)\s*\$\s?([\d,]+(?:\.\d+)?)\s*([Kk])?(?:\s*\/\s?(?:yr|year|hr|hour))?/);
  if (m) {
    const period = /\/\s?(?:hr|hour)/i.test(m[0]) ? 'hr' : (/\/\s?(?:yr|year)/i.test(m[0]) ? 'yr' : null);
    return { salaryMin: conv(m[1], m[2], m[4]), salaryMax: conv(m[3], m[4], m[2]), salaryBandText: m[0].trim(), salaryPeriod: period };
  }
  const single = t.match(/\$\s?([\d,]+(?:\.\d+)?)\s*([Kk])?\s*(?:\/yr|\/year|a year)?/);
  if (single && /\$/.test(single[0])) {
    const n = parseFloat(single[1].replace(/,/g, ''));
    const v = Math.round(single[2] ? n * 1000 : n);
    if (v >= 30000) return { salaryMin: v, salaryMax: v, salaryBandText: single[0].trim(), salaryPeriod: /\/(?:yr|year)|a year/i.test(single[0]) ? 'yr' : null };
  }
  return {};
}

function extractLinkedInCards(text) {
  if (!text) return [];
  const norm = String(text).replace(/\r\n/g, '\n');
  const cards = [];
  const re = /View job:\s*(https:\/\/www\.linkedin\.com\/comm\/jobs\/view\/(\d+)\/[^\s]*)/g;
  let match; let prevEnd = 0;
  while ((match = re.exec(norm)) !== null) {
    const segment = norm.slice(prevEnd, match.index);
    prevEnd = re.lastIndex;
    const jobId = match[2];
    const lines = segment.split('\n').map(l => l.trim()).filter(Boolean)
      .filter(l => !BADGE_LINE.test(l))
      .filter(l => !SOCIAL_PROOF_LINE.test(l))
      .filter(l => !/^-{5,}$/.test(l))
      .filter(l => !/^\$\s?[\d,.]+\s*[Kk]?(\s*(?:-|–|—|to)\s*\$\s?[\d,.]+\s*[Kk]?)?(\s*\/\s*(yr|year|hr|hour))?$/.test(l));
    if (lines.length < 2) continue;
    const [title, company, location] = [lines[lines.length - 3], lines[lines.length - 2], lines[lines.length - 1]]
      .map(v => v || null);
    // With only 2 lines there is no location line; with 3+, the last is location.
    const sal = parseSalary(segment);
    const rec = {
      company: lines.length >= 3 ? company : lines[lines.length - 1],
      title: lines.length >= 3 ? title : lines[lines.length - 2],
      url: `https://www.linkedin.com/jobs/view/${jobId}/`,
      location: lines.length >= 3 ? location : null,
      ...(sal.salaryMin != null ? {
        salaryMin: sal.salaryMin,
        salaryMax: sal.salaryMax,
        // The band verbatim as the alert card stated it (#1047): the
        // queue entry carries this so no downstream step has to trust
        // a bare pair of numbers.
        salaryBand: {
          text: sal.salaryBandText || null, low: sal.salaryMin, high: sal.salaryMax,
          currency: 'USD', period: sal.salaryPeriod || null, source: 'linkedin-alert-card',
        },
      } : {}),
    };
    if (rec.location && /remote/i.test(rec.location)) rec.remote = true;
    rec.description = `LinkedIn job alert card: ${rec.title} at ${rec.company}, ${rec.location || 'location not stated'}. Full posting text not included in the alert email - fetch the posting before applying.`;
    cards.push(rec);
  }
  return cards;
}

/* Extract the human text out of an MCP tool result (defensive: the result
 * content is text blocks; workspace-mcp returns the message body as text). */
function resultText(result) {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
}

function gmailIdsFromSearch(text) {
  const ids = new Set();
  for (const m of String(text || '').matchAll(/\b[0-9a-f]{16,18}\b/g)) ids.add(m[0]);
  return [...ids];
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { harvestedIds: [], pendingUnparsed: [], totals: { runs: 0, messagesSeen: 0, recordsExtracted: 0, appended: 0, skippedDupes: 0 } }; }
}
function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

async function connectGoogleWorkspace() {
  const grants = JSON.parse(fs.readFileSync(path.join(HANDS_DIR, 'grants.json'), 'utf8'));
  const spec = grants.servers['google-workspace'];
  if (!spec) throw new Error('grants.json has no google-workspace server');
  const sdkBase = path.join(HANDS_DIR, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');
  const { Client } = require(path.join(sdkBase, 'client', 'index.js'));
  const { StdioClientTransport } = require(path.join(sdkBase, 'client', 'stdio.js'));
  const transport = new StdioClientTransport({
    command: spec.command, args: spec.args || [],
    cwd: spec.cwd ? path.resolve(MACF_ROOT, spec.cwd) : HANDS_DIR,
    env: { ...process.env, ...(spec.env || {}) }, stderr: 'ignore',
  });
  const client = new Client({ name: 'job-harvest', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, email: (spec.env && spec.env.USER_GOOGLE_EMAIL) || 'jessestay@gmail.com' };
}

async function call(client, name, args) {
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${CALL_TIMEOUT_MS}ms calling ${name}`)), CALL_TIMEOUT_MS));
  const res = await Promise.race([client.callTool({ name, arguments: args }), timeout]);
  const text = resultText(res);
  if (/ACTION REQUIRED: Google Authentication Needed/.test(text)) {
    throw new BlockedAuth(`google-workspace demands a fresh OAuth consent before ${name} can run (stored credential has no Gmail scopes)`);
  }
  if (res && res.isError) throw new Error(`${name} returned an error: ${text.slice(0, 300)}`);
  return text;
}

async function run({ dryRun = false } = {}) {
  const state = loadState();
  const startedAt = new Date().toISOString();
  const harvested = new Set(state.harvestedIds || []);
  const summary = { startedAt, dryRun, searched: 0, newMessages: 0, records: 0, appended: 0, skippedDupes: 0, unparsed: 0 };
  const { client, email } = await connectGoogleWorkspace();
  try {
    const query = `(${ALERT_QUERY}) newer_than:${LOOKBACK_DAYS}d`;
    let pageToken = null; const messageIds = [];
    for (let page = 0; page < 4; page++) {
      const args = { query, user_google_email: email, page_size: 50, include_headers: true };
      if (pageToken) args.page_token = pageToken;
      const text = await call(client, 'search_gmail_messages', args);
      const ids = gmailIdsFromSearch(text);
      if (!ids.length) break;
      messageIds.push(...ids);
      const nt = text.match(/next[_ ]page[_ ]token["':\s]+([A-Za-z0-9_\-=]+)/i);
      pageToken = nt ? nt[1] : null;
      if (!pageToken) break;
    }
    summary.searched = messageIds.length;
    const fresh = [...new Set(messageIds)].filter(id => !harvested.has(id));
    summary.newMessages = fresh.length;

    const records = []; const unparsedIds = [];
    for (const id of fresh) {
      const text = await call(client, 'get_gmail_message_content', { message_id: id, user_google_email: email, format: 'full', body_format: 'text' });
      const fromMatch = text.match(/From:\s*(.+)/i);
      const label = sourceLabel(fromMatch ? fromMatch[1] : '');
      const cards = /linkedin\.com/i.test(text) ? extractLinkedInCards(text) : [];
      if (cards.length) {
        for (const c of cards) records.push({ sourceEmailId: id, source: label, ...c });
        harvested.add(id);
      } else {
        // Not parseable deterministically (e.g. Built In / ZipRecruiter
        // layouts). Keep it pending for a later parser or a Job Coach
        // judgment pass; never fabricate a record from it.
        unparsedIds.push(id);
      }
    }
    summary.records = records.length;
    summary.unparsed = unparsedIds.length;

    if (records.length) {
      fs.mkdirSync(HARVEST_DIR, { recursive: true });
      const stamp = startedAt.replace(/[:.]/g, '-');
      const harvestFile = path.join(HARVEST_DIR, `harvest-${stamp}.json`);
      if (!dryRun) fs.writeFileSync(harvestFile, JSON.stringify(records, null, 2) + '\n');
      const sandbox = sandboxDir();
      const r = feed({
        harvestFile: dryRun ? (() => { const f = harvestFile + '.dry'; fs.mkdirSync(HARVEST_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(records)); return f; })() : harvestFile,
        inboxFile: path.join(sandbox, 'jobs', 'alerts-inbox.jsonl'),
        candidatesDir: path.join(sandbox, 'jobs', 'candidates'),
        dryRun,
      });
      summary.appended = r.appended.length;
      summary.skippedDupes = r.skipped.length;
      summary.invalid = r.invalid.length;
    }

    state.lastRunAt = startedAt;
    state.lastSuccessAt = new Date().toISOString();
    state.status = 'OK';
    state.lastError = null;
    state.harvestedIds = [...harvested].slice(-5000);
    const _puAll = [...new Set([...(state.pendingUnparsed || []), ...unparsedIds])];
    const _puKeep = _puAll.filter(id => messageIds.includes(id) || fresh.includes(id));
    const _puLost = _puAll.filter(id => !_puKeep.includes(id));
    if (!Array.isArray(state.lostUnparsed)) state.lostUnparsed = [];
    if (_puLost.length) state.lostUnparsed = [...state.lostUnparsed, ..._puLost.map(id => ({ id, lostAt: new Date().toISOString() }))].slice(-500);
    state.pendingUnparsed = _puKeep;
    state.totals = state.totals || { runs: 0, messagesSeen: 0, recordsExtracted: 0, appended: 0, skippedDupes: 0 };
    state.totals.runs += 1;
    state.totals.messagesSeen += summary.newMessages;
    state.totals.recordsExtracted += summary.records;
    state.totals.appended += summary.appended;
    state.totals.skippedDupes += summary.skippedDupes;
    if (!dryRun) saveState(state);
    console.log(JSON.stringify({ jobHarvest: summary }, null, 2));
    return summary;
  } finally {
    try { await client.close(); } catch { /* already closed */ }
  }
}

if (require.main === module) {
  run({ dryRun: process.argv.includes('--dry-run') }).catch(e => {
    const state = loadState();
    state.lastRunAt = new Date().toISOString();
    if (e instanceof BlockedAuth) {
      state.status = 'BLOCKED_AUTH';
      state.lastError = e.message;
      saveState(state);
      console.error(`jobHarvest BLOCKED_AUTH: ${e.message}`);
      console.error('Unblock: Jesse completes ONE workspace-mcp OAuth consent (gmail scopes included) in his browser; callback delivered to the server-side localhost:8000 listener. See Vikunja #907.');
      process.exit(3);
    }
    state.status = 'ERROR';
    state.lastError = String(e.message || e).slice(0, 500);
    saveState(state);
    console.error(`jobHarvest ERROR: ${state.lastError}`);
    process.exit(2);
  });
}

module.exports = { extractLinkedInCards, parseSalary, sourceLabel, gmailIdsFromSearch, ALERT_QUERY };
