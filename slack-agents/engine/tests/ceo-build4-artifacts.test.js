/**
 * CEO Build 4 tests (Oct 22, 2026 — audit F6/F7).
 *
 * The artifact ledger must compute per-agent output from PRIMARY sources
 * (receipts + intake records), classify deliverables conservatively
 * (reads and research are activity, never artifacts), bucket days by
 * America/Denver, and flag active-but-zero-artifact and silent agents.
 */
const {
  classifyReceipt,
  denverDay,
  rollupDay,
  renderMarkdown,
} = require('../artifactLedger');

const D22 = '2026-10-22T18:00:00.000Z'; // Oct 22, 12:00 MDT
const D21LATE = '2026-10-22T05:30:00.000Z'; // Oct 21, 23:30 MDT

const rcpt = (agentId, tool, over = {}) => ({
  receiptId: 'rcpt_x', ts: D22, agentId, taskId: 100, tool,
  status: 'ok', errorClass: null, artifacts: [], ...over,
});

describe('denverDay', () => {
  test('buckets UTC timestamps by America/Denver', () => {
    expect(denverDay(D22)).toBe('2026-10-22');
    expect(denverDay(D21LATE)).toBe('2026-10-21');
    expect(denverDay('not-a-date')).toBeNull();
  });
});

describe('classifyReceipt', () => {
  test('error receipts produce no artifacts', () => {
    expect(classifyReceipt(rcpt('lawyer', 'fileWrite', {
      status: 'error', artifacts: [{ kind: 'file', ref: 'x.md' }],
    }))).toEqual([]);
  });

  test('explicit artifacts pass through', () => {
    expect(classifyReceipt(rcpt('lawyer', 'fileWrite', {
      artifacts: [{ kind: 'file', ref: 'report.md' }],
    }))).toEqual([{ kind: 'file', ref: 'report.md' }]);
  });

  test('vikunja writes with empty artifacts[] are implicit deliverables', () => {
    expect(classifyReceipt(rcpt('cmo', 'vikunjaComment', { taskId: 841 })))
      .toEqual([{ kind: 'vikunja_write', ref: 'task:841' }]);
  });

  test('reads are activity, never artifacts', () => {
    expect(classifyReceipt(rcpt('cto', 'fileList'))).toEqual([]);
    expect(classifyReceipt(rcpt('cto', 'fileRead'))).toEqual([]);
    expect(classifyReceipt(rcpt('cto', 'mcp_tavily_tavily_search'))).toEqual([]);
  });

  test('a vikunja write WITH explicit artifacts is not double-counted', () => {
    const out = classifyReceipt(rcpt('cmo', 'vikunjaAttachEvidence', {
      artifacts: [{ kind: 'file', ref: 'proof.png' }],
    }));
    expect(out).toEqual([{ kind: 'file', ref: 'proof.png' }]);
  });
});

describe('rollupDay', () => {
  const receipts = [
    // lawyer: one file deliverable, one implicit vikunja deliverable, reads, an error
    rcpt('lawyer', 'fileWrite', { taskId: 766, artifacts: [{ kind: 'file', ref: 'memo.md' }] }),
    rcpt('lawyer', 'vikunjaComment', { taskId: 766 }),
    rcpt('lawyer', 'fileList', { taskId: 766 }),
    rcpt('lawyer', 'urlCheck', { taskId: 766, status: 'error', errorClass: 'other' }),
    // cmo: activity only -> zero-artifact alarm
    rcpt('cmo', 'fileList'), rcpt('cmo', 'fileList'), rcpt('cmo', 'fileRead'),
    // execpm: verification artifact only -> still zero DELIVERABLES -> alarm
    rcpt('execPM', 'urlCheck', { artifacts: [{ kind: 'http_check', ref: 'https://x' }] }),
    // unknown agent still appears
    rcpt('newbot', 'fileWrite', { artifacts: [{ kind: 'file', ref: 'n.md' }] }),
    // wrong day (Oct 21 Denver) -> excluded from the Oct 22 roll-up
    rcpt('lawyer', 'fileWrite', { ts: D21LATE, artifacts: [{ kind: 'file', ref: 'old.md' }] }),
  ];
  const intake = [
    { agentId: 'cto', registeredAt: D22, status: 'completed', replyPostedAt: D22 },
    { agentId: 'cmo', registeredAt: D22, status: 'dead_letter' },
    { agentId: 'lawyer', registeredAt: D22, status: 'completed', replyPostedAt: D22 },
    { agentId: 'lawyer', registeredAt: D21LATE, status: 'completed', replyPostedAt: D21LATE },
  ];
  const r = rollupDay({ receipts, intakeRecords: intake, day: '2026-10-22' });

  test('per-agent deliverables come from receipts, not prose', () => {
    expect(r.agents.lawyer.deliverables).toBe(2);
    expect(r.agents.lawyer.tasksTouched).toBe(1);
    expect(r.agents.lawyer.okCalls).toBe(3);
    expect(r.agents.lawyer.errorCalls).toBe(1);
    expect(r.agents.newbot.deliverables).toBe(1);
  });

  test('directive leg: completions, replies, dead letters', () => {
    expect(r.agents.lawyer.directivesCompleted).toBe(1);
    expect(r.agents.lawyer.repliesPosted).toBe(1);
    expect(r.agents.cmo.deadLetters).toBe(1);
    expect(r.totals.deadLetters).toBe(1);
  });

  test('alarms: active-but-zero-artifact flagged; reply posters and producers are not', () => {
    expect(r.alarms).toContain('cmo');
    expect(r.alarms).toContain('execpm'); // http_check is verification, not a deliverable
    expect(r.alarms).not.toContain('lawyer');
    expect(r.alarms).not.toContain('cto'); // posted a directive reply
    expect(r.alarms).not.toContain('newbot');
  });

  test('silent: roster agents with no activity are listed, active ones are not', () => {
    expect(r.silent).toContain('hr');
    expect(r.silent).toContain('jobcoach');
    expect(r.silent).not.toContain('cto');
    expect(r.silent).not.toContain('lawyer');
  });

  test('dead letters from poll state count per agent per day (null agent = unknown)', () => {
    const r2 = rollupDay({
      receipts: [],
      intakeRecords: [],
      deadLetters: [
        { agentId: 'cro', failedAt: D22, reason: 'missing_artifacts' },
        { agentId: null, failedAt: D22, reason: 'unparseable_header' },
        { agentId: 'cmo', failedAt: D21LATE, reason: 'missing_artifacts' }, // Oct 21 Denver — excluded
      ],
      day: '2026-10-22',
    });
    expect(r2.agents.cro.deadLetters).toBe(1);
    expect(r2.agents.unknown.deadLetters).toBe(1);
    expect(r2.agents.cmo.deadLetters).toBe(0);
    expect(r2.totals.deadLetters).toBe(2);
  });

  test('case-insensitive agent ids merge (execPM == execpm)', () => {
    expect(r.agents.execpm.toolCalls).toBe(1);
    expect(r.agents.execPM).toBeUndefined();
  });

  test('totals add up', () => {
    expect(r.totals.deliverables).toBe(3);
    expect(r.totals.directivesRegistered).toBe(3);
  });
});

describe('renderMarkdown', () => {
  test('leads with alarms and includes the per-agent table', () => {
    const r = rollupDay({
      receipts: [rcpt('cmo', 'fileList')],
      intakeRecords: [],
      day: '2026-10-22',
    });
    const md = renderMarkdown(r);
    expect(md).toContain('ZERO-ARTIFACT');
    expect(md).toContain('SILENT');
    expect(md).toContain('| cmo | 1 | 1 | 0 |');
    expect(md.indexOf('ZERO-ARTIFACT')).toBeLessThan(md.indexOf('| agent |'));
  });
});
