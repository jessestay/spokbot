'use strict';
/*
 * jobSubmitter.js — the job-pipeline SUBMISSION stage (Vikunja #909, Nov 2, 2026).
 *
 * Jesse's acceptance test: the pipeline counts only when applications actually
 * get submitted, and a recorded PORTAL CONFIRMATION is the only proof.
 *
 * Phase 1 investigation (Nov 2, 2026 — full evidence on ticket #909, comment
 * 2119) established that NO submission channel exists for a server-side agent:
 *   - 343/357 candidate URLs are linkedin.com, 14/357 builtin.com; zero direct
 *     ATS URLs and zero apply-by-email addresses exist in the records.
 *   - The configured LinkedIn MCP is a POSTING server (npm: "post content,
 *     share links, upload images, create polls, and engage") with no apply
 *     tool — and it currently fails to launch in engine context anyway
 *     (npx "could not determine executable to run", MCP -32000).
 *   - BuiltIn apply requires a logged-in BuiltIn account in a browser
 *     (?handler=ApplyRedirect -> ?applyRequired=true for anonymous requests).
 *   - No browser-automation stack (playwright/puppeteer/chromium) exists in
 *     the team tree; the desktop-agent exposes only bounded PowerShell.
 *
 * So this stage does everything that CAN be done deterministically in the
 * team tree, up to the one act that needs an interactive browser holding
 * Jesse's signed-in sessions (the parent agent's browser-delegation route):
 *
 *   1. QUEUE    — orders resume_ready, not-yet-submitted candidates by listed
 *                 salary, highest first (Jesse's standing rule), and writes
 *                 jobs/submission-queue.json. Candidates whose block-log
 *                 reason says the posting itself is dead (closed / removed)
 *                 are pruned from the queue and counted as prunedDead.
 *   2. PACKETS  — writes a submission-packet.md into each queued candidate
 *                 folder: posting URL, applicant facts, and the answer map
 *                 built ONLY from jobs/job-search-config.json (Jesse's stored
 *                 answers). Nothing is invented; anything not covered by the
 *                 config is a per-candidate blocker, never a guess.
 *   3. PDF      — generates resume.pdf (dependency-free text PDF) for EVERY
 *                 queued candidate missing one, so the submitter always has
 *                 an uploadable resume. (#935 G2, Nov 10, 2026: the old
 *                 top-25 cap left 141 of 199 queued candidates with no PDF.)
 *   4. BLOCK    — `block <slug> "<reason>"` appends to
 *                 jobs/submission-blockers.jsonl and annotates the candidate.
 *                 A blocker stops ONLY that candidate (Jesse, Oct 29, 2026).
 *   5. RECORD   — `record '<json>'` is the ONLY path from a real portal
 *                 confirmation into the ledger: it delegates to
 *                 jobPipeline.recordApplication(), which REFUSES any entry
 *                 without a confirmationRef, then refreshes the board.
 *
 * This module NEVER submits anything itself and NEVER writes an application
 * entry on a claim. applications.jsonl stays at 0 until a portal confirmation
 * actually exists.
 */
const fs = require('fs');
const path = require('path');
const P = require('./jobPipeline');
const E = require('./jobSalaryEnrich');

const QUEUE_FILE = 'submission-queue.json';
const BLOCKERS_FILE = 'submission-blockers.jsonl';
const PACKET_FILE = 'submission-packet.md';
const PDF_TOP_N = null; // null = no cap: generate for the full queue (#935 G2). A caller may still pass a numeric pdfTopN to prepare() to limit a run.

function jobsDir(sandbox) { return path.join(sandbox, 'jobs'); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n'); }
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function appendJsonl(file, rec) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(rec) + '\n'); }
function loadConfig(sandbox) { return readJson(path.join(jobsDir(sandbox), 'job-search-config.json'), {}); }

/* Dead-posting prune (Nov 9, 2026): buildQueue must not keep presenting
 * postings that operators already verified as gone. Patterns derived from the
 * actual reason strings recorded in submission-blockers.jsonl (Nov 2-3, 2026):
 *   "Posting closed: No longer accepting applications (...)"     119 slugs
 *   "Posting closed: Not currently accepting applications (...)"  59 slugs
 *   "Posting closed (screened Nov 2, 2026)"                        14 slugs
 *   "Posting removed: LinkedIn reports job id invalid or posting
 *    removed (...)"                                                11 slugs
 * Only these DEAD classes prune. A candidate blocked for any other reason
 * (unbanked questions, not-Easy-Apply route notes) STAYS in the queue: a
 * blocker stops that application at submit time, not its queue seat. */
const DEAD_POSTING_RES = [
  /^posting closed\b/i,
  /^posting removed\b/i,
  /no longer accepting applications/i,
  /not currently accepting applications/i,
  /job id invalid/i,
];
function deadPostingSlugs(sandbox) {
  const dead = new Set();
  for (const b of readJsonl(path.join(jobsDir(sandbox), BLOCKERS_FILE))) {
    const reason = String((b && b.reason) || '').trim();
    if (b && b.candidateSlug && DEAD_POSTING_RES.some(re => re.test(reason))) dead.add(b.candidateSlug);
  }
  return dead;
}

/* Data-quality flags: alert parsing artifacts that a human/operator should
 * see BEFORE acting (e.g. the Ghost Growth card whose title carries the
 * salary text and whose band parsed to min=400 / max=800000). Flags never
 * reorder or drop a candidate — Jesse's salary-first rule stands — they are
 * surfaced in the queue and the packet. */
function dataQualityFlags(posting) {
  const flags = [];
  const title = posting.title || '';
  if (/\$|salary/i.test(title)) flags.push('title contains salary text (alert-card parse artifact)');
  const min = Number(posting.salaryMin || 0), max = Number(posting.salaryMax || 0);
  if (max >= 200000 && min > 0 && min < 10000) flags.push(`salaryMin ${min} looks like a parse artifact against salaryMax ${max}`);
  if (!min && !max) flags.push('no salary band captured');
  return flags;
}

/* The figure to enter when a form demands a salary number.
 * General rule (Jesse, Oct 29, 2026): a fair value in the LOWER-MIDDLE of the
 * posted band -> 40th percentile of the band, rounded to the nearest 500.
 * MagicSchool exception (Jesse's own ruling): the per-posting band MEDIAN. */
function salaryFigure(posting) {
  const min = Number(posting.salaryMin || 0), max = Number(posting.salaryMax || 0);
  const slugText = `${posting.company || ''} ${posting.title || ''}`.toLowerCase();
  if (min && max) {
    if (/magicschool/.test(slugText)) return Math.round((min + max) / 2);
    return Math.round((min + 0.4 * (max - min)) / 500) * 500;
  }
  if (max) return Math.round((max * 0.85) / 500) * 500;
  if (min) return min;
  return null;
}

/* Ordered submission queue: resume_ready (per the pipeline's own stage
 * truth, recomputed from artifacts), not already submitted, highest listed
 * salary first (salaryMax, then salaryMin), slug as stable tie-break. */
function buildQueueDetailed(sandbox) {
  const stages = P.refreshStages(sandbox);
  const apps = readJsonl(path.join(jobsDir(sandbox), 'applications.jsonl'));
  const submitted = new Set(apps.filter(a => a.confirmationRef).map(a => a.candidateSlug).filter(Boolean));
  const dead = deadPostingSlugs(sandbox);
  const entries = [];
  let prunedDead = 0;
  for (const c of stages) {
    if (c.stage !== 'resume_ready' || !c.hasResume) continue;
    if (submitted.has(c.slug)) continue;
    if (dead.has(c.slug)) { prunedDead++; continue; }
    const posting = readJson(path.join(jobsDir(sandbox), 'candidates', c.slug, 'posting.json'), {});
    entries.push({
      slug: c.slug,
      company: posting.company || c.company || null,
      title: posting.title || c.title || null,
      url: posting.url || c.url || null,
      location: posting.location || null,
      remote: posting.remote === true,
      salaryMin: Number(posting.salaryMin || 0) || null,
      salaryMax: Number(posting.salaryMax || 0) || null,
      // The band verbatim as stated at the source (#1047): from the
      // alert card when LinkedIn printed it there, else transcribed
      // from the posting itself by jobSalaryEnrich at prepare time.
      salaryBand: posting.salaryBand || null,
      salaryFigure: salaryFigure(posting),
      resumeFile: c.resumeFile,
      dataQualityFlags: dataQualityFlags(posting),
    });
  }
  entries.sort((a, b) =>
    (b.salaryMax || 0) - (a.salaryMax || 0) ||
    (b.salaryMin || 0) - (a.salaryMin || 0) ||
    a.slug.localeCompare(b.slug));
  entries.forEach((e, i) => { e.rank = i + 1; });
  return { entries, prunedDead };
}

function buildQueue(sandbox) { return buildQueueDetailed(sandbox).entries; }

function renderPacket(entry, config) {
  const cfg = config || {};
  const answered = cfg.alreadyAnsweredElsewhere || {};
  const eeo = cfg.eeoSelfId || {};
  const refs = (cfg.references && cfg.references.pool) || [];
  const refLines = refs.map(r => {
    const bits = [r.name];
    if (r.title || r.org) bits.push([r.title, r.org].filter(Boolean).join(', '));
    if (r.emails && r.emails.length) bits.push(r.emails.join(' / '));
    if (r.phones && r.phones.length) bits.push(r.phones.join(' / '));
    return `  - ${bits.join(' — ')}`;
  });
  const lines = [
    `# Submission packet — ${entry.title || 'role'} at ${entry.company || ''}`,
    '',
    `Queue rank: ${entry.rank} (highest listed salary first)`,
    `Posting: ${entry.url || '(no url)'}`,
    `Location: ${entry.location || 'n/a'} · Band: ${entry.salaryMin || '?'} - ${entry.salaryMax || '?'}`,
    ...(entry.salaryBand ? [`Band as stated at the source: "${entry.salaryBand.text}" (${entry.salaryBand.source || 'posting'})`] : []),
    ...(entry.dataQualityFlags.length ? ['', '## DATA-QUALITY FLAGS (read before acting)', ...entry.dataQualityFlags.map(f => `- ${f}`)] : []),
    '',
    '## Applicant (verified facts only)',
    '- Name: Jesse Stay',
    `- Email: ${answered.contact ? answered.contact.split(',')[0].trim() : 'jesse@staynalive.com'}`,
    '- Phone: 801-853-8339',
    '- Location: St. George, UT (remote from Utah; Utah-local and hybrid in scope)',
    '- LinkedIn: linkedin.com/in/facebook',
    `- Work authorization: ${answered.workAuthorization || 'US citizen, authorized to work in the US, no sponsorship required'}`,
    `- Education: ${answered.education || 'B.S. Computer Information Systems, Strayer University, 2005, Summa Cum Laude'}`,
    `- Languages: ${answered.languages || 'English native; Thai semi-fluent; Spanish NOT claimable'}`,
    '',
    '## Resume files (in this folder)',
    `- Tailored resume (markdown): ${entry.resumeFile || 'resume.md'}`,
    '- Uploadable PDF: resume.pdf (generated by the submission stage; if absent, generate with `node engine/jobSubmitter.js pdf <slug>`)',
    '',
    '## Answer map — Jesse\'s stored configuration (use verbatim; never invent beyond this)',
    `- Salary figure to enter: ${entry.salaryFigure ? '$' + entry.salaryFigure.toLocaleString('en-US') : '(no band captured — if the form requires a figure and no band exists, log a blocker)'} — rule: ${cfg.salaryExpectationRule || 'lower-middle of the posted band'}${/magicschool/i.test(entry.company || '') ? ' (MagicSchool: per-posting band median per Jesse\'s ruling)' : ''}`,
    `- Earliest start: ${cfg.earliestStart || 'ASAP'}`,
    `- Travel: ${cfg.travelWillingness || 'As often as needed'}`,
    `- Largest budget managed: $${Number(cfg.largestBudgetManagedUSD || 2000000).toLocaleString('en-US')}`,
    `- SEM / Google Ads: ${cfg.semExperience || 'Since Google Ads launched (2000)'}`,
    `- LinkedIn Ads: ${cfg.linkedInAds || 'Claim — since LinkedIn Ads has been available'}`,
    `- Team management experience: ${cfg.teamManagementYears != null ? cfg.teamManagementYears + ' years' : 'not recorded'}`,
    `- Significantly scaled Meta spend for a brand or agency: ${cfg.scaledMetaSpend ? 'YES' : 'not recorded'}`,
    `- Lifecycle platforms: ${(cfg.lifecyclePlatforms || ['GA4']).join(', ')} only`,
    `- Webflow: ${cfg.webflow || 'None'}`,
    `- Reporting tools: ${(cfg.reportingTools || []).join(', ')}`,
    `- Background check consent: ${cfg.backgroundCheckConsent ? 'YES — standing consent' : 'not recorded'}`,
    `- Drug screening consent: ${cfg.drugScreeningConsent ? 'YES — standing consent' : 'not recorded'}`,
    `- Non-compete restrictions: ${cfg.nonCompeteRestrictions || 'None'}`,
    `- Conflicts: ${cfg.conflicts || 'None'}`,
    `- Voluntary self-ID (only if the form asks): race ${eeo.race || '—'}; veteran status ${eeo.veteranStatus || '—'}; disability ${eeo.disabilityStatus || '—'}`,
    '- References (pick per role; Luke Kilpatrick replaces Dale Kim):',
    ...refLines,
    '',
    '## Operator rules (Jesse\'s standing instructions)',
    '- No per-application approval is needed. Submit with the tailored resume.',
    '- Use ONLY the facts and answers above. If the portal asks a question this packet does not answer, DO NOT guess: log it with `node engine/jobSubmitter.js block ' + entry.slug + ' "<the unanswered question>"` and move to the next candidate. A blocker stops only this application.',
    '- On submission, capture the portal confirmation EXACTLY (confirmation text / reference / confirmation email subject) and record it the same run:',
    '  `node engine/jobSubmitter.js record \'{"candidateSlug":"' + entry.slug + '","company":"' + (entry.company || '') + '","title":"' + (entry.title || '') + '","url":"' + (entry.url || '') + '","confirmationRef":"<verbatim confirmation reference or confirmation-page text>","executor":"<your seat: team:jobcoach for the team pipeline, ceo:operator for the CEO browser route>"}\'`',
    '- An application counts ONLY when recorded with that confirmation. Never record on a claim.',
    '',
  ];
  return lines.join('\n');
}

/* Minimal Markdown -> plain text for the PDF resume: strip heading and
 * emphasis markers, unwrap links to "text (url)", keep bullets. */
function markdownToText(md) {
  return String(md || '')
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^>\s?/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n');
}

function wrapLine(line, width) {
  if (!line.trim()) return [''];
  const words = line.split(/\s+/);
  const out = [];
  let cur = '';
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if ((cur + ' ' + w).length <= width) cur += ' ' + w;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out;
}

/* Dependency-free text PDF (PDF 1.4, Helvetica). Deterministic: no dates or
 * IDs are embedded, so identical input yields identical bytes. */
function textToPdf(text) {
  const WIDTH = 88, LINES_PER_PAGE = 48, FONT = 10.5, LEADING = 14, X = 54, TOP = 738;
  const rawLines = String(text || '').split('\n').flatMap(l => wrapLine(l, WIDTH));
  const pages = [];
  for (let i = 0; i < rawLines.length; i += LINES_PER_PAGE) pages.push(rawLines.slice(i, i + LINES_PER_PAGE));
  if (!pages.length) pages.push([['']]);
  const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[^\x20-\x7E]/g, '');
  const objects = [];
  const fontObj = 3 + pages.length * 2 + 1;
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  pages.forEach((pageLines, i) => {
    const pageObj = 3 + i * 2, contentObj = pageObj + 1;
    objects[pageObj] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`;
    const stream = ['BT', `/F1 ${FONT} Tf`, `${LEADING} TL`, `${X} ${TOP} Td`,
      ...pageLines.map(l => `(${esc(l)}) Tj T*`), 'ET'].join('\n');
    objects[contentObj] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontObj] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let out = '%PDF-1.4\n';
  const offsets = [0];
  const maxObj = Math.max(...Object.keys(objects).map(Number));
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = Buffer.byteLength(out);
    out += `${n} 0 obj\n${objects[n] || '<< >>'}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(out);
  out += `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function generatePdf(sandbox, slug) {
  const dir = path.join(jobsDir(sandbox), 'candidates', slug);
  const mdFile = path.join(dir, 'resume.md');
  if (!fs.existsSync(mdFile)) return null;
  const pdf = textToPdf(markdownToText(fs.readFileSync(mdFile, 'utf8')));
  const out = path.join(dir, 'resume.pdf');
  fs.writeFileSync(out, pdf);
  return out;
}

/* prepare: rebuild queue, write packets, annotate status.json (stage string
 * is NEVER changed here — the pipeline owns stage transitions), generate
 * PDFs for the top of the queue. Idempotent. */
function prepare({ sandbox = P.sandboxDir(), pdfTopN = PDF_TOP_N } = {}) {
  const config = loadConfig(sandbox);
  const { entries: queue, prunedDead } = buildQueueDetailed(sandbox);
  writeJson(path.join(jobsDir(sandbox), QUEUE_FILE), {
    generatedAt: new Date().toISOString(),
    note: 'Ordered by highest listed salary first (Jesse\'s rule). Packets live in each candidate folder. This stage prepares and records; the portal submission itself runs through the delegated browser operator (no server-side channel exists — #909 comment 2119).',
    count: queue.length,
    prunedDead,
    entries: queue,
  });
  let packets = 0, pdfs = 0;
  queue.forEach((entry, idx) => {
    const dir = path.join(jobsDir(sandbox), 'candidates', entry.slug);
    fs.writeFileSync(path.join(dir, PACKET_FILE), renderPacket(entry, config));
    packets++;
    const stFile = path.join(dir, 'status.json');
    const st = readJson(stFile, null);
    if (st) {
      st.submission = { ...(st.submission || {}), queuedAt: new Date().toISOString(), rank: entry.rank };
      writeJson(stFile, st);
    }
    if ((pdfTopN == null || idx < pdfTopN) && !fs.existsSync(path.join(dir, 'resume.pdf'))) {
      if (generatePdf(sandbox, entry.slug)) pdfs++;
    }
  });
  return { ranAt: new Date().toISOString(), queued: queue.length, prunedDead, packets, pdfsGenerated: pdfs, top: queue.slice(0, 5).map(e => ({ rank: e.rank, slug: e.slug, company: e.company, title: e.title, salaryMax: e.salaryMax })) };
}

/* prepareWithSalaryEnrichment (#1047): the timer entry point. The
 * LinkedIn alert email carries a band for only ~5% of postings, so
 * before rebuilding the queue, enrich the records of queued candidates
 * that still lack one by fetching the posting itself (jobSalaryEnrich:
 * cached, capped at MACF_SALARY_ENRICH_MAX fetches per run, default 40).
 * prepare() itself stays synchronous and network-free. */
async function prepareWithSalaryEnrichment({ sandbox = P.sandboxDir(), pdfTopN = PDF_TOP_N } = {}) {
  const pre = buildQueueDetailed(sandbox);
  const maxFetch = Number(process.env.MACF_SALARY_ENRICH_MAX || E.DEFAULT_MAX_FETCH);
  const stats = await E.enrichMissingBands({ sandbox, entries: pre.entries, maxFetch });
  const summary = prepare({ sandbox, pdfTopN });
  summary.salaryEnrichment = stats;
  return summary;
}

/* block: per-candidate blocker. Appends to submission-blockers.jsonl and
 * annotates the candidate. Never touches other candidates, never changes
 * the stage, never blocks the pipeline. */
function block(sandbox, slug, reason) {
  if (!slug || !reason || !String(reason).trim()) throw new Error('block: slug and a non-empty reason are required');
  const dir = path.join(jobsDir(sandbox), 'candidates', slug);
  if (!fs.existsSync(dir)) throw new Error(`block: unknown candidate ${slug}`);
  const posting = readJson(path.join(dir, 'posting.json'), {});
  const entry = { ts: new Date().toISOString(), candidateSlug: slug, company: posting.company || null, title: posting.title || null, reason: String(reason) };
  appendJsonl(path.join(jobsDir(sandbox), BLOCKERS_FILE), entry);
  const stFile = path.join(dir, 'status.json');
  const st = readJson(stFile, null);
  if (st) {
    st.submission = { ...(st.submission || {}), lastBlocker: { ts: entry.ts, reason: entry.reason } };
    writeJson(stFile, st);
  }
  return entry;
}

/* record: the ONLY confirmation path into the ledger. Delegates to
 * jobPipeline.recordApplication (refuses without confirmationRef), then
 * refreshes the pipeline board/state so the new stage is visible.
 * The caller's `executor` seat ('team:jobcoach' | 'ceo:operator') passes
 * through untouched and is stored on the ledger entry (#935 G3 / #980). */
function record(sandbox, rec) {
  const entry = P.recordApplication(sandbox, rec);
  P.run({ sandbox });
  return entry;
}

if (require.main === module) {
  const [cmd, a1, a2] = process.argv.slice(2);
  const sandbox = P.sandboxDir();
  try {
    if (cmd === 'block') {
      console.log(JSON.stringify(block(sandbox, a1, a2), null, 2));
    } else if (cmd === 'record') {
      console.log('recorded:', JSON.stringify(record(sandbox, JSON.parse(a1 || '{}'))));
    } else if (cmd === 'pdf') {
      console.log(generatePdf(sandbox, a1) || 'no resume.md found');
    } else if (cmd === 'queue') {
      console.log(JSON.stringify(buildQueue(sandbox), null, 2));
    } else {
      // Timer path (macf-job-submit.service): enrich missing salary
      // bands from the postings themselves, then prepare (#1047).
      prepareWithSalaryEnrichment({ sandbox })
        .then((s) => console.log(JSON.stringify({ jobSubmitter: s }, null, 2)))
        .catch((e) => { console.error('ERROR:', e.message); process.exit(2); });
    }
  } catch (e) { console.error('ERROR:', e.message); process.exit(2); }
}

module.exports = { buildQueue, buildQueueDetailed, deadPostingSlugs, salaryFigure, dataQualityFlags, renderPacket, markdownToText, textToPdf, generatePdf, prepare, prepareWithSalaryEnrichment, block, record, QUEUE_FILE, BLOCKERS_FILE, PACKET_FILE };
