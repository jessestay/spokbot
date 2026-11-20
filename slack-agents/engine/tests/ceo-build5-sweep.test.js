/**
 * CEO Build 5 tests (Oct 22, 2026 — audit F8).
 *
 * The proactivity sweep turns the charter from a document into scheduled
 * engine work. The critical contract: every sweep's header name must
 * resolve through directiveScan's DELEGATION_TARGETS to that agent —
 * the Oct 21 lesson was that a wrong header format is silently skipped
 * with no error anywhere. That is asserted against the live config here,
 * so a rename breaks tests instead of silently dead-lettering sweeps.
 */
const { AGENTS, buildSweepText, rollupLineFor, planSweeps, recordSweep } = require('../proactivitySweep');
const { DELEGATION_TARGETS } = require('../../config');

const DAY = '2026-10-22';

describe('sweep header contract', () => {
  test('every agent name resolves through DELEGATION_TARGETS to its id', () => {
    expect(DELEGATION_TARGETS).toBeDefined();
    for (const a of AGENTS) {
      const key = a.name.toLowerCase().replace(/[\s-]+/g, '');
      expect({ agent: a.id, key, resolved: DELEGATION_TARGETS[key] }).toEqual(
        { agent: a.id, key, resolved: a.id },
      );
    }
  });

  test('the roster covers all 11 agents exactly once', () => {
    const ids = AGENTS.map((a) => a.id.toLowerCase()).sort();
    expect(ids).toEqual(
      ['cco', 'cfo', 'cmo', 'cro', 'cto', 'cuxo', 'execpm', 'facebook', 'hr', 'jobcoach', 'lawyer'],
    );
    // ids use the canonical casing DELEGATION_TARGETS resolves to
    expect(AGENTS.find((a) => a.name === 'ExecPM').id).toBe('execPM');
  });
});

describe('buildSweepText', () => {
  test('starts with the exact directive header and carries the charter contract', () => {
    const text = buildSweepText(AGENTS.find((a) => a.id === 'lawyer'), DAY);
    expect(text.startsWith('[from: CEO → Lawyer]')).toBe(true);
    expect(text).toContain(DAY);
    expect(text).toContain('Vikunja');
    expect(text).toContain('[Opportunity]');
    expect(text).toContain('ticket ID');
    expect(text).toContain('search evidence');
  });

  test('each sweep names the agent’s own domain focus', () => {
    for (const a of AGENTS) {
      expect(buildSweepText(a, DAY)).toContain(a.focus);
    }
  });

  test('no sweep trips the intake scanner’s missing-artifacts dead-letter rule', () => {
    // directiveScan.js dead-letters a directive when it mentions artifact
    // words AND review words with no URL and no path. The first CRO sweep
    // died exactly this way (Oct 22, 2026). These are the scanner's own
    // regexes — if the scanner’s rule changes, this test must change too.
    const artifactKeywords = /\b(pdfs?|documents?|templates?|files?|spreadsheets?|images?|videos?|designs?|mockups?|wireframes?)\b/i;
    const reviewKeywords = /\b(review|analyze|check|verify|audit|inspect|examine|look at)\b/i;
    const hasUrl = (t) => /https?:\/\/[^\s]+/i.test(t);
    const hasPath = (t) => /(?:\/[\w.-]+)+\.\w+/.test(t) || /\b[\w-]+\.(pdf|docx?|xlsx?|png|jpe?g)\b/i.test(t);
    for (const a of AGENTS) {
      const t = buildSweepText(a, DAY);
      const trips = artifactKeywords.test(t) && reviewKeywords.test(t) && !hasUrl(t) && !hasPath(t);
      expect({ agent: a.id, trips }).toEqual({ agent: a.id, trips: false });
    }
  });
});

describe('rollupLineFor (Build 4 feedback inside the sweep)', () => {
  const rollup = {
    day: '2026-10-21',
    agents: {
      lawyer: { okCalls: 280, deliverables: 33, repliesPosted: 0 },
      cmo: { okCalls: 0, deliverables: 0, repliesPosted: 0 },
      execpm: { okCalls: 189, deliverables: 19, repliesPosted: 3 },
    },
    totals: { deliverables: 60 },
    alarms: ['cuxo'],
    silent: ['cmo'],
  };

  test('renders the agent’s numbers and the team total', () => {
    const line = rollupLineFor(rollup, 'lawyer');
    expect(line).toContain('280 successful tool calls');
    expect(line).toContain('33 deliverable(s)');
    expect(line).toContain('team produced 60 deliverables');
  });

  test('execPM casing resolves to the lowercase roll-up key, replies counted', () => {
    const line = rollupLineFor(rollup, 'execPM');
    expect(line).toContain('posted 3 directive reply(ies)');
  });

  test('silent and zero-artifact flags are called out by name', () => {
    expect(rollupLineFor(rollup, 'cmo')).toContain('SILENT');
    const r2 = { ...rollup, agents: { ...rollup.agents, cuxo: { okCalls: 5, deliverables: 0, repliesPosted: 0 } } };
    expect(rollupLineFor(r2, 'cuxo')).toContain('ZERO-ARTIFACT');
  });

  test('missing roll-up or unknown agent yields an empty line', () => {
    expect(rollupLineFor(null, 'cmo')).toBe('');
    expect(rollupLineFor(rollup, 'nobody')).toBe('');
  });

  test('buildSweepText embeds the line when provided, omits it otherwise', () => {
    const lawyer = AGENTS.find((a) => a.id === 'lawyer');
    expect(buildSweepText(lawyer, DAY, 'FEEDBACK-LINE')).toContain('FEEDBACK-LINE');
    expect(buildSweepText(lawyer, DAY)).not.toContain('FEEDBACK-LINE');
  });
});

describe('planSweeps / recordSweep', () => {
  test('fresh state: everyone is due', () => {
    expect(planSweeps({}, DAY)).toHaveLength(AGENTS.length);
    expect(planSweeps(null, DAY)).toHaveLength(AGENTS.length);
  });

  test('a recorded sweep is not re-posted the same day, and is due the next', () => {
    const s1 = recordSweep({}, 'cmo', DAY, '111.222');
    const due = planSweeps(s1, DAY);
    expect(due.find((a) => a.id === 'cmo')).toBeUndefined();
    expect(due).toHaveLength(AGENTS.length - 1);
    expect(planSweeps(s1, '2026-10-23').find((a) => a.id === 'cmo')).toBeDefined();
  });

  test('recordSweep does not mutate the previous state', () => {
    const s0 = {};
    const s1 = recordSweep(s0, 'cto', DAY, '333.444');
    expect(s0).toEqual({});
    expect(s1.cto).toMatchObject({ day: DAY, ts: '333.444' });
  });
});
