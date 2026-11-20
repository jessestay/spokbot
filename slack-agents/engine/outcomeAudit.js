/**
 * Outcome Audit (Oct 26, 2026 — Jesse's order: "code kept shipping while
 * resumes submitted = 0, social posts = 0, SEO/AIO output = 0, and nothing
 * failed loudly").
 *
 * The capability baseline (Oct 24) proved tool DISCOVERY. The artifact
 * roll-up counts activity and deliverable-shaped artifacts. Neither proves
 * an OUTCOME a customer or an audience ever saw. This audit counts only
 * verified outcomes, from primary sources, per day and rolling 7 days:
 *
 *   applications  — Job Coach. Entries in the agent sandbox
 *                   jobs/applications.jsonl (the #910 application ledger)
 *                   that carry a portal confirmation reference. Unconfirmed
 *                   entries NEVER count: an application exists only when
 *                   the portal said so.
 *   socialPosts   — CCO. Entries in the sandbox content/published-posts.jsonl
 *                   carrying a live http(s) post URL. NOTE: before this
 *                   audit, NO published-URL record existed anywhere in the
 *                   system — the weekly content batch is draft-only by
 *                   Jesse's rule (post_drafts.py posts drafts to Slack
 *                   #content and never publishes), and the receipts ledger
 *                   contains only urlCheck artifacts (URLs agents READ, not
 *                   posts they published). This ledger is the recording
 *                   point from Oct 26, 2026 forward; the count before it
 *                   existed is honestly 0 recorded, not "unknown".
 *   seoChanges    — CTO (interim owner of story #899 until the SEO Expert
 *                   exists). Vikunja tasks in projects 2/16 whose title or
 *                   labels match SEO/AIO, where a comment contains a URL on
 *                   staynalive.com or jessestay.com AND change language
 *                   (changed/updated/published/deployed/edited/live/…).
 *                   A planning comment that merely mentions a property URL
 *                   is NOT a change and never counts (verified against the
 *                   Oct 22, 2026 scope comment on #846, which must not
 *                   count). If the Vikunja API cannot be read, the metric is
 *                   reported UNMEASURED with the error — never fake-zero.
 *   deliveries    — CMO. Entries in the sandbox company/deliveries.jsonl
 *                   carrying a send reference (ref / messageId / sentRef).
 *                   Drafts never count. Gmail sent records are out of scope
 *                   for the engine; this sandbox ledger is the record.
 *   outreach      — CRO (F6, added Nov 11, 2026; Vikunja #970/#1052).
 *                   Entries in the sandbox outreach/outreach-events.jsonl.
 *                   A send counts ONLY when delivered (status sent or
 *                   sent_duplicate; records predating status carry a send
 *                   reference and count) AND carrying a send reference
 *                   (message/thread id). Blocked and failed attempts are
 *                   recorded but never count. Replies and one-pagers are
 *                   reported as all-time totals on the metric. The ledger
 *                   was seeded Nov 11, 2026 from the F6 primary source —
 *                   the reply-watch worker state.json
 *                   (~/workspace/revenue-oct5/play2-audits/automation/
 *                   state.json on the CEO workstation) — which no audit
 *                   had ever read before (#1052). New sends record in this
 *                   ledger at send time.
 *   concierge     — DM Concierge (F7, added Nov 11, 2026; Vikunja #1053).
 *                   NOT an event ledger: the concierge outcome is triage
 *                   state (messages watched, genuine ones awaiting Jesse's
 *                   reply/approval; nothing may send without his go-ahead),
 *                   so the metric is a SNAPSHOT read from the sandbox
 *                   concierge/triage-snapshot.json, itself synced from the
 *                   primary source — the concierge watch state
 *                   (linkedin-seen.json) on the CEO workstation. A snapshot
 *                   older than 48h is flagged STALE in the report; a
 *                   missing or unreadable snapshot is UNMEASURED, never a
 *                   fake zero. Before this wiring, F7's reported zero
 *                   rested on no source at all (#1053).
 *
 * ALARM RULE: if any of {applications, socialPosts, seoChanges} has a
 * zero streak of 3+ consecutive days ending on the audit day, an OUTCOME
 * ALARM section naming the metric and its owning agent is appended to the
 * artifact roll-up's latest.md (and its sandbox mirror) and recorded in
 * .state/outcome-audit.json. Zero can no longer hide under green.
 *
 * CLI: node engine/outcomeAudit.js [--day YYYY-MM-DD]
 * Default day = yesterday (America/Denver), matching the artifact roll-up.
 * Reader failures on local ledgers are treated as empty ledgers only when
 * the file is absent (absent = the honest fact "nothing recorded"); a torn
 * line is skipped, never counted.
 */

const fs = require('fs');
const path = require('path');

const LOOKBACK_DAYS = 31;
const ALARM_THRESHOLD_DAYS = 3;
const ALARM_METRICS = ['applications', 'socialPosts', 'seoChanges'];

const METRICS = {
  applications: {
    label: 'Job applications confirmed submitted',
    owner: 'jobcoach',
    ownerLabel: 'Job Coach',
  },
  socialPosts: {
    label: 'Social posts published (live URLs)',
    owner: 'cco',
    ownerLabel: 'CCO',
  },
  seoChanges: {
    label: 'SEO/AIO page changes',
    owner: 'cto',
    ownerLabel: 'CTO (interim, story #899)',
  },
  deliveries: {
    label: 'Client deliverables sent',
    owner: 'cmo',
    ownerLabel: 'CMO',
  },
  outreach: {
    label: 'AI audit outreach sends (delivered)',
    owner: 'cro',
    ownerLabel: 'CRO',
  },
  concierge: {
    label: 'DM concierge triage (snapshot)',
    owner: 'ceo',
    ownerLabel: 'DM Concierge (CEO-run watch)',
  },
};

const SITE_URL_RE = /https?:\/\/(?:www\.)?(?:staynalive\.com|jessestay\.com)\S*/i;
const CHANGE_LANGUAGE_RE = /\b(changed|updated|published|deployed|edited|modified|applied|fixed|went live|now live|is live|rolled out)\b/i;
const SEO_KEYWORD_RE = /\bseo\b|\baio\b/i;

// --- date helpers (same Denver convention as artifactLedger.js) ---

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

// Shift a YYYY-MM-DD day string by n days (UTC arithmetic on the string;
// day strings are timezone-free once computed).
function shiftDay(day, n) {
  const [y, m, dd] = day.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, dd + n));
  return d.toISOString().slice(0, 10);
}

// --- pure counting ---

function parseJsonl(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object') out.push(v);
    } catch { /* torn line: skipped, never counted */ }
  }
  return out;
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function entryDay(entry, fields) {
  for (const f of fields) {
    if (entry[f]) {
      const day = denverDay(entry[f]);
      if (day) return day;
    }
  }
  return null;
}

// An application counts ONLY with a portal confirmation reference.
function applicationEvents(entries) {
  const events = [];
  for (const e of entries) {
    const ref = e.confirmationRef || e.portalConfirmation || e.confirmation;
    if (!nonEmptyString(ref)) continue;
    const day = entryDay(e, ['ts', 'submittedAt', 'date', 'created']);
    if (!day) continue;
    events.push({ day, ref, label: e.company || e.role || e.title || 'application' });
  }
  return events;
}

// A social post counts ONLY with a live http(s) URL recorded for it.
function publishedPostEvents(entries) {
  const events = [];
  for (const e of entries) {
    if (!nonEmptyString(e.url) || !/^https?:\/\//i.test(e.url.trim())) continue;
    const day = entryDay(e, ['ts', 'publishedAt', 'date', 'created']);
    if (!day) continue;
    events.push({ day, ref: e.url.trim(), label: e.platform || 'post' });
  }
  return events;
}

// A client deliverable counts ONLY with a send reference. Drafts never count.
function deliveryEvents(entries) {
  const events = [];
  for (const e of entries) {
    const ref = e.ref || e.messageId || e.sentRef;
    if (!nonEmptyString(ref)) continue;
    const day = entryDay(e, ['ts', 'sentAt', 'date', 'created']);
    if (!day) continue;
    events.push({ day, ref, label: e.client || e.name || 'deliverable' });
  }
  return events;
}

// An outreach send counts ONLY when it was delivered AND carries a send
// reference. Delivered = status 'sent' or 'sent_duplicate', or a legacy
// record with no status but a reference (touch-1 predates status fields;
// its message ids are the delivery receipts). Blocked/failed never count.
const OUTREACH_DELIVERED_STATUSES = new Set(['sent', 'sent_duplicate']);
function outreachEvents(entries) {
  const events = [];
  for (const e of entries) {
    if (e.kind !== 'send') continue;
    if (!nonEmptyString(e.ref)) continue;
    if (e.status && !OUTREACH_DELIVERED_STATUSES.has(e.status)) continue;
    const day = entryDay(e, ['ts', 'sentAt', 'date', 'created']);
    if (!day) continue;
    events.push({ day, ref: e.ref, label: e.label || e.to || 'outreach send' });
  }
  return events;
}

// F7 concierge is a state snapshot, not an event stream. Pure builder so
// the pass-through and the staleness rule are unit-testable without fs.
// A snapshot whose age cannot be determined counts as stale.
function conciergeMetric(snap, nowMs) {
  const genMs = Date.parse((snap && snap.generatedAt) || '') || 0;
  const ageH = genMs ? (nowMs - genMs) / 3600000 : null;
  return {
    snapshot: true,
    today: null, last7: null, daysSinceNonzero: null, zeroStreak: null, daily: {}, events: [],
    trackedConversations: snap && snap.trackedConversations != null ? snap.trackedConversations : null,
    awaitingReply: snap && snap.awaitingReply != null ? snap.awaitingReply : null,
    // No fallback: if the source does not record drafts separately, the
    // value stays null rather than borrowing awaitingReply's number.
    draftsPending: snap && snap.draftsPending != null ? snap.draftsPending : null,
    lastPollAt: (snap && snap.lastPollAt) || null,
    snapshotGeneratedAt: (snap && snap.generatedAt) || null,
    snapshotAgeHours: ageH == null ? null : Math.round(ageH * 10) / 10,
    stale: ageH == null || ageH > 48,
  };
}

function isSeoTask(task) {
  if (!task) return false;
  if (SEO_KEYWORD_RE.test(task.title || '')) return true;
  const labels = Array.isArray(task.labels) ? task.labels : [];
  return labels.some(l => SEO_KEYWORD_RE.test((l && l.title) || ''));
}

// One comment = at most one SEO change event. Requires BOTH a changed-page
// URL on one of Jesse's properties AND language stating a change happened.
function seoEvents(tasks) {
  const events = [];
  const seenComments = new Set();
  for (const task of tasks || []) {
    if (!isSeoTask(task)) continue;
    for (const c of task.comments || []) {
      if (!c || c.id == null || seenComments.has(c.id)) continue;
      const text = c.comment || '';
      const m = text.match(SITE_URL_RE);
      if (!m) continue;
      if (!CHANGE_LANGUAGE_RE.test(text)) continue;
      seenComments.add(c.id);
      const day = denverDay(c.created);
      if (!day) continue;
      events.push({ day, ref: m[0], label: `task #${task.id}` });
    }
  }
  return events;
}

// Summarize events into today / rolling-7d / zero-streak ending on `day`.
function summarize(events, day, lookbackDays = LOOKBACK_DAYS) {
  const daily = {};
  for (let i = 0; i < lookbackDays; i++) daily[shiftDay(day, -i)] = 0;
  for (const e of events) {
    if (e.day in daily) daily[e.day] += 1;
  }
  const today = daily[day] || 0;
  let last7 = 0;
  for (let i = 0; i < 7; i++) last7 += daily[shiftDay(day, -i)] || 0;
  let zeroStreak = 0;
  let daysSinceNonzero = null;
  for (let i = 0; i < lookbackDays; i++) {
    const d = shiftDay(day, -i);
    if ((daily[d] || 0) > 0) { daysSinceNonzero = i; break; }
    zeroStreak += 1;
  }
  return { today, last7, daysSinceNonzero, zeroStreak, daily };
}

function buildAlarms(metrics) {
  const alarms = [];
  for (const key of ALARM_METRICS) {
    const m = metrics[key];
    if (!m || m.unmeasured) continue;
    if (m.zeroStreak >= ALARM_THRESHOLD_DAYS) {
      alarms.push({
        metric: key,
        label: METRICS[key].label,
        owner: METRICS[key].owner,
        ownerLabel: METRICS[key].ownerLabel,
        zeroStreak: m.zeroStreak,
        daysSinceNonzero: m.daysSinceNonzero,
      });
    }
  }
  return alarms;
}

function renderAlarmSection(audit) {
  const lines = [];
  lines.push(`<!-- outcome-audit:${audit.day} -->`);
  lines.push('');
  lines.push(`## 🚨 OUTCOME ALARM — ${audit.day}`);
  lines.push('');
  lines.push('Verified outcomes have been ZERO for 3+ consecutive days. Activity is not delivery:');
  for (const a of audit.alarms) {
    const since = a.daysSinceNonzero == null
      ? `no nonzero day in the last ${LOOKBACK_DAYS} days on record`
      : `last nonzero ${a.daysSinceNonzero} day(s) ago`;
    lines.push(`- **${a.label}**: ZERO for ${a.zeroStreak} consecutive day(s) (${since}). Owning agent: **${a.ownerLabel}**.`);
  }
  lines.push('');
  lines.push('Full outcome audit: slack-agents/.state/outcome-audit.json');
  lines.push('');
  return lines.join('\n');
}

function renderReport(audit) {
  const lines = [];
  lines.push(`# Outcome audit — ${audit.day} (America/Denver)`);
  lines.push('');
  lines.push('Verified outcomes only, from primary sources. An application counts only with a portal confirmation; a post counts only with a live URL; an SEO change counts only with a changed-page URL plus change language on the ticket; a deliverable counts only with a send reference.');
  lines.push('');
  lines.push('| outcome | today | last 7 days | days since last nonzero |');
  lines.push('|---|---|---|---|');
  for (const key of Object.keys(METRICS)) {
    const m = audit.metrics[key];
    if (m.unmeasured) {
      lines.push(`| ${METRICS[key].label} (${METRICS[key].ownerLabel}) | UNMEASURED | UNMEASURED | source error |`);
    } else if (m.snapshot) {
      lines.push(`| ${METRICS[key].label} (${METRICS[key].ownerLabel}) | SNAPSHOT: ${m.awaitingReply} awaiting Jesse reply/approval · ${m.trackedConversations} conversations tracked | — | last poll ${m.lastPollAt || 'unknown'}${m.stale ? ' (STALE snapshot)' : ''} |`);
    } else {
      const since = m.daysSinceNonzero == null ? `none in ${LOOKBACK_DAYS}d` : String(m.daysSinceNonzero);
      lines.push(`| ${METRICS[key].label} (${METRICS[key].ownerLabel}) | ${m.today} | ${m.last7} | ${since} |`);
    }
  }
  lines.push('');
  if (audit.alarms.length) {
    lines.push(renderAlarmSection(audit));
  } else {
    lines.push('No outcome alarms: no tracked outcome has been zero for 3+ consecutive days.');
    lines.push('');
  }
  lines.push('## Sources');
  for (const key of Object.keys(METRICS)) {
    lines.push(`- ${METRICS[key].label}: ${audit.metrics[key].sourceNote}`);
  }
  lines.push('');
  return lines.join('\n');
}

// --- live-source loaders ---

function sandboxDir() {
  if (process.env.MACF_SANDBOX_DIR) return process.env.MACF_SANDBOX_DIR;
  return path.join(__dirname, '..', '..', 'engine-home', 'workspace', 'agent-sandbox');
}

function stateDir() {
  if (process.env.MACF_STATE_DIR) return process.env.MACF_STATE_DIR;
  return path.join(__dirname, '..', '.state');
}

// Read a JSONL ledger; create it empty first if absent (the ledger IS the
// recording point — its absence means "nothing recorded", and creating it
// gives the owning agent the file to write to).
function loadLedger(file) {
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
      return { entries: [], created: true };
    }
    return { entries: parseJsonl(fs.readFileSync(file, 'utf8')), created: false };
  } catch (e) {
    return { entries: [], created: false, error: e.message };
  }
}

// Read a JSON snapshot file. Absence is reported as missing (never as a
// zero-valued snapshot); a parse failure is an error, surfaced upstream
// as UNMEASURED.
function loadJsonFile(file) {
  try {
    if (!fs.existsSync(file)) return { data: null, missing: true };
    return { data: JSON.parse(fs.readFileSync(file, 'utf8')), missing: false };
  } catch (e) {
    return { data: null, missing: false, error: e.message };
  }
}

function readEnvToken(name, envPath = path.join(__dirname, '..', '.env')) {
  const text = fs.readFileSync(envPath, 'utf8');
  const m = text.match(new RegExp(`^${name}=(\\S+)\\s*$`, 'm'));
  if (!m) throw new Error(`${name} not found in slack-agents/.env`);
  return m[1];
}

async function fetchSeoTasksWithComments(token, base = 'http://127.0.0.1:3456/api/v1') {
  const tasks = [];
  for (const pid of [2, 16]) {
    for (let page = 1; page <= 40; page++) {
      const r = await fetch(`${base}/projects/${pid}/tasks?per_page=50&page=${page}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`vikunja list project ${pid} -> ${r.status}`);
      const items = await r.json().catch(() => []);
      if (!Array.isArray(items) || !items.length) break;
      tasks.push(...items);
      if (items.length < 50) break; // server caps per_page at 50
    }
  }
  const seo = tasks.filter(isSeoTask);
  for (const t of seo) {
    const r = await fetch(`${base}/tasks/${t.id}/comments`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    t.comments = r.ok ? await r.json().catch(() => []) : [];
    if (!Array.isArray(t.comments)) t.comments = [];
  }
  return seo;
}

// Append the alarm section to the roll-up latest.md (idempotent per day).
function appendAlarmToRollup(audit, rollupFile) {
  if (!audit.alarms.length) return false;
  let current = '';
  try { current = fs.readFileSync(rollupFile, 'utf8'); } catch { return false; }
  if (current.includes(`<!-- outcome-audit:${audit.day} -->`)) return false;
  fs.writeFileSync(rollupFile, current.replace(/\s*$/, '') + '\n\n' + renderAlarmSection(audit));
  return true;
}

async function runAudit({ day, sandbox = sandboxDir(), state = stateDir(), fetchSeo = null } = {}) {
  const auditDay = day || yesterdayDenver();
  const metrics = {};

  const appsFile = path.join(sandbox, 'jobs', 'applications.jsonl');
  const apps = loadLedger(appsFile);
  const appEvents = applicationEvents(apps.entries);
  // Seat split (#935 G3 / #980): the ledger's executor field separates
  // team-seat submissions from CEO-operator ones, which is what makes
  // F1's team-executed test provable. Confirmed entries only; entries
  // recorded before the field existed count as 'unspecified'.
  const executorSplit = {};
  for (const e of apps.entries) {
    const ref = e.confirmationRef || e.portalConfirmation || e.confirmation;
    if (!nonEmptyString(ref)) continue;
    const seat = e.executor ? String(e.executor) : 'unspecified';
    executorSplit[seat] = (executorSplit[seat] || 0) + 1;
  }
  const splitText = Object.entries(executorSplit).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none';
  metrics.applications = {
    ...summarize(appEvents, auditDay),
    executorSplit,
    events: appEvents.filter(e => e.day >= shiftDay(auditDay, -6)),
    sourceNote: `sandbox jobs/applications.jsonl (${apps.entries.length} entries, ${appEvents.length} with a portal confirmation reference)${apps.created ? ' — ledger file created empty by this audit; nothing had ever been recorded' : ''} Seat split by executor: ${splitText}.`,
  };

  const postsFile = path.join(sandbox, 'content', 'published-posts.jsonl');
  const posts = loadLedger(postsFile);
  const postEvents = publishedPostEvents(posts.entries);
  metrics.socialPosts = {
    ...summarize(postEvents, auditDay),
    events: postEvents.filter(e => e.day >= shiftDay(auditDay, -6)),
    sourceNote: `sandbox content/published-posts.jsonl (${posts.entries.length} entries with a live URL: ${postEvents.length}). No published-URL record existed anywhere before Oct 26, 2026: the weekly content batch is draft-only (post_drafts.py never publishes) and the receipts ledger holds only urlCheck read artifacts${posts.created ? ' — ledger file created empty by this audit' : ''}`,
  };

  const deliveriesFile = path.join(sandbox, 'company', 'deliveries.jsonl');
  const deliveries = loadLedger(deliveriesFile);
  const deliveryEvts = deliveryEvents(deliveries.entries);
  metrics.deliveries = {
    ...summarize(deliveryEvts, auditDay),
    events: deliveryEvts.filter(e => e.day >= shiftDay(auditDay, -6)),
    sourceNote: `sandbox company/deliveries.jsonl (${deliveries.entries.length} entries, ${deliveryEvts.length} with a send reference). Sandbox holds drafts only today (e.g. email-draft-to-graham-schwab.md is a draft, not a send); Gmail sent records are out of scope for the engine${deliveries.created ? ' — ledger file created empty by this audit' : ''}`,
  };

  const outreachFile = path.join(sandbox, 'outreach', 'outreach-events.jsonl');
  const outreachLedger = loadLedger(outreachFile);
  const outreachEvts = outreachEvents(outreachLedger.entries);
  const outreachReplies = outreachLedger.entries.filter(e => e.kind === 'reply');
  const outreachOnePagers = outreachLedger.entries.filter(e => e.kind === 'onepager');
  const outreachBlocked = outreachLedger.entries.filter(e => e.kind === 'send' && e.status === 'blocked');
  const outreachFailed = outreachLedger.entries.filter(e => e.kind === 'send' && e.status === 'failed');
  const lastSendDay = outreachEvts.length ? outreachEvts.map(e => e.day).sort().slice(-1)[0] : null;
  // One batch-2 record in the source carries a message id (proof of send)
  // but no timestamp. It counts in the all-time delivered total, never in
  // any day bucket — stated, not silently dropped or backdated.
  const outreachUndated = outreachLedger.entries.filter(e => e.kind === 'send'
    && nonEmptyString(e.ref)
    && (!e.status || OUTREACH_DELIVERED_STATUSES.has(e.status))
    && !entryDay(e, ['ts', 'sentAt', 'date', 'created'])).length;
  metrics.outreach = {
    ...summarize(outreachEvts, auditDay),
    events: outreachEvts.filter(e => e.day >= shiftDay(auditDay, -6)),
    deliveredTotal: outreachEvts.length + outreachUndated,
    deliveredDated: outreachEvts.length,
    deliveredUndated: outreachUndated,
    repliesTotal: outreachReplies.length,
    onePagersTotal: outreachOnePagers.length,
    blockedTotal: outreachBlocked.length,
    failedTotal: outreachFailed.length,
    lastSendDay,
    sourceNote: `sandbox outreach/outreach-events.jsonl (${outreachLedger.entries.length} entries; seeded 2026-11-11 from the F6 primary source, the reply-watch worker state.json at ~/workspace/revenue-oct5/play2-audits/automation/state.json on the CEO workstation — Vikunja #1052). Delivered sends ${outreachEvts.length + outreachUndated} all-time (touch-1 2026-09-28 + batch-2 2026-09-30; ${outreachUndated} of them carries a message id but no timestamp in the source, so it is in the all-time total only, never in a day bucket), blocked ${outreachBlocked.length}, failed ${outreachFailed.length}; replies seen ${outreachReplies.length}; one-pagers sent ${outreachOnePagers.length}; last send day ${lastSendDay || 'none recorded'}. New sends record in this ledger at send time${outreachLedger.created ? ' — ledger file created empty by this audit' : ''}`,
  };

  const conciergeFile = path.join(sandbox, 'concierge', 'triage-snapshot.json');
  const conciergeSnap = loadJsonFile(conciergeFile);
  if (conciergeSnap.data && typeof conciergeSnap.data === 'object') {
    metrics.concierge = {
      ...conciergeMetric(conciergeSnap.data, Date.now()),
      sourceNote: `sandbox concierge/triage-snapshot.json — snapshot synced from the F7 primary source, the DM concierge watch state (linkedin-seen.json) on the CEO workstation (Vikunja #1053). Covers LinkedIn, the only channel with a structured per-conversation state file; FB/IG/Threads watches keep only poll logs, which is stated here rather than silently treated as zero coverage.`,
    };
  } else {
    metrics.concierge = {
      snapshot: true,
      unmeasured: true,
      today: null, last7: null, daysSinceNonzero: null, zeroStreak: null, daily: {},
      events: [],
      sourceNote: `UNMEASURED — concierge triage snapshot ${conciergeSnap.missing ? 'absent (no snapshot has ever been synced)' : `unreadable: ${conciergeSnap.error}`}. Reported as a source error, never as zero.`,
    };
  }

  try {
    const loader = fetchSeo || (async () => seoEvents(await fetchSeoTasksWithComments(readEnvToken('VIKUNJA_TOKEN'))));
    const events = await loader();
    metrics.seoChanges = {
      ...summarize(events, auditDay),
      events: events.filter(e => e.day >= shiftDay(auditDay, -6)),
      sourceNote: 'Vikunja projects 2/16: comments on SEO/AIO-keyword tasks carrying a staynalive.com or jessestay.com URL plus change language (planning mentions without change language never count)',
    };
  } catch (e) {
    metrics.seoChanges = {
      unmeasured: true,
      today: null, last7: null, daysSinceNonzero: null, zeroStreak: null, daily: {},
      events: [],
      sourceNote: `UNMEASURED — Vikunja read failed: ${e.message}. Reported as a source error, never as zero.`,
    };
  }

  const audit = { day: auditDay, generatedAt: new Date().toISOString(), metrics, alarms: [] };
  audit.alarms = buildAlarms(metrics);
  return audit;
}

async function main(argv) {
  let day = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--day' && argv[i + 1]) day = argv[++i];
  }
  const audit = await runAudit({ day });
  const state = stateDir();
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'outcome-audit.json'), JSON.stringify(audit, null, 2));
  const report = renderReport(audit);
  fs.writeFileSync(path.join(state, 'outcome-audit.md'), report);
  const appendedState = appendAlarmToRollup(audit, path.join(state, 'artifact-rollups', 'latest.md'));
  const appendedSandbox = appendAlarmToRollup(audit, path.join(sandboxDir(), 'company', 'rollups', 'latest.md'));
  console.log(report);
  if (audit.alarms.length) {
    console.error(`[outcomeAudit] OUTCOME ALARM ${audit.day}: ` +
      audit.alarms.map(a => `${a.metric} zero ${a.zeroStreak}d (owner ${a.owner})`).join('; ') +
      ` | appended to roll-up latest.md: state=${appendedState} sandbox=${appendedSandbox}`);
  }
  const unmeasured = Object.entries(audit.metrics).filter(([, m]) => m.unmeasured).map(([k]) => k);
  if (unmeasured.length) {
    console.error(`[outcomeAudit] UNMEASURED metrics (source errors): ${unmeasured.join(', ')}`);
    return 2;
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => process.exit(code || 0),
    e => { console.error(`[outcomeAudit] FATAL: ${e.message}`); process.exit(2); },
  );
}

module.exports = {
  LOOKBACK_DAYS,
  ALARM_THRESHOLD_DAYS,
  ALARM_METRICS,
  METRICS,
  denverDay,
  yesterdayDenver,
  shiftDay,
  parseJsonl,
  applicationEvents,
  publishedPostEvents,
  deliveryEvents,
  outreachEvents,
  conciergeMetric,
  loadJsonFile,
  isSeoTask,
  seoEvents,
  summarize,
  buildAlarms,
  renderAlarmSection,
  renderReport,
  loadLedger,
  appendAlarmToRollup,
  runAudit,
};
