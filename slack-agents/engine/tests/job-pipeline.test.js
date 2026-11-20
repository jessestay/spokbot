'use strict';
/* Tests for engine/jobPipeline.js (CEO Build J1).
 * Includes an end-to-end run() test — the outcome-audit TDZ bug (Oct 26, 2026)
 * proved helper-only tests miss assembly-path crashes. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../jobPipeline');

function tmpSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpipe-'));
  fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
  return dir;
}
function seedInbox(sandbox, alerts) {
  fs.writeFileSync(path.join(sandbox, 'jobs', 'alerts-inbox.jsonl'),
    alerts.map(a => JSON.stringify(a)).join('\n') + '\n');
}

const GOOD = {
  id: 'a1', company: 'MagicSchool AI', title: 'Director, Digital Marketing',
  url: 'https://builtin.com/job/director-digital-marketing/11692186',
  location: 'Remote, United States', remote: true, salaryMin: 250000, salaryMax: 275000,
  description: 'Own performance marketing across teacher acquisition and district demand gen.',
};

describe('scoreAlert — Jesse\u2019s standing rules', () => {
  test('qualifies a remote $250K Director of Digital Marketing', () => {
    expect(P.scoreAlert(GOOD).qualifies).toBe(true);
  });
  test('rejects below-floor salary band', () => {
    const r = P.scoreAlert({ ...GOOD, salaryMin: 90000, salaryMax: 120000 });
    expect(r.qualifies).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/below floor/);
  });
  test('rejects sub-Director seniority', () => {
    expect(P.scoreAlert({ ...GOOD, title: 'Marketing Coordinator' }).qualifies).toBe(false);
  });
  test('rejects non-remote on-site role', () => {
    expect(P.scoreAlert({ ...GOOD, remote: false, location: 'On-site, Austin TX' }).qualifies).toBe(false);
  });
  test('Utah-local role counts (location rule widened Oct 28, 2026)', () => {
    expect(P.scoreAlert({ ...GOOD, remote: false, location: 'Lehi, UT' }).qualifies).toBe(true);
    expect(P.scoreAlert({ ...GOOD, remote: false, location: 'Salt Lake City, Utah' }).qualifies).toBe(true);
  });
  test('Salt Lake City metro label counts as Utah-local', () => {
    expect(P.scoreAlert({ ...GOOD, remote: false, location: 'Salt Lake City Metropolitan Area' }).qualifies).toBe(true);
  });
  test('hybrid role counts (location rule widened Oct 28, 2026)', () => {
    expect(P.scoreAlert({ ...GOOD, remote: false, location: 'Hybrid - New York, NY' }).qualifies).toBe(true);
  });
  test('rejects out-of-domain role', () => {
    expect(P.scoreAlert({ ...GOOD, title: 'Director of Facilities', description: 'Own building maintenance.' }).qualifies).toBe(false);
  });
  test('unstated salary does not disqualify', () => {
    const a = { ...GOOD }; delete a.salaryMin; delete a.salaryMax;
    expect(P.scoreAlert(a).qualifies).toBe(true);
  });
});

describe('pipeline state machine (end-to-end run)', () => {
  test('ingest creates a candidate with a tailoring packet; dupes are skipped', () => {
    const sb = tmpSandbox();
    seedInbox(sb, [GOOD, GOOD, { ...GOOD, id: 'a2', title: 'Marketing Coordinator', url: 'https://builtin.com/job/marketing-coordinator/999' }]);
    const s1 = P.run({ sandbox: sb, state: sb });
    expect(s1.ingest.created).toBe(1);
    expect(s1.ingest.dupes).toBe(1);
    expect(s1.ingest.rejected).toBe(1);
    const dir = path.join(sb, 'jobs', 'candidates', 'magicschool-ai-director-digital-marketing');
    expect(fs.existsSync(path.join(dir, 'posting.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'resume-input.md'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')).stage).toBe('ready_for_tailoring');
    const s2 = P.run({ sandbox: sb, state: sb });
    expect(s2.ingest.created).toBe(0);
    expect(s2.ingest.dupes).toBe(2);
  });

  test('a resume artifact on disk flips the stage to resume_ready', () => {
    const sb = tmpSandbox();
    seedInbox(sb, [GOOD]);
    P.run({ sandbox: sb, state: sb });
    const dir = path.join(sb, 'jobs', 'candidates', 'magicschool-ai-director-digital-marketing');
    fs.writeFileSync(path.join(dir, 'resume.pdf'), '%PDF-1.4\n' + '% tailored resume content. '.repeat(40));
    const s = P.run({ sandbox: sb, state: sb });
    expect(s.byStage.resume_ready).toBe(1);
  });

  test('recordApplication refuses unconfirmed entries and records confirmed ones', () => {
    const sb = tmpSandbox();
    seedInbox(sb, [GOOD]);
    P.run({ sandbox: sb, state: sb });
    expect(() => P.recordApplication(sb, { company: 'X', title: 'Director, Growth' }))
      .toThrow(/confirmationRef/);
    const slug = 'magicschool-ai-director-digital-marketing';
    const e = P.recordApplication(sb, {
      company: 'MagicSchool AI', title: 'Director, Digital Marketing',
      confirmationRef: 'portal-123', candidateSlug: slug,
    });
    expect(e.confirmationRef).toBe('portal-123');
    const s = P.run({ sandbox: sb, state: sb });
    expect(s.applicationsConfirmed).toBe(1);
    expect(s.byStage.submitted).toBe(1);
  });

  test('run() writes the human-readable board and machine state', () => {
    const sb = tmpSandbox();
    seedInbox(sb, [GOOD]);
    P.run({ sandbox: sb, state: sb });
    expect(fs.existsSync(path.join(sb, 'jobs', 'pipeline-status.md'))).toBe(true);
    const st = JSON.parse(fs.readFileSync(path.join(sb, 'job-pipeline.json'), 'utf8'));
    expect(st.candidates.length).toBe(1);
  });
});

describe('outcome-level guards (Oct 28, 2026)', () => {
  test('EMPTY alerts inbox produces a visible alarm, not a silent success', () => {
    const sb = tmpSandbox(); // no inbox file at all
    const s = P.run({ sandbox: sb, state: sb });
    expect(s.candidates).toBe(0);
    expect(s.alarm).toMatch(/EMPTY_INBOX/);
    const board = fs.readFileSync(path.join(sb, 'jobs', 'pipeline-status.md'), 'utf8');
    expect(board).toMatch(/ALARM:/);
    const st = JSON.parse(fs.readFileSync(path.join(sb, 'job-pipeline.json'), 'utf8'));
    expect(st.summary.alarm).toMatch(/EMPTY_INBOX/);
  });

  test('an empty (zero-byte) inbox file also alarms', () => {
    const sb = tmpSandbox();
    fs.writeFileSync(path.join(sb, 'jobs', 'alerts-inbox.jsonl'), '');
    const s = P.run({ sandbox: sb, state: sb });
    expect(s.alarm).toMatch(/EMPTY_INBOX/);
  });

  test('a fed pipeline carries no alarm', () => {
    const sb = tmpSandbox();
    seedInbox(sb, [GOOD]);
    const s = P.run({ sandbox: sb, state: sb });
    expect(s.alarm).toBeNull();
  });

  test('resume_ready requires a real resume file (>500 bytes), not a stub or the tailoring packet', () => {
    const sb = tmpSandbox();
    seedInbox(sb, [GOOD]);
    P.run({ sandbox: sb, state: sb });
    const dir = path.join(sb, 'jobs', 'candidates', 'magicschool-ai-director-digital-marketing');
    let s = P.run({ sandbox: sb, state: sb });
    expect(s.byStage.resume_ready || 0).toBe(0);
    expect(s.byStage.ready_for_tailoring).toBe(1);
    fs.writeFileSync(path.join(dir, 'resume.pdf'), '%PDF-fake');
    s = P.run({ sandbox: sb, state: sb });
    expect(s.byStage.resume_ready || 0).toBe(0);
    fs.writeFileSync(path.join(dir, 'resume.pdf'), '%PDF-1.4\n' + '% tailored resume content. '.repeat(40));
    s = P.run({ sandbox: sb, state: sb });
    expect(s.byStage.resume_ready).toBe(1);
  });

  test('ingest dedupe: the same alert ingested twice yields one candidate', () => {
    const sb = tmpSandbox();
    seedInbox(sb, [GOOD]);
    const s1 = P.run({ sandbox: sb, state: sb });
    expect(s1.ingest.created).toBe(1);
    fs.appendFileSync(path.join(sb, 'jobs', 'alerts-inbox.jsonl'), JSON.stringify(GOOD) + '\n');
    const s2 = P.run({ sandbox: sb, state: sb });
    expect(s2.ingest.created).toBe(0);
    expect(s2.ingest.dupes).toBeGreaterThanOrEqual(1);
    expect(s2.candidates).toBe(1);
  });

  test('a candidate cannot reach submitted without a confirmationRef', () => {
    const sb = tmpSandbox();
    seedInbox(sb, [GOOD]);
    P.run({ sandbox: sb, state: sb });
    const dir = path.join(sb, 'jobs', 'candidates', 'magicschool-ai-director-digital-marketing');
    fs.writeFileSync(path.join(dir, 'resume.pdf'), '%PDF-1.4\n' + '% tailored resume content. '.repeat(40));
    const s = P.run({ sandbox: sb, state: sb });
    expect(s.byStage.resume_ready).toBe(1);
    expect(s.byStage.submitted || 0).toBe(0);
    expect(s.applicationsConfirmed).toBe(0);
    expect(() => P.recordApplication(sb, { company: 'MagicSchool AI', title: 'Director, Digital Marketing', candidateSlug: 'magicschool-ai-director-digital-marketing' }))
      .toThrow(/confirmationRef/);
  });
});
