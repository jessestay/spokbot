'use strict';
/*
 * jobPipeline.js — deterministic job-pipeline machinery (CEO Build J1, Oct 26, 2026).
 *
 * Jesse's order: "you write the code to fix the system. Use these scenarios to
 * test the system works." Scenario S1 failed because the pipeline machinery did
 * not exist: no ingestion, no candidate tracking, no application ledger writer.
 * This module is that machinery. It makes NO LLM calls and submits NOTHING;
 * it runs the state machine that agents (Job Coach, apply operator) work from:
 *
 *   jobs/alerts-inbox.jsonl   raw alert records (written by any source: the Job
 *                             Coach's Gmail reads, a future poller, a manual seed)
 *        | ingest: dedupe by id/url, score against Jesse's standing rules
 *        v
 *   jobs/candidates/<slug>/   posting.json + status.json + resume-input.md
 *                             (the tailoring packet: posting requirements plus
 *                             pointers to the two canonical biography sources)
 *        | an agent drops resume.md / resume.pdf / resume.docx in the folder
 *        v
 *   stage: resume_ready       detected from the artifact, never from a claim
 *        | the apply operator submits on the portal and records the result
 *        v
 *   jobs/applications.jsonl   via recordApplication(), which REFUSES any entry
 *                             without a portal confirmation reference — the
 *                             same ledger engine/outcomeAudit.js counts.
 *
 * Every run rewrites jobs/pipeline-status.md (human-readable board) and
 * .state/job-pipeline.json (machine state). Stage changes are driven by files
 * on disk, so a stage can never be "reported" into existence.
 */
const fs = require('fs');
const path = require('path');

const SALARY_FLOOR = 200000;
const SENIORITY = /\b(director|vp|vice president|head of|chief|principal|staff|senior director)\b/i;
const DOMAIN = /\b(marketing|growth|digital|brand|seo|content|social media|ai|artificial intelligence|demand gen|product marketing)\b/i;

function sandboxDir() {
  if (process.env.MACF_SANDBOX_DIR) return process.env.MACF_SANDBOX_DIR;
  return path.join(__dirname, '..', '..', 'engine-home', 'workspace', 'agent-sandbox');
}
function stateDir() {
  return path.join(__dirname, '..', '.state');
}

function slugify(s) {
  return String(s || 'role').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'role';
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}
function appendJsonl(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

/* Score one alert against Jesse's standing job rules (Oct 14, 2026):
 * Director/VP-level, marketing/growth/digital/AI domain, remote OR
 * Utah-local OR hybrid, $200K+ when a band is stated. Never reject for
 * being full-time. (Location rule widened Oct 28, 2026: the remote-only
 * filter is retired; Utah-local and hybrid postings score like remote.) */
function scoreAlert(alert) {
  const reasons = [];
  const title = alert.title || '';
  const text = `${title} ${alert.description || ''}`;
  if (!SENIORITY.test(title)) reasons.push('title below Director/VP seniority');
  if (!DOMAIN.test(text)) reasons.push('outside marketing/growth/digital/AI domain');
  const loc = String(alert.location || '');
  // Location rule (widened by Jesse, Oct 28, 2026 23:00 MDT): remote roles,
  // Utah-local roles, and hybrid roles all count. A posting is rejected on
  // location grounds only when it is explicitly non-remote AND neither
  // Utah-local nor hybrid (e.g. "On-site, Austin TX" still rejects).
  // Utah-local = the state name/abbreviation OR a Utah locality/metro name
  // (LinkedIn labels the capital metro "Salt Lake City Metropolitan Area",
  // which contains neither "Utah" nor "UT" — it must still count).
  const utahLocal = /utah|\bUT\b|salt lake|provo|orem|lehi|sandy|ogden|st\.? george|draper|park city|logan|layton|bountiful|murray|cedar city|south jordan|west jordan|west valley|pleasant grove|spanish fork|springville|american fork|saratoga springs|eagle mountain|riverton|herriman|kaysville|farmington|taylorsville|tooele|heber|moab/i.test(loc);
  const hybrid = /hybrid/i.test(loc) || /hybrid/i.test(text);
  if (alert.remote === false && !utahLocal && !hybrid) reasons.push('not remote');
  if (alert.remote !== true && loc && !utahLocal && !hybrid && !/remote|anywhere|united states|usa/i.test(loc) && !/\bremote\b/i.test(text)) {
    reasons.push(`location "${loc}" with no remote signal`);
  }
  const max = Number(alert.salaryMax || alert.salary_max || 0);
  const min = Number(alert.salaryMin || alert.salary_min || 0);
  if (max && max < SALARY_FLOOR) reasons.push(`salary max ${max} below floor ${SALARY_FLOOR}`);
  if (!max && min && min < SALARY_FLOOR) reasons.push(`salary min ${min} below floor ${SALARY_FLOOR} with no max stated`);
  return { qualifies: reasons.length === 0, reasons };
}

function candidateSlug(alert) {
  return slugify(`${alert.company || 'company'} ${alert.title || 'role'}`);
}

function ingest(sandbox) {
  const jobsDir = path.join(sandbox, 'jobs');
  const inboxFile = path.join(jobsDir, 'alerts-inbox.jsonl');
  const candRoot = path.join(jobsDir, 'candidates');
  fs.mkdirSync(candRoot, { recursive: true });
  const alerts = readJsonl(inboxFile);
  const seen = new Set();
  for (const d of fs.readdirSync(candRoot)) {
    const p = readJson(path.join(candRoot, d, 'posting.json'), null);
    if (p) { if (p.id) seen.add('id:' + p.id); if (p.url) seen.add('url:' + p.url); }
  }
  let created = 0, rejected = 0, dupes = 0;
  const rejectedLog = [];
  for (const alert of alerts) {
    const keys = [alert.id && 'id:' + alert.id, alert.url && 'url:' + alert.url].filter(Boolean);
    if (keys.some(k => seen.has(k))) { dupes++; continue; }
    keys.forEach(k => seen.add(k));
    const { qualifies, reasons } = scoreAlert(alert);
    if (!qualifies) { rejected++; rejectedLog.push({ title: alert.title, company: alert.company, reasons }); continue; }
    const slug = candidateSlug(alert);
    const dir = path.join(candRoot, slug);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'posting.json'), alert);
    writeJson(path.join(dir, 'status.json'), {
      slug, stage: 'ready_for_tailoring', company: alert.company || null,
      title: alert.title || null, url: alert.url || null, updated: new Date().toISOString(),
    });
    fs.writeFileSync(path.join(dir, 'resume-input.md'), [
      `# Tailoring packet — ${alert.title || 'role'} at ${alert.company || ''}`,
      '',
      `Posting: ${alert.url || '(no url)'}`,
      `Location: ${alert.location || 'n/a'} · Remote: ${alert.remote === true ? 'yes' : 'unstated'} · Band: ${alert.salaryMin || '?'} - ${alert.salaryMax || '?'}`,
      '',
      '## Posting text / requirements',
      alert.description || '(no description captured — fetch the posting before tailoring)',
      '',
      '## Sources (ONLY these; never invent metrics)',
      '- ~/workspace/biography-research/desktop-canonical-resume-jesse.md',
      '- ~/workspace/macf/team-skills/jesse-biography.md',
      'BANNED: pre-built tailored PDFs in Downloads; the desktop resume QUARANTINE folder.',
      '',
      '## Factory output (drop in this folder)',
      'resume.md + resume.pdf (docx welcome). Presence of a resume artifact moves',
      'this candidate to resume_ready on the next pipeline run.',
      '',
    ].join('\n'));
    created++;
  }
  return { created, rejected, dupes, rejectedLog, inboxTotal: alerts.length };
}

const RESUME_FILES = ['resume.pdf', 'resume.docx', 'resume.md'];
// A resume artifact only counts when it is a REAL file: a placeholder or
// stub (a few bytes dropped to flip the stage) must not move a candidate
// to resume_ready. The tailoring packet (resume-input.md) never counts —
// it is not in RESUME_FILES and is written by ingest itself.
const MIN_RESUME_BYTES = 500;
function qualifyingResume(dir) {
  for (const f of RESUME_FILES) {
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.isFile() && st.size > MIN_RESUME_BYTES) return f;
    } catch { /* absent — keep looking */ }
  }
  return null;
}
function refreshStages(sandbox) {
  const candRoot = path.join(sandbox, 'jobs', 'candidates');
  const apps = readJsonl(path.join(sandbox, 'jobs', 'applications.jsonl'));
  const submittedSlugs = new Set(apps.filter(a => a.confirmationRef).map(a => a.candidateSlug).filter(Boolean));
  const out = [];
  if (!fs.existsSync(candRoot)) return out;
  for (const d of fs.readdirSync(candRoot)) {
    const dir = path.join(candRoot, d);
    const stFile = path.join(dir, 'status.json');
    if (!fs.existsSync(stFile)) continue;
    const st = readJson(stFile, { slug: d, stage: 'unknown' });
    const resumeFile = qualifyingResume(dir);
    const hasResume = !!resumeFile;
    let stage = st.stage;
    if (submittedSlugs.has(d)) stage = 'submitted';
    else if (hasResume) stage = 'resume_ready';
    else if (stage === 'submitted' || stage === 'resume_ready') stage = 'ready_for_tailoring';
    if (stage !== st.stage) { st.stage = stage; st.updated = new Date().toISOString(); writeJson(stFile, st); }
    out.push({ slug: d, stage, company: st.company || null, title: st.title || null, url: st.url || null, hasResume, resumeFile });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/* The ONLY writer of applications.jsonl. Refuses unconfirmed entries so the
 * outcome audit's count can never be inflated by a claim.
 * executor (#935 G3 / #980, Nov 10, 2026): WHICH seat submitted —
 * 'team:jobcoach' for the team pipeline, 'ceo:operator' for the CEO's
 * browser route. Optional for backward compatibility: entries recorded
 * before the field existed (and any caller that omits it) land as null,
 * which the outcome audit reports as 'unspecified'. Without this field
 * F1's team-executed test was unprovable from the ledger. */
function recordApplication(sandbox, rec) {
  if (!rec || !rec.confirmationRef || !String(rec.confirmationRef).trim()) {
    throw new Error('recordApplication: confirmationRef (portal confirmation) is required — unconfirmed submissions are never recorded');
  }
  if (!rec.company || !rec.title) throw new Error('recordApplication: company and title are required');
  const entry = {
    ts: new Date().toISOString(),
    company: rec.company, title: rec.title,
    url: rec.url || null,
    confirmationRef: String(rec.confirmationRef),
    candidateSlug: rec.candidateSlug || null,
    executor: rec.executor ? String(rec.executor) : null,
  };
  appendJsonl(path.join(sandbox, 'jobs', 'applications.jsonl'), entry);
  return entry;
}

function run({ sandbox = sandboxDir(), state = stateDir() } = {}) {
  const ing = ingest(sandbox);
  const candidates = refreshStages(sandbox);
  const apps = readJsonl(path.join(sandbox, 'jobs', 'applications.jsonl'));
  const confirmed = apps.filter(a => a.confirmationRef).length;
  // ZERO-INPUT ALARM (Oct 28, 2026): an empty inbox with zero candidates is
  // a broken pipeline (no alert source is feeding it), not a healthy zero.
  // It must be VISIBLE — in the returned summary, the machine state, and
  // the human board — never a silent success.
  const alarm = (ing.inboxTotal === 0 && candidates.length === 0)
    ? 'EMPTY_INBOX: alerts inbox is empty and there are no candidates — no alert source is feeding jobs/alerts-inbox.jsonl. This is a broken pipeline, not a healthy zero.'
    : null;
  const summary = {
    ranAt: new Date().toISOString(),
    ingest: { created: ing.created, rejected: ing.rejected, dupes: ing.dupes, inboxTotal: ing.inboxTotal },
    candidates: candidates.length,
    byStage: candidates.reduce((m, c) => ((m[c.stage] = (m[c.stage] || 0) + 1), m), {}),
    applicationsConfirmed: confirmed,
    alarm,
  };
  writeJson(path.join(state, 'job-pipeline.json'), { summary, candidates, rejected: ing.rejectedLog });
  const lines = [
    '# Job pipeline status', '',
    `Updated: ${summary.ranAt}`,
    ...(alarm ? [`> ALARM: ${alarm}`, ''] : []),
    `Candidates: ${candidates.length} · Confirmed applications: ${confirmed}`,
    `Stages: ${JSON.stringify(summary.byStage)}`, '',
    '| candidate | company | title | stage | resume |',
    '|---|---|---|---|---|',
    ...candidates.map(c => `| ${c.slug} | ${c.company || ''} | ${c.title || ''} | ${c.stage} | ${c.hasResume ? 'yes' : 'no'} |`),
    '',
  ];
  const statusFile = path.join(sandbox, 'jobs', 'pipeline-status.md');
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(statusFile, lines.join('\n'));
  return summary;
}

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'record') {
    try {
      const entry = recordApplication(sandboxDir(), JSON.parse(arg || '{}'));
      console.log('recorded:', JSON.stringify(entry));
    } catch (e) { console.error('REFUSED:', e.message); process.exit(2); }
  } else {
    console.log(JSON.stringify(run(), null, 2));
  }
}

module.exports = { scoreAlert, slugify, candidateSlug, ingest, refreshStages, recordApplication, run, sandboxDir, SALARY_FLOOR, MIN_RESUME_BYTES, qualifyingResume };
