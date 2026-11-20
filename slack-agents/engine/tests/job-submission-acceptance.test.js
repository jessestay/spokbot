'use strict';
/*
 * BDD acceptance tests for the job-submission pipeline stories
 * (Vikunja #1003 / F12 test layer, CEO build Nov 11, 2026).
 *
 * Stories covered (engine/.user-stories.json):
 *   US-111 — the team submits applications through its own execution seat
 *            (#935): AC1 the recording half (a submission counts only with a
 *            portal confirmation reference, executor seat stored), AC2 an
 *            unbanked question stops the run, is logged verbatim as a
 *            blocker, and nothing is submitted or guessed.
 *   US-112 — the applications ledger is append-only: records survive prepare
 *            / rebuild runs, stages never regress, refused writes leave the
 *            prior ledger byte-identical.
 *   US-118 — AC1: every recurring function exists in the story registry with
 *            acceptance criteria and a difficulty score.
 *
 * Scenario text mirrors each story's acceptance criteria one-to-one. All
 * writes happen in mkdtemp scratch sandboxes — the live applications.jsonl
 * and the live queue are never touched. The consumer's live-mode refusal is
 * exercised through the real CLI (child process), not just the module API,
 * because the refusal lives in the require.main guard.
 *
 * The live portal walk itself (Easy Apply in a browser) is NOT covered here:
 * no adapter exists yet (#935 step 6), so US-111 AC1 is covered up to the
 * deterministic boundary the built machinery owns — queue, answer map,
 * consumer decision, and the confirmation-only ledger write.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../jobPipeline');
const S = require('../jobSubmitter');
const R = require('../jobAnswerResolver');
const C = require('../jobConsumer');

const ENGINE_DIR = path.join(__dirname, '..');
const CONSUMER_CLI = path.join(ENGINE_DIR, 'jobConsumer.js');

/* Jesse's banked answers, shaped like jobs/job-search-config.json
 * (v2026-11-09, 26 keys) — the resolver's single source. */
const BANKED = {
  salaryExpectationRule: 'lower-middle of the posted band',
  earliestStart: 'ASAP',
  travelWillingness: 'As often as needed (no cap)',
  largestBudgetManagedUSD: 2000000,
  teamManagementYears: 10,
  semExperience: 'Since Google Ads launched (2000)',
  linkedInAds: 'Claim — since available',
  scaledMetaSpend: true,
  lifecyclePlatforms: ['GA4'],
  webflow: 'None',
  reportingTools: ['Looker', 'GA4', 'Adobe Analytics', 'Tableau'],
  backgroundCheckConsent: true,
  drugScreeningConsent: true,
  nonCompeteRestrictions: 'None',
  conflicts: 'None',
  fields: { notice_period_days: 0, performance_marketing_years: 15, ai_leadership_years: 5 },
  eeoSelfId: { race: 'White', veteranStatus: 'Not a veteran', disabilityStatus: 'No disabilities' },
  alreadyAnsweredElsewhere: {
    contact: 'jesse@staynalive.com, (801) 853-8339, linkedin.com/in/facebook',
    location: 'St. George, UT',
    workAuthorization: 'US citizen, authorized to work in the US, no sponsorship required',
    education: 'B.S. Computer Information Systems, Strayer University, 2005, Summa Cum Laude',
    languages: 'English native; Thai semi-fluent',
  },
  references: { pool: [{ name: 'Luke Kilpatrick', title: 'Developer Program Manager', org: 'Atlassian', emails: ['lkilpatrick@atlassian.com'], phones: [] }] },
};

function tmpSandbox(config = BANKED) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobacc-'));
  fs.mkdirSync(path.join(dir, 'jobs', 'candidates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'jobs', 'applications.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'jobs', 'job-search-config.json'), JSON.stringify(config));
  return dir;
}
function seedCandidate(sandbox, slug, posting, { resumePdf = false } = {}) {
  const dir = path.join(sandbox, 'jobs', 'candidates', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'posting.json'), JSON.stringify(posting, null, 2));
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ slug, stage: 'resume_ready', company: posting.company, title: posting.title, url: posting.url, updated: new Date().toISOString() }, null, 2));
  fs.writeFileSync(path.join(dir, 'resume.md'), '# JESSE STAY\n\n' + 'Tailored experience line. '.repeat(60));
  if (resumePdf) fs.writeFileSync(path.join(dir, 'resume.pdf'), S.textToPdf('Jesse Stay\nTailored resume.'));
  return dir;
}
const POST = (over) => ({
  id: 'x', company: 'Acme', title: 'VP, Growth Marketing',
  url: 'https://www.linkedin.com/jobs/view/1/', location: 'Remote, United States',
  remote: true, salaryMin: 200000, salaryMax: 300000, description: 'd', ...over,
});
const ENTRY = (over) => ({
  rank: 1, slug: 'acme-vp-growth-marketing', company: 'Acme', title: 'VP, Growth Marketing',
  url: 'https://www.linkedin.com/jobs/view/1/', salaryFigure: 240000, dataQualityFlags: [], ...over,
});
function readApps(sandbox) {
  const f = path.join(sandbox, 'jobs', 'applications.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

describe('US-111 AC2 — an unbanked question stops the run and is never guessed', () => {
  test('Given an empty answer bank, When answers are resolved, Then every blocking field is reported uncovered and no salary figure is invented', () => {
    const { answers, uncovered } = R.resolveAnswers({}, { slug: 'x' });
    const fields = uncovered.map(u => u.field);
    for (const f of ['workAuthorization', 'education', 'salaryFigure', 'earliestStart', 'largestBudgetManagedUSD', 'teamManagementYears', 'backgroundCheckConsent', 'drugScreeningConsent']) {
      expect(fields).toContain(f);
    }
    expect(answers.salaryFigure).toBeNull();
    expect(answers.workAuthorization).toBeNull();
  });

  test('Given a banked answer for every field and a captured band, When answers are resolved, Then nothing is uncovered and the banked values pass through verbatim', () => {
    const { answers, uncovered } = R.resolveAnswers(BANKED, ENTRY());
    expect(uncovered).toEqual([]);
    expect(answers.workAuthorization).toMatch(/US citizen/);
    expect(answers.earliestStart).toBe('ASAP');
    expect(answers.largestBudgetManagedUSD).toBe(2000000);
    expect(answers.teamManagementYears).toBe(10);
    expect(answers.salaryFigure).toBe(240000);
    expect(answers.backgroundCheckConsent).toBe(true);
  });

  test('Given a posting with no captured salary band, When answers are resolved, Then salaryFigure is uncovered with a never-invent reason', () => {
    const { answers, uncovered } = R.resolveAnswers(BANKED, ENTRY({ salaryFigure: null }));
    expect(answers.salaryFigure).toBeNull();
    const gap = uncovered.find(u => u.field === 'salaryFigure');
    expect(gap).toBeTruthy();
    expect(gap.reason).toMatch(/never invent a number/);
  });

  test('Given voluntary self-ID Jesse deliberately left unbanked, When answers are resolved, Then gender and Hispanic/Latino are voluntary-uncovered and never appear as answers', () => {
    const { answers, voluntaryUncovered } = R.resolveAnswers(BANKED, ENTRY());
    expect(voluntaryUncovered.map(u => u.field)).toEqual(['eeoSelfId.gender', 'eeoSelfId.hispanicLatino']);
    expect(answers.eeoSelfId.gender).toBeUndefined();
    expect(answers.eeoSelfId.hispanicLatino).toBeUndefined();
    expect(answers.eeoSelfId.race).toBe('White');
  });

  test('Given a prior portal attempt blocked on an uncovered question, When the consumer decides, Then it blocks as unbanked-questions with the verbatim question in a block()-shaped payload and submits nothing', () => {
    const sb = tmpSandbox();
    seedCandidate(sb, 'acme-vp-growth-marketing', POST({}), { resumePdf: true });
    const question = 'How many years of DaaS experience do you have?';
    fs.writeFileSync(path.join(sb, 'jobs', 'submission-blockers.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), candidateSlug: 'acme-vp-growth-marketing', company: 'Acme', title: 'VP, Growth Marketing', reason: `Uncovered required question: ${question}` }) + '\n');
    const d = C.decide(ENTRY(), { config: BANKED, blockers: C.latestBlockers(sb), sandbox: sb });
    expect(d.decision).toBe('blocked-on-unbanked-questions');
    expect(d.detail).toContain(question);
    expect(d.wouldBlock).toEqual({
      candidateSlug: 'acme-vp-growth-marketing', company: 'Acme', title: 'VP, Growth Marketing',
      reason: `blocked-on-unbanked-questions: ${question}`,
    });
    expect(readApps(sb)).toBe('');
  });

  test('Given a fully covered candidate, When the consumer decides, Then it is would-submit; a missing resume.pdf or an uncovered salary blocks instead', () => {
    const sb = tmpSandbox();
    seedCandidate(sb, 'acme-vp-growth-marketing', POST({}), { resumePdf: true });
    const ok = C.decide(ENTRY(), { config: BANKED, blockers: new Map(), sandbox: sb });
    expect(ok.decision).toBe('would-submit');
    expect(ok.answersCovered).toBeGreaterThan(20);

    const noPdf = C.decide(ENTRY({ slug: 'ghost-coo' }), { config: BANKED, blockers: new Map(), sandbox: sb });
    expect(noPdf.decision).toBe('blocked-on-missing-resume-pdf');

    const noSalary = C.decide(ENTRY({ salaryFigure: null }), { config: BANKED, blockers: new Map(), sandbox: sb });
    expect(noSalary.decision).toBe('blocked-on-uncovered-salaryFigure');
  });

  test('Given blocker reasons from real portal attempts, When classified, Then dead postings, non-Easy-Apply routes, and unbanked questions land in distinct classes', () => {
    expect(C.classifyBlocker('Posting closed: No longer accepting applications (screened)').decision).toBe('blocked-on-dead-posting');
    expect(C.classifyBlocker('Not Easy Apply — routes to the company ATS').decision).toBe('blocked-on-not-easy-apply');
    expect(C.classifyBlocker('Uncovered skill battery: six Y/N questions').decision).toBe('blocked-on-unbanked-questions');
  });
});

describe('US-111 safety gate — the consumer has no live mode in this build', () => {
  function runCli(args, sandbox) {
    return spawnSync(process.execPath, [CONSUMER_CLI, ...args], {
      env: { ...process.env, MACF_SANDBOX_DIR: sandbox }, encoding: 'utf8', timeout: 30000,
    });
  }

  test('Given the consumer invoked without --dry-run, When it starts, Then it refuses with exit code 2 and submits nothing', () => {
    const sb = tmpSandbox();
    const r = runCli([], sb);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/REFUSED: jobConsumer has no live mode/);
    expect(readApps(sb)).toBe('');
  });

  test('Given the consumer invoked with other flags but no --dry-run, When it starts, Then it still refuses with exit code 2', () => {
    const sb = tmpSandbox();
    const r = runCli(['--limit', '5'], sb);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/REFUSED/);
  });

  test('Given --dry-run against a scratch queue, When it runs, Then it exits 0, writes only its report, and the sandbox ledger, blockers, and queue are byte-identical afterwards', () => {
    const sb = tmpSandbox();
    seedCandidate(sb, 'acme-vp-growth-marketing', POST({}), { resumePdf: true });
    seedCandidate(sb, 'done-co-vp', POST({ company: 'DoneCo' }), { resumePdf: true });
    fs.writeFileSync(path.join(sb, 'jobs', 'applications.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), company: 'DoneCo', title: 'VP, Growth Marketing', confirmationRef: 'CONF-9', candidateSlug: 'done-co-vp', executor: 'team:jobcoach' }) + '\n');
    const queueFile = path.join(sb, 'jobs', 'submission-queue.json');
    fs.writeFileSync(queueFile, JSON.stringify({
      generatedAt: new Date().toISOString(), count: 2,
      entries: [ENTRY(), ENTRY({ rank: 2, slug: 'done-co-vp', company: 'DoneCo' })],
    }, null, 2));
    const appsBefore = readApps(sb);
    const queueBefore = fs.readFileSync(queueFile, 'utf8');
    const out = path.join(sb, 'consumer-report.json');
    const r = runCli(['--dry-run', '--out', out], sb);
    expect(r.status).toBe(0);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(report.mode).toMatch(/DRY-RUN/);
    // the already-submitted candidate is skipped, never re-decided
    expect(report.alreadySubmittedSkipped).toEqual(['done-co-vp']);
    expect(report.evaluated).toBe(1);
    expect(report.decisions[0].decision).toBe('would-submit');
    // dry-run wrote nothing to the sandbox
    expect(readApps(sb)).toBe(appsBefore);
    expect(fs.readFileSync(queueFile, 'utf8')).toBe(queueBefore);
    expect(fs.existsSync(path.join(sb, 'jobs', 'submission-blockers.jsonl'))).toBe(false);
  });
});

describe('US-111 AC1 + US-112 — the ledger records only portal confirmations, with the executor seat, and never loses them', () => {
  test('Given a portal confirmation recorded by the team seat, When the ledger is read, Then the entry stores executor team:jobcoach and the verbatim confirmationRef', () => {
    const sb = tmpSandbox();
    const e = P.recordApplication(sb, {
      company: 'Acme', title: 'VP, Growth Marketing', candidateSlug: 'acme-vp-growth-marketing',
      confirmationRef: 'Application submitted — confirmation #A1', executor: 'team:jobcoach',
    });
    expect(e.executor).toBe('team:jobcoach');
    const lines = readApps(sb).trim().split('\n').map(JSON.parse);
    expect(lines).toHaveLength(1);
    expect(lines[0].executor).toBe('team:jobcoach');
    expect(lines[0].confirmationRef).toBe('Application submitted — confirmation #A1');
  });

  test('Given a caller that omits the executor, When the entry is recorded, Then executor lands as null (reported as unspecified), never invented', () => {
    const sb = tmpSandbox();
    const e = P.recordApplication(sb, { company: 'Acme', title: 'VP, Growth Marketing', confirmationRef: 'CONF-2' });
    expect(e.executor).toBeNull();
  });

  test('Given a whitespace-only confirmationRef, When recording is attempted, Then it throws and the prior ledger stays byte-identical (US-112 AC2)', () => {
    const sb = tmpSandbox();
    P.recordApplication(sb, { company: 'Acme', title: 'VP, Growth Marketing', confirmationRef: 'CONF-1', executor: 'ceo:operator' });
    const before = readApps(sb);
    expect(() => P.recordApplication(sb, { company: 'Acme', title: 'VP, Growth Marketing', confirmationRef: '   ' })).toThrow(/confirmationRef/);
    expect(readApps(sb)).toBe(before);
  });

  test('Given a recorded submission, When prepare() rebuilds the queue and stages refresh, Then the record remains and its stage stays submitted (US-112 AC1)', () => {
    const sb = tmpSandbox();
    seedCandidate(sb, 'acme-vp-growth-marketing', POST({}));
    S.record(sb, {
      candidateSlug: 'acme-vp-growth-marketing', company: 'Acme', title: 'VP, Growth Marketing',
      url: POST({}).url, confirmationRef: 'CONF-77', executor: 'team:jobcoach',
    });
    const appsBefore = readApps(sb);
    S.prepare({ sandbox: sb });
    P.refreshStages(sb);
    expect(readApps(sb)).toBe(appsBefore);
    const st = JSON.parse(fs.readFileSync(path.join(sb, 'jobs', 'candidates', 'acme-vp-growth-marketing', 'status.json'), 'utf8'));
    expect(st.stage).toBe('submitted');
    const queue = JSON.parse(fs.readFileSync(path.join(sb, 'jobs', 'submission-queue.json'), 'utf8'));
    expect(queue.entries.map(e => e.slug)).not.toContain('acme-vp-growth-marketing');
  });

  test('Given two recorded submissions, When the second is appended, Then the first record\'s bytes are an untouched prefix of the ledger (append-only)', () => {
    const sb = tmpSandbox();
    P.recordApplication(sb, { company: 'Acme', title: 'VP, Growth Marketing', confirmationRef: 'CONF-1' });
    const afterFirst = readApps(sb);
    P.recordApplication(sb, { company: 'Beta', title: 'Director, Brand', confirmationRef: 'CONF-2' });
    const afterSecond = readApps(sb);
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    expect(afterSecond.trim().split('\n')).toHaveLength(2);
  });
});

describe('US-111 queue integrity — dead postings are pruned, other blockers keep their seat', () => {
  test('Given a candidate block-logged as a closed posting, When the queue is built, Then it is pruned and counted in prunedDead', () => {
    const sb = tmpSandbox();
    seedCandidate(sb, 'dead-co-vp', POST({ company: 'DeadCo' }));
    seedCandidate(sb, 'live-co-vp', POST({ company: 'LiveCo' }));
    S.block(sb, 'dead-co-vp', 'Posting closed: No longer accepting applications (verified on the portal)');
    const { entries, prunedDead } = S.buildQueueDetailed(sb);
    expect(prunedDead).toBe(1);
    expect(entries.map(e => e.slug)).toEqual(['live-co-vp']);
  });

  test('Given a candidate blocked on an unbanked question, When the queue is built, Then it keeps its queue seat — the blocker stops the application, not the seat', () => {
    const sb = tmpSandbox();
    seedCandidate(sb, 'acme-vp-growth-marketing', POST({}));
    S.block(sb, 'acme-vp-growth-marketing', 'Uncovered required question: How many years of DaaS experience do you have?');
    const { entries, prunedDead } = S.buildQueueDetailed(sb);
    expect(prunedDead).toBe(0);
    expect(entries.map(e => e.slug)).toEqual(['acme-vp-growth-marketing']);
  });

  test('Given the real blocker log phrasings, When dead slugs are computed, Then only the dead classes match', () => {
    const sb = tmpSandbox();
    fs.writeFileSync(path.join(sb, 'jobs', 'submission-blockers.jsonl'), [
      { candidateSlug: 'a', reason: 'Posting removed: LinkedIn reports job id invalid or posting removed' },
      { candidateSlug: 'b', reason: 'Posting closed (screened Nov 2, 2026)' },
      { candidateSlug: 'c', reason: 'Uncovered required question: bespoke essay' },
      { candidateSlug: 'd', reason: 'Not Easy Apply — routes to Workday' },
    ].map(o => JSON.stringify({ ts: new Date().toISOString(), company: 'X', title: 'Y', ...o })).join('\n') + '\n');
    expect([...S.deadPostingSlugs(sb)].sort()).toEqual(['a', 'b']);
  });
});

describe('#935 G2 — PDF coverage counts only %PDF-verified files', () => {
  // The coverage measure the #935 build was verified against: a queued
  // candidate counts as covered only when resume.pdf exists AND its first
  // bytes are the %PDF- magic — a stub or a text file never counts.
  function verifiedPdfCount(sandbox, slugs) {
    let n = 0;
    for (const slug of slugs) {
      const f = path.join(sandbox, 'jobs', 'candidates', slug, 'resume.pdf');
      if (!fs.existsSync(f)) continue;
      const buf = fs.readFileSync(f);
      if (buf.slice(0, 5).toString('latin1') === '%PDF-' && buf.toString('latin1').includes('%%EOF')) n++;
    }
    return n;
  }

  test('Given a queue of candidates with markdown resumes, When prepare() runs with no PDF cap, Then coverage is N/N %PDF-verified', () => {
    const sb = tmpSandbox();
    seedCandidate(sb, 'one-co-vp', POST({ company: 'OneCo' }));
    seedCandidate(sb, 'two-co-vp', POST({ company: 'TwoCo' }));
    seedCandidate(sb, 'three-co-vp', POST({ company: 'ThreeCo' }));
    const summary = S.prepare({ sandbox: sb });
    expect(summary.queued).toBe(3);
    expect(summary.pdfsGenerated).toBe(3);
    expect(verifiedPdfCount(sb, ['one-co-vp', 'two-co-vp', 'three-co-vp'])).toBe(3);
  });

  test('Given a resume.pdf that is a plain-text stub, When coverage is counted, Then it does not count — only generated PDFs verify', () => {
    const sb = tmpSandbox();
    const dir = seedCandidate(sb, 'stub-co-vp', POST({ company: 'StubCo' }));
    fs.writeFileSync(path.join(dir, 'resume.pdf'), 'this is not a pdf');
    seedCandidate(sb, 'real-co-vp', POST({ company: 'RealCo' }));
    S.prepare({ sandbox: sb });
    expect(verifiedPdfCount(sb, ['stub-co-vp', 'real-co-vp'])).toBe(1);
    expect(verifiedPdfCount(sb, ['real-co-vp'])).toBe(1);
  });

  test('Given a candidate folder with no resume.md, When a PDF is requested, Then none is fabricated', () => {
    const sb = tmpSandbox();
    const dir = path.join(sb, 'jobs', 'candidates', 'empty-co-vp');
    fs.mkdirSync(dir, { recursive: true });
    expect(S.generatePdf(sb, 'empty-co-vp')).toBeNull();
    expect(fs.existsSync(path.join(dir, 'resume.pdf'))).toBe(false);
  });
});

describe('US-118 AC1 — every recurring function exists as a story with criteria and a difficulty score', () => {
  test('Given the story registry, When it is audited, Then US-110 through US-123 each exist with acceptance criteria and story points', () => {
    const registry = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, '.user-stories.json'), 'utf8'));
    const byId = new Map(registry.stories.map(s => [s.id, s]));
    for (let n = 110; n <= 123; n++) {
      const s = byId.get(`US-${n}`);
      expect(s).toBeTruthy();
      expect(Array.isArray(s.acceptance_criteria) && s.acceptance_criteria.length).toBeGreaterThan(0);
      expect(typeof s.story_points).toBe('number');
    }
  });
});
