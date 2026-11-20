// kernel-p3-content-batch-r4.test.js — #925 round 4 (Nov 2, 2026).
//
// Round 3 shipped the directive-carried MACF-CONTRACT merge, but proof
// showed it INERT in production: Slack HTML-escapes posted message text,
// so the registered directive carries &lt;!-- MACF-CONTRACT and
// taskContract.parseContract's literal marker regex never matches — the
// gate verdicts came from prose-derived file_exists only. Round 3 also
// starved on the 6-round generateWithTools default, and its attempt-2
// directive (~4404 chars) was split by Slack at ~4013 chars, losing the
// contract tail. Round 4: (1) derivePostconditions parses an
// entity-unescaped COPY of the text (parseContract itself untouched);
// (2) the contract declares params.maxToolRounds=16 and cco honors it;
// (3) the trigger renders the contract single-line, tightens the prose
// (STEP 2 capped at 2 tavily searches), and hard-fails over 3900 chars.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'macf-cb4-'));
process.env.MACF_STATE_DIR = TMP;

const { derivePostconditions, verifyPostconditions } = require('../directivePostconditions');
const { parseContract, unescapeEntities, directiveToolRounds, normalizeContract } = require('../taskContract');
const { buildDirectiveText, MAX_DIRECTIVE_CHARS } = require('../contentBatchTrigger');
const { SANDBOX } = require('../../utils/agentTools');

const BATCH = 'content/weekly-batch-2026-11-02.json';
const PROBE = 'content/weekly-batch-2099-01-04.json';

function compactBlock(contract) {
  return `<!-- MACF-CONTRACT ${JSON.stringify(normalizeContract(contract))} MACF-CONTRACT -->`;
}
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function makeContract(batchPath, extra) {
  return {
    taskId: null,
    executor: null,
    requiredTools: [{ tool: 'fileWrite', minSuccess: 1 }],
    postconditions: [
      { type: 'file_exists', path: batchPath, minBytes: 200 },
      { type: 'json_array_min', path: batchPath, field: 'drafts', min: 3 },
    ],
    deliverable: { schema: 'generic@v1' },
    params: { maxToolRounds: 16 },
    maxAttempts: 3,
    ...(extra || {}),
  };
}
function escapedDirective(batchPath) {
  const raw = `[from: CEO → CCO] WEEKLY CONTENT BATCH. Write the file ${batchPath} incrementally.\n\n${compactBlock(makeContract(batchPath))}`;
  return escapeHtml(raw);
}

describe('#925 round 4 — entity escaping (fix 2)', () => {
  test('raw escaped text does NOT parse directly — the round-3 production defect', () => {
    expect(parseContract(escapedDirective(BATCH))).toBeNull();
  });

  test('derivePostconditions on Slack-escaped text merges file_exists(minBytes) + json_array_min drafts>=3', () => {
    const pcs = derivePostconditions(escapedDirective(BATCH));
    const fe = pcs.filter(p => p.type === 'file_exists' && p.path === BATCH);
    expect(fe).toHaveLength(1);
    expect(fe[0].minBytes).toBe(200);
    expect(pcs.filter(p => p.type === 'json_array_min')).toEqual([
      { type: 'json_array_min', path: BATCH, field: 'drafts', min: 3 },
    ]);
  });

  test('unescaped text still merges identically (Vikunja path unaffected)', () => {
    const raw = `[from: CEO → CCO] WEEKLY CONTENT BATCH. Write the file ${BATCH}.\n\n${compactBlock(makeContract(BATCH))}`;
    const pcs = derivePostconditions(raw);
    expect(pcs.filter(p => p.type === 'json_array_min')).toHaveLength(1);
    expect(pcs.filter(p => p.type === 'file_exists' && p.path === BATCH)[0].minBytes).toBe(200);
  });

  test('unescapeEntities decodes exactly once (&amp; replaced last)', () => {
    expect(unescapeEntities('&lt;!-- MACF-CONTRACT --&gt;')).toBe('<!-- MACF-CONTRACT -->');
    expect(unescapeEntities('&amp;lt;')).toBe('&lt;');
    expect(unescapeEntities('&quot;x&quot;')).toBe('"x"');
    expect(unescapeEntities(null)).toBeNull();
  });
});

describe('#925 round 4 — json_array_min actually enforces from an escaped directive', () => {
  const probeAbs = path.join(SANDBOX, PROBE);
  const pcs = derivePostconditions(escapedDirective(PROBE));
  const draft = (n) => ({ label: String(n), platform: 'LinkedIn', hook: `hook ${n}`, body: 'x'.repeat(120), gate_scores: { r1: 5, r2: 5, r3: 5, r4: 5, r5: 5, r6: 5 } });
  function writeProbe(drafts) {
    fs.mkdirSync(path.dirname(probeAbs), { recursive: true });
    fs.writeFileSync(probeAbs, JSON.stringify({ week_of: '2099-01-04', drafts }), 'utf8');
  }
  afterAll(() => { try { fs.unlinkSync(probeAbs); } catch { /* ignore */ } });

  test('derived set carries the drafts>=3 requirement', () => {
    expect(pcs.filter(p => p.type === 'json_array_min')).toEqual([
      { type: 'json_array_min', path: PROBE, field: 'drafts', min: 3 },
    ]);
  });

  test('2 drafts: gate refuses (json_array_min unsatisfied)', () => {
    writeProbe([draft(1), draft(2)]);
    const v = verifyPostconditions(pcs, { taskId: null });
    expect(v.allSatisfied).toBe(false);
    expect(v.results.find(r => r.type === 'json_array_min').satisfied).toBe(false);
    expect(v.results.find(r => r.type === 'json_array_min').observed.count).toBe(2);
  });

  test('3 drafts: gate satisfied on both contract postconditions', () => {
    writeProbe([draft(1), draft(2), draft(3)]);
    const v = verifyPostconditions(pcs, { taskId: null });
    expect(v.allSatisfied).toBe(true);
    expect(v.results.find(r => r.type === 'json_array_min').observed.count).toBe(3);
  });

  test('missing file: gate refuses', () => {
    try { fs.unlinkSync(probeAbs); } catch { /* ignore */ }
    const v = verifyPostconditions(pcs, { taskId: null });
    expect(v.allSatisfied).toBe(false);
  });
});

describe('#925 round 4 — round budget (fix 1)', () => {
  test('directiveToolRounds reads params.maxToolRounds from escaped text', () => {
    expect(directiveToolRounds(escapedDirective(BATCH))).toBe(16);
  });
  test('directiveToolRounds reads it from raw text too', () => {
    const raw = `do the thing\n\n${compactBlock(makeContract(BATCH))}`;
    expect(directiveToolRounds(raw)).toBe(16);
  });
  test('no contract / no param -> null (caller keeps the default)', () => {
    expect(directiveToolRounds('a plain directive with no contract')).toBeNull();
    const noParams = makeContract(BATCH); delete noParams.params;
    expect(directiveToolRounds(compactBlock(noParams))).toBeNull();
  });
  test('absurd budgets are clamped to 32', () => {
    const c = makeContract(BATCH); c.params = { maxToolRounds: 500 };
    expect(directiveToolRounds(compactBlock(c))).toBe(32);
  });
});

describe('#925 round 4 — trigger length discipline (fix 3)', () => {
  const text = buildDirectiveText('2026-11-02');

  test('composed directive fits under the hard cap', () => {
    expect(MAX_DIRECTIVE_CHARS).toBe(3900);
    expect(text.length).toBeLessThanOrEqual(MAX_DIRECTIVE_CHARS);
  });

  test('contract block rides on a single line and parses', () => {
    const line = text.split('\n').find(l => l.includes('MACF-CONTRACT'));
    expect(line).toContain('<!-- MACF-CONTRACT');
    expect(line).toContain('MACF-CONTRACT -->');
    expect(parseContract(text)).not.toBeNull();
    expect(directiveToolRounds(text)).toBe(16);
  });

  test('STEP 2 research is capped at 2 tavily searches', () => {
    expect(text).toMatch(/AT MOST 2 tavily searches/);
  });

  test('media + blocker rules survived compaction', () => {
    expect(text).toMatch(/Canva/);
    expect(text).toMatch(/Pexels/);
    expect(text).toMatch(/silently media-less/);
    expect(text).toMatch(/post the blocker in this directive thread immediately/);
  });
});
