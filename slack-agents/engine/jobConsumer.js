'use strict';
/*
 * jobConsumer.js — the queue consumer for the submission pipeline
 * (#935 G4, Nov 10, 2026). DRY-RUN ONLY.
 *
 * Until now NOTHING read jobs/submission-queue.json: jobSubmitter.prepare()
 * rebuilt the queue every 30 minutes and no consumer existed, so the queue
 * was a dead letter. This module is the consumer skeleton: it walks the
 * queue in rank order, resolves the machine-readable answer map
 * (jobAnswerResolver, G5), and renders a per-candidate decision:
 *
 *   would-submit            — every deterministic pre-submit check passes;
 *                             the live adapter (G7) may proceed to the
 *                             browser walk. NOTE: dry-run cannot see the
 *                             portal, so Easy Apply vs off-site routing for
 *                             never-attempted LinkedIn postings is only
 *                             confirmed by the live walk.
 *   blocked-on-<class>      — a concrete, named blocker. Each blocked
 *                             decision carries a `wouldBlock` payload in
 *                             the exact shape jobSubmitter.block() writes,
 *                             so the live consumer can persist it verbatim.
 *
 * SAFETY: this build has NO live mode. Running without --dry-run is a hard
 * error. In dry-run it writes NOTHING to the sandbox: no ledger entries,
 * no block-log appends, no status.json changes. Its only output is the
 * report file (default .state/job-consumer-dry-run.json) and stdout.
 * It never opens a browser and never touches a portal.
 *
 * Decision precedence (first match wins):
 *   1. prior blocker on file (submission-blockers.jsonl, latest per slug)
 *      — empirical evidence from a real portal attempt outranks inference:
 *        Not Easy Apply        -> blocked-on-not-easy-apply
 *        uncovered question    -> blocked-on-unbanked-questions
 *        dead-posting patterns -> blocked-on-dead-posting (should have been
 *                                 pruned by prepare(); surfacing it here is
 *                                 a queue-integrity signal)
 *        anything else         -> blocked-on-prior-blocker
 *   2. BuiltIn URL            -> blocked-on-builtin-session (G10 phase 2:
 *                                no BuiltIn account session exists)
 *   3. no URL                 -> blocked-on-missing-url
 *   4. resume.pdf missing     -> blocked-on-missing-resume-pdf
 *   5. resolver uncovered     -> blocked-on-uncovered-<field> (first gap)
 *   6. otherwise              -> would-submit
 * Data-quality flags are attached as warnings; they never block (Jesse's
 * rule, per jobSubmitter.dataQualityFlags).
 */
const fs = require('fs');
const path = require('path');
const P = require('./jobPipeline');
const R = require('./jobAnswerResolver');

const DEAD_RE = [/^posting closed\b/i, /^posting removed\b/i, /no longer accepting applications/i, /not currently accepting applications/i, /job id invalid/i];

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function jobsDir(sandbox) { return path.join(sandbox, 'jobs'); }

function latestBlockers(sandbox) {
  const latest = new Map();
  for (const b of readJsonl(path.join(jobsDir(sandbox), 'submission-blockers.jsonl'))) {
    if (b && b.candidateSlug) latest.set(b.candidateSlug, b);
  }
  return latest;
}

/* Unbanked-answer phrasings, derived from the actual reason strings in
 * submission-blockers.jsonl (Nov 2-9, 2026 operator attempts): "Uncovered
 * skill battery:", "Uncovered required question:", "not in the answer
 * bank", "no banked text", "Bespoke essay questions needing Jesse input",
 * "Six pharma-specific Y/N questions", "Requires a cover letter", etc.
 * All of them mean the same thing: the portal asked something Jesse has
 * not banked an answer for, so the consumer must block, never guess. */
const UNBANKED_RE = [/uncovered/i, /not in the answer bank/i, /no banked/i, /needs Jesse/i, /needing Jesse/i, /awaiting Jesse/i, /bespoke essay/i, /essay/i, /cover letter/i, /Y\/N questions/i, /external .* form/i];

function classifyBlocker(reason) {
  const r = String(reason || '');
  if (DEAD_RE.some(re => re.test(r))) return { decision: 'blocked-on-dead-posting', detail: r };
  if (/^not easy apply/i.test(r)) return { decision: 'blocked-on-not-easy-apply', detail: r };
  if (UNBANKED_RE.some(re => re.test(r))) {
    const q = r.split(/uncovered[^:]*:?\s*/i)[1] || r;
    return { decision: 'blocked-on-unbanked-questions', detail: q.trim() };
  }
  return { decision: 'blocked-on-prior-blocker', detail: r };
}

function routeOf(url) {
  const u = String(url || '');
  if (/linkedin\.com/i.test(u)) return 'linkedin';
  if (/builtin\.com/i.test(u)) return 'builtin';
  if (!u) return 'none';
  return 'other';
}

function decide(entry, ctx) {
  const { config, blockers, sandbox } = ctx;
  const warnings = [...(entry.dataQualityFlags || [])];
  const { answers, uncovered, voluntaryUncovered } = R.resolveAnswers(config, entry);
  const base = {
    rank: entry.rank, slug: entry.slug, company: entry.company, title: entry.title,
    url: entry.url, route: routeOf(entry.url), warnings,
    answersCovered: Object.keys(answers).length,
    uncoveredFields: uncovered.map(u => u.field),
    voluntaryUncovered: voluntaryUncovered.map(u => u.field),
  };
  const block = (decision, detail) => ({
    ...base, decision, detail,
    wouldBlock: { candidateSlug: entry.slug, company: entry.company || null, title: entry.title || null, reason: `${decision}: ${detail}` },
  });

  const prior = blockers.get(entry.slug);
  if (prior) {
    const c = classifyBlocker(prior.reason);
    return block(c.decision, c.detail);
  }
  if (base.route === 'builtin') return block('blocked-on-builtin-session', 'BuiltIn apply requires a logged-in BuiltIn account session; none exists server-side (G10, phase 2)');
  if (base.route === 'none') return block('blocked-on-missing-url', 'queue entry has no posting URL');
  if (!fs.existsSync(path.join(jobsDir(sandbox), 'candidates', entry.slug, 'resume.pdf'))) {
    return block('blocked-on-missing-resume-pdf', 'no uploadable resume.pdf in the candidate folder');
  }
  if (uncovered.length) {
    const u = uncovered[0];
    return block(`blocked-on-uncovered-${u.field}`, u.reason);
  }
  return { ...base, decision: 'would-submit', detail: 'all deterministic pre-submit checks pass; portal walk (Easy Apply detection, per-portal questions) happens in the live adapter (G7)' };
}

function dryRun({ sandbox = P.sandboxDir(), limit = null } = {}) {
  const queue = readJson(path.join(jobsDir(sandbox), 'submission-queue.json'), null);
  if (!queue || !Array.isArray(queue.entries)) throw new Error('dryRun: submission-queue.json missing or malformed');
  const config = R.loadConfig(sandbox);
  const blockers = latestBlockers(sandbox);
  const apps = readJsonl(path.join(jobsDir(sandbox), 'applications.jsonl'));
  const submitted = new Set(apps.filter(a => a.confirmationRef).map(a => a.candidateSlug).filter(Boolean));
  // #1094: slugless ledger entries (candidateSlug null) are invisible to the slug
  // set above, so a confirmed submission could be re-classified would-submit.
  // Also dedup on normalized company+title for confirmed ledger entries.
  const normKey = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const submittedKeys = new Set(apps.filter(a => a.confirmationRef).map(a => normKey(a.company) + "|" + normKey(a.title)));
  const entries = limit ? queue.entries.slice(0, limit) : queue.entries;
  const decisions = [];
  const alreadySubmitted = [];
  for (const entry of entries) {
    if (submitted.has(entry.slug)) { alreadySubmitted.push(entry.slug); continue; }
    if (submittedKeys.has(normKey(entry.company) + "|" + normKey(entry.title))) { alreadySubmitted.push(entry.slug + ":company-title-match"); continue; }
    decisions.push(decide(entry, { config, blockers, sandbox }));
  }
  const distribution = {};
  for (const d of decisions) distribution[d.decision] = (distribution[d.decision] || 0) + 1;
  return {
    mode: 'DRY-RUN — nothing submitted, nothing written to the sandbox',
    ranAt: new Date().toISOString(),
    queueGeneratedAt: queue.generatedAt || null,
    queueCount: queue.count,
    evaluated: decisions.length,
    alreadySubmittedSkipped: alreadySubmitted,
    distribution,
    decisions,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.includes('--dry-run')) {
    console.error('REFUSED: jobConsumer has no live mode in this build (#935 step 4). Re-run with --dry-run.');
    process.exit(2);
  }
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : null;
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : path.join(__dirname, '..', '.state', 'job-consumer-dry-run.json');
  try {
    const report = dryRun({ limit });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({
      mode: report.mode, ranAt: report.ranAt, queueGeneratedAt: report.queueGeneratedAt,
      queueCount: report.queueCount, evaluated: report.evaluated,
      alreadySubmittedSkipped: report.alreadySubmittedSkipped.length,
      distribution: report.distribution, reportFile: out,
    }, null, 2));
  } catch (e) { console.error('ERROR:', e.message); process.exit(2); }
}

module.exports = { dryRun, decide, classifyBlocker, routeOf, latestBlockers };
