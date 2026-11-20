'use strict';
/*
 * alertFeeder.js — deterministic Gmail job-alert feeder for jobPipeline.js
 * (Track C, Oct 28, 2026).
 *
 * PROBLEM IT FIXES: jobs/alerts-inbox.jsonl contained exactly ONE alert ever
 * (the MagicSchool seed) because nothing fed it. Jesse's job alerts arrive in
 * Gmail; this feeder formalizes the harvest -> inbox step so it is a re-runnable
 * deterministic script, not an LLM agent remembering to do it.
 *
 * HOW THE HARVEST IS RUN (read-only Gmail; never sends mail):
 *   Account: jessestay@gmail.com via the VM-side Google Workspace CLI
 *     /opt/hatch/bin/hatch_gws_cli --account b40c0a31e31649f89167c7165d18764f
 *
 *   1) List message ids UNFILTERED. (Do NOT pass q= on `users messages list` —
 *      it silently returns 0 results in this CLI. The +triage helper's ids also
 *      did not resolve on `messages get` on Oct 28, 2026; the unfiltered list
 *      path is the verified one.)
 *        hatch_gws_cli --account <acct> gmail users messages list \
 *          --params '{"userId":"me","maxResults":100,"pageToken":"<next>"}'
 *      Page with nextPageToken until the oldest message is ~30 days old
 *      (sample `messages get` format=metadata to find the date boundary;
 *      ~1,000 messages covered Sep 29 – Oct 28, 2026).
 *
 *   2) For each id, fetch metadata and keep job-alert senders/subjects
 *      (linkedin.com, indeed.com, builtin.com, wellfound, ziprecruiter,
 *      glassdoor, ashbyhq.com, greenhouse, lever, plus direct recruiter mail
 *      naming a specific role):
 *        hatch_gws_cli --account <acct> gmail users messages get \
 *          --params '{"userId":"me","id":"<id>","format":"metadata","metadataHeaders":["From","Subject","Date"]}'
 *      (NOTE: the id goes inside --params JSON, NOT as a --id flag.)
 *
 *   3) For each candidate alert, fetch the FULL message the same way with
 *      "format":"full", decode the base64 body, and extract one record per
 *      REAL posting: company, title, location/remote, salary if stated,
 *      apply URL, and the source email id. Discard newsletters/digests with
 *      no specific role and duplicates. Digest emails (e.g. LinkedIn /
 *      Built In "X and 9 more jobs") yield one record per posting in them.
 *
 *   4) Write the extracted records as a JSON array to a harvest file
 *      (see harvest.example shape below), then run THIS script:
 *        node alertFeeder.js --harvest harvest-2026-10-28.json \
 *          --inbox /path/to/jobs/alerts-inbox.jsonl \
 *          --candidates /path/to/jobs/candidates [--dry-run]
 *      It normalizes each record into the pipeline's exact inbox schema,
 *      dedupes against the existing inbox AND existing candidates'
 *      posting.json (by id and by url), and appends only new lines.
 *
 *   5) Run the pipeline (server): systemctl start macf-job-pipeline.service
 *      (or: cd slack-agents && node engine/jobPipeline.js). Scoring/staging
 *      is the pipeline's job — this feeder feeds EVERY real posting through;
 *      it does not pre-filter by Jesse's rules, so the pipeline's rejected
 *      log stays the single record of why a role did not qualify.
 *
 * HARVEST RECORD SHAPE (input; extra fields are preserved in `source`):
 *   {
 *     "sourceEmailId": "1a17...",          // Gmail message id (required)
 *     "source": "LinkedIn Job Alerts",     // human source label
 *     "company": "Planful",
 *     "title": "Director, Demand Generation",
 *     "url": "https://www.linkedin.com/jobs/view/...",
 *     "location": "Remote, United States",
 *     "remote": true,
 *     "salaryMin": 180000, "salaryMax": 220000,   // omit when not stated
 *     "description": "Posting text / requirements captured from the alert..."
 *   }
 *
 * INBOX SCHEMA (output — exactly what jobPipeline.scoreAlert/ingest reads):
 *   { id, company, title, url, location, remote, salaryMin, salaryMax,
 *     description }
 *   id is deterministic: "<source-slug>-<gmail-id-tail>-<company/title slug>"
 *   truncated, so re-running the same harvest can never duplicate a line.
 */
const fs = require('fs');
const path = require('path');

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function existingKeys(inboxFile, candidatesDir) {
  const keys = new Set();
  for (const a of readJsonl(inboxFile)) {
    if (a.id) keys.add('id:' + a.id);
    if (a.url) keys.add('url:' + a.url);
  }
  if (candidatesDir && fs.existsSync(candidatesDir)) {
    for (const d of fs.readdirSync(candidatesDir)) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(candidatesDir, d, 'posting.json'), 'utf8'));
        if (p.id) keys.add('id:' + p.id);
        if (p.url) keys.add('url:' + p.url);
      } catch { /* no posting.json — skip */ }
    }
  }
  return keys;
}

function normalize(rec) {
  if (!rec || !rec.company || !rec.title) return null;
  const src = slugify(rec.source || 'gmail') || 'gmail';
  const tail = String(rec.sourceEmailId || 'noid').slice(-6);
  const id = rec.id || `${src}-${tail}-${slugify(rec.company + ' ' + rec.title)}`;
  const out = {
    id,
    company: String(rec.company).trim(),
    title: String(rec.title).trim(),
    url: rec.url || null,
    location: rec.location || null,
    remote: typeof rec.remote === 'boolean' ? rec.remote : null,
    description: rec.description || '',
  };
  // Pipeline treats remote===false / salary fields specially; only include
  // remote when known, and salary only when stated in the posting.
  if (out.remote === null) delete out.remote;
  if (Number(rec.salaryMin)) out.salaryMin = Number(rec.salaryMin);
  if (Number(rec.salaryMax)) out.salaryMax = Number(rec.salaryMax);
  // Verbatim band as stated at the source (#1047): carried through so
  // the queue entry shows the band exactly as the posting/alert stated
  // it, not just the transcribed numbers.
  if (rec.salaryBand && Number(rec.salaryBand.low)) out.salaryBand = rec.salaryBand;
  if (rec.sourceEmailId) out.description = (out.description ? out.description + ' ' : '') +
    `[source email: ${rec.sourceEmailId}${rec.source ? '; ' + rec.source : ''}]`;
  return out;
}

function feed({ harvestFile, inboxFile, candidatesDir, dryRun = false }) {
  const harvest = JSON.parse(fs.readFileSync(harvestFile, 'utf8'));
  if (!Array.isArray(harvest)) throw new Error('harvest file must be a JSON array');
  const keys = existingKeys(inboxFile, candidatesDir);
  const appended = [], skipped = [], invalid = [];
  for (const rec of harvest) {
    const line = normalize(rec);
    if (!line) { invalid.push(rec); continue; }
    const ks = ['id:' + line.id, line.url && 'url:' + line.url].filter(Boolean);
    if (ks.some(k => keys.has(k))) { skipped.push(line); continue; }
    ks.forEach(k => keys.add(k));
    appended.push(line);
  }
  if (!dryRun && appended.length) {
    fs.mkdirSync(path.dirname(inboxFile), { recursive: true });
    fs.appendFileSync(inboxFile, appended.map(l => JSON.stringify(l)).join('\n') + '\n');
  }
  return { appended, skipped, invalid, total: harvest.length };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const harvestFile = get('--harvest');
  const inboxFile = get('--inbox');
  if (!harvestFile || !inboxFile) {
    console.error('usage: node alertFeeder.js --harvest <harvest.json> --inbox <alerts-inbox.jsonl> [--candidates <candidates dir>] [--dry-run]');
    process.exit(2);
  }
  const r = feed({ harvestFile, inboxFile, candidatesDir: get('--candidates'), dryRun: args.includes('--dry-run') });
  console.log(JSON.stringify({
    harvestTotal: r.total, appended: r.appended.length, skippedDupes: r.skipped.length, invalid: r.invalid.length,
    appendedIds: r.appended.map(a => a.id),
    skippedIds: r.skipped.map(a => a.id),
  }, null, 2));
}

module.exports = { normalize, feed, existingKeys, slugify };
