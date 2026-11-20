'use strict';
/* Tests for engine/jobSubmitter.js (Vikunja #909) — the submission stage.
 * Covers queue ordering (Jesse's salary-first rule), the salary-figure rules,
 * per-candidate blocker logging, the confirmation-only record path, and the
 * dependency-free PDF writer. The stage must NEVER create an application
 * entry without a portal confirmation. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../jobSubmitter');
const P = require('../jobPipeline');

function tmpSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsub-'));
  fs.mkdirSync(path.join(dir, 'jobs', 'candidates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'jobs', 'applications.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'jobs', 'job-search-config.json'), JSON.stringify({
    salaryExpectationRule: 'lower-middle of the posted band',
    earliestStart: 'ASAP', travelWillingness: 'As often as needed (no cap)',
    largestBudgetManagedUSD: 2000000, semExperience: 'Since Google Ads launched (2000)',
    linkedInAds: 'Claim — since available', lifecyclePlatforms: ['GA4'], webflow: 'None',
    reportingTools: ['Looker', 'GA4', 'Adobe Analytics', 'Tableau'],
    backgroundCheckConsent: true, drugScreeningConsent: true,
    nonCompeteRestrictions: 'None', conflicts: 'None',
    eeoSelfId: { race: 'White', veteranStatus: 'Not a veteran', disabilityStatus: 'No disabilities' },
    alreadyAnsweredElsewhere: { contact: 'jesse@staynalive.com, (801) 853-8339, linkedin.com/in/facebook' },
    references: { pool: [{ name: 'Luke Kilpatrick', title: 'Developer Program Manager', org: 'Atlassian', emails: ['lkilpatrick@atlassian.com'], phones: ['(650) 745-5302'] }] },
  }));
  return dir;
}
function seedCandidate(sandbox, slug, posting, { resume = true } = {}) {
  const dir = path.join(sandbox, 'jobs', 'candidates', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'posting.json'), JSON.stringify(posting, null, 2));
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ slug, stage: 'resume_ready', company: posting.company, title: posting.title, url: posting.url, updated: new Date().toISOString() }, null, 2));
  if (resume) fs.writeFileSync(path.join(dir, 'resume.md'), '# JESSE STAY\n\n' + 'Tailored experience line. '.repeat(60));
  return dir;
}
const POST = (over) => ({ id: 'x', company: 'Acme', title: 'VP, Growth Marketing', url: 'https://www.linkedin.com/jobs/view/1/', location: 'Remote, United States', remote: true, salaryMin: 200000, salaryMax: 300000, description: 'd', ...over });

describe('buildQueue — ordering and eligibility', () => {
  test('highest listed salary first; skips no-resume and already-submitted', () => {
    const sb = tmpSandbox();
    seedCandidate(sb, 'low-band', POST({ company: 'LowCo', salaryMin: 200000, salaryMax: 250000 }));
    seedCandidate(sb, 'high-band', POST({ company: 'HighCo', salaryMin: 300000, salaryMax: 450000 }));
    seedCandidate(sb, 'no-resume', POST({ company: 'NoResumeCo', salaryMin: 400000, salaryMax: 500000 }), { resume: false });
    seedCandidate(sb, 'already-in', POST({ company: 'DoneCo', salaryMin: 350000, salaryMax: 475000 }));
    fs.writeFileSync(path.join(sb, 'jobs', 'applications.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), company: 'DoneCo', title: 'VP, Growth Marketing', confirmationRef: 'CONF-1', candidateSlug: 'already-in' }) + '\n');
    const q = S.buildQueue(sb);
    expect(q.map(e => e.slug)).toEqual(['high-band', 'low-band']);
    expect(q[0].rank).toBe(1);
    expect(q[0].salaryFigure).toBe(360000); // 300000 + 0.4*150000
  });
});

describe('salaryFigure — Jesse\'s rules', () => {
  test('lower-middle (40th percentile) of the band, rounded to 500', () => {
    expect(S.salaryFigure(POST({ salaryMin: 200000, salaryMax: 400000 }))).toBe(280000);
  });
  test('MagicSchool uses the per-posting band median', () => {
    expect(S.salaryFigure(POST({ company: 'MagicSchool AI', salaryMin: 250000, salaryMax: 275000 }))).toBe(262500);
  });
  test('no band -> null (never invented)', () => {
    expect(S.salaryFigure(POST({ salaryMin: 0, salaryMax: 0 }))).toBeNull();
  });
});

describe('dataQualityFlags', () => {
  test('flags the Ghost Growth style parse artifact', () => {
    const flags = S.dataQualityFlags(POST({ title: 'Senior Director of Paid Media: $400-$800K', salaryMin: 400, salaryMax: 800000 }));
    expect(flags.length).toBeGreaterThanOrEqual(2);
  });
  test('clean posting has no flags', () => {
    expect(S.dataQualityFlags(POST({}))).toEqual([]);
  });
});

describe('block — per-candidate blocker rule', () => {
  test('logs the blocker for that candidate only; stage untouched', () => {
    const sb = tmpSandbox();
    seedCandidate(sb, 'blocked-one', POST({ company: 'BlockCo' }));
    seedCandidate(sb, 'fine-one', POST({ company: 'FineCo' }));
    const entry = S.block(sb, 'blocked-one', 'Portal demands an account password reset Jesse must do');
    expect(entry.candidateSlug).toBe('blocked-one');
    const log = fs.readFileSync(path.join(sb, 'jobs', 'submission-blockers.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(log).toHaveLength(1);
    const st = JSON.parse(fs.readFileSync(path.join(sb, 'jobs', 'candidates', 'blocked-one', 'status.json'), 'utf8'));
    expect(st.stage).toBe('resume_ready');
    expect(st.submission.lastBlocker.reason).toMatch(/account password reset/);
    const other = JSON.parse(fs.readFileSync(path.join(sb, 'jobs', 'candidates', 'fine-one', 'status.json'), 'utf8'));
    expect(other.submission).toBeUndefined();
  });
  test('refuses an empty reason', () => {
    const sb = tmpSandbox();
    seedCandidate(sb, 'x-one', POST({}));
    expect(() => S.block(sb, 'x-one', '  ')).toThrow(/reason/);
  });
});

describe('record — confirmation-only ledger path', () => {
  test('refuses without a confirmationRef and writes nothing', () => {
    const sb = tmpSandbox();
    seedCandidate(sb, 'rec-one', POST({ company: 'RecCo' }));
    expect(() => S.record(sb, { candidateSlug: 'rec-one', company: 'RecCo', title: 'VP, Growth Marketing' })).toThrow(/confirmationRef/);
    expect(fs.readFileSync(path.join(sb, 'jobs', 'applications.jsonl'), 'utf8').trim()).toBe('');
  });
  test('records a confirmed application and flips the stage to submitted', () => {
    const sb = tmpSandbox();
    seedCandidate(sb, 'rec-two', POST({ company: 'RecCo' }));
    const entry = S.record(sb, { candidateSlug: 'rec-two', company: 'RecCo', title: 'VP, Growth Marketing', url: 'https://www.linkedin.com/jobs/view/1/', confirmationRef: 'Application submitted — confirmation #A1' });
    expect(entry.confirmationRef).toMatch(/confirmation #A1/);
    const apps = fs.readFileSync(path.join(sb, 'jobs', 'applications.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(apps).toHaveLength(1);
    const st = JSON.parse(fs.readFileSync(path.join(sb, 'jobs', 'candidates', 'rec-two', 'status.json'), 'utf8'));
    expect(st.stage).toBe('submitted');
  });
});

describe('PDF writer', () => {
  test('markdownToText strips markdown structure', () => {
    const t = S.markdownToText('# Title\n\n**Bold** and [a link](https://x.com) here');
    expect(t).not.toMatch(/#/);
    expect(t).toContain('Bold');
    expect(t).toContain('a link (https://x.com)');
  });
  test('textToPdf emits a valid, deterministic PDF', () => {
    const text = Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of the tailored resume with experience detail`).join('\n');
    const a = S.textToPdf(text), b = S.textToPdf(text);
    expect(a.slice(0, 5).toString('latin1')).toBe('%PDF-');
    expect(a.toString('latin1')).toContain('%%EOF');
    expect(a.length).toBeGreaterThan(1500);
    expect(Buffer.compare(a, b)).toBe(0);
  });
});

describe('prepare — queue + packets + top-of-queue PDF', () => {
  test('writes queue file, packets with the answer map, and a PDF', () => {
    const sb = tmpSandbox();
    seedCandidate(sb, 'prep-one', POST({ company: 'PrepCo', salaryMin: 210000, salaryMax: 310000 }));
    const summary = S.prepare({ sandbox: sb });
    expect(summary.queued).toBe(1);
    const queue = JSON.parse(fs.readFileSync(path.join(sb, 'jobs', 'submission-queue.json'), 'utf8'));
    expect(queue.entries[0].slug).toBe('prep-one');
    const packet = fs.readFileSync(path.join(sb, 'jobs', 'candidates', 'prep-one', 'submission-packet.md'), 'utf8');
    expect(packet).toContain('https://www.linkedin.com/jobs/view/1/');
    expect(packet).toContain('801-853-8339');
    expect(packet).toContain('$2,000,000');
    expect(packet).toContain('Luke Kilpatrick');
    expect(packet).toMatch(/DO NOT guess/);
    const pdf = fs.readFileSync(path.join(sb, 'jobs', 'candidates', 'prep-one', 'resume.pdf'));
    expect(pdf.slice(0, 5).toString('latin1')).toBe('%PDF-');
    // prepare must never create application entries
    expect(fs.readFileSync(path.join(sb, 'jobs', 'applications.jsonl'), 'utf8').trim()).toBe('');
  });
});
