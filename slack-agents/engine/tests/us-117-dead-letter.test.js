'use strict';
/**
 * US-117 — Directive dead-letter store inspected daily (F8).
 *
 * Story: As the CEO, I want the directive dead-letter store inspected
 * daily, so that no directive dies silently.
 * AC1: Given an entry lands in the dead-letter store, When the daily
 * check runs, Then the CEO is notified with the directive text and
 * reason, and the directive is re-posted correctly or closed with a
 * stated reason.
 *
 * Framework-side lifecycle proven here (the store is the poll state's
 * _deadLetter array; the CEO-facing notification rides the standup's
 * dead-letter section and the park-ticket drain, both fed from this
 * same store):
 *   1. Scan-time deaths land WITH directive text + reason
 *      (unparseable_header / missing_artifacts) and are never
 *      registered as live work; rescans never duplicate an entry.
 *   2. The drain re-posts a due entry correctly: it re-enters the
 *      delegation queue with an incremented requeue count and leaves
 *      the store.
 *   3. Entries that can never be re-posted (no fullText) or that have
 *      exhausted MAX_REQUEUES stay permanently; the exhausted one is
 *      marked finalLogged — closed with its reason on record.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'macf-us117-'));
process.env.MACF_STATE_DIR = TMP;
process.env.MACF_RECEIPTS_FILE = path.join(TMP, '.receipts.jsonl');
process.env.MACF_GAPS_PATH = path.join(TMP, '.engine-gaps.json');
delete process.env.VIKUNJA_TOKEN;

jest.mock('../collaboration', () => ({ suggestCollaboration: async () => {} }));

// The scanner's agent-health bookkeeping writes engine/.agent-health.json
// (a hardcoded engine-dir path in directiveFinalize). Snapshot its prior
// state and restore it afterwards so this suite never leaves state files
// in the framework tree (US-FW-001 AC6: no state files in the tree).
const HEALTH_PATH = path.join(__dirname, '..', '.agent-health.json');
let priorHealth = null;
beforeAll(() => { try { priorHealth = fs.readFileSync(HEALTH_PATH, 'utf8'); } catch {} });
afterAll(() => {
  try {
    if (priorHealth === null) fs.unlinkSync(HEALTH_PATH);
    else fs.writeFileSync(HEALTH_PATH, priorHealth);
  } catch {}
});

const scanMod = require('../directiveScan');
const finalize = require('../directiveFinalize');
const { createIntakeStore } = require('../directiveIntake');

const CH = 'C0ASH4TF604'; // #management

function fakeClient(messagesByChannel) {
  return {
    conversations: {
      history: jest.fn(async ({ channel }) => ({ messages: (messagesByChannel[channel] || []).slice() })),
      replies: jest.fn(async () => ({ messages: [] })),
    },
    chat: { postMessage: jest.fn(async () => ({ ts: '1700000000.000001' })) },
  };
}

function makeScanner(messages) {
  const intake = createIntakeStore(fs.mkdtempSync(path.join(os.tmpdir(), 'macf-us117-intake-')));
  const scanner = scanMod.createDirectiveScanner({
    client: fakeClient({ [CH]: messages }),
    intake,
    channels: [CH],
    roadblocksPath: path.join(TMP, `roadblocks-${Math.random().toString(36).slice(2, 8)}.json`),
  });
  return { scanner, intake };
}

describe('US-117 dead-letter store — deaths land with text and reason', () => {
  test('an unparseable directive-looking message dead-letters with reason and text, and is never registered', async () => {
    const { scanner, intake } = makeScanner([
      { ts: '200.001', text: '[from: CEO CTO] this header has no arrow and cannot parse' },
    ]);
    const state = {};
    const summary = await scanner.scanChannel(state, CH);
    expect(summary.deadLettered).toBe(1);
    expect(summary.registered).toBe(0);
    expect(await intake.get(`${CH}:200.001`)).toBeNull();
    expect(state._deadLetter).toHaveLength(1);
    const e = state._deadLetter[0];
    expect(e.reason).toBe('unparseable_header');
    expect(e.text).toMatch(/no arrow and cannot parse/);
    expect(e.channel).toBe(CH);
    expect(e.ts).toBe('200.001');
    // Deliberately unactionable: no fullText/requeueAt, so the drain
    // can never resurrect it as a directive — it stays for review.
    expect(e.fullText).toBeUndefined();
    expect(e.requeueAt).toBeUndefined();
  });

  test('an artifact-review directive with no URLs/paths dead-letters as missing_artifacts, once', async () => {
    const msg = { ts: '200.002', text: '[from: CEO → CTO] please review the design mockups for the launch' };
    const { scanner } = makeScanner([msg]);
    const state = {};
    await scanner.scanChannel(state, CH);
    await scanner.scanChannel(state, CH); // rescan must not duplicate
    const entries = state._deadLetter.filter(e => e.ts === '200.002');
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toBe('missing_artifacts');
    expect(entries[0].agentId).toBe('cto');
    expect(entries[0].text).toMatch(/review the design mockups/);
  });
});

describe('US-117 dead-letter store — the daily drain', () => {
  const fakeAgent = { handleDelegation: jest.fn(async () => {}) };
  beforeAll(() => {
    finalize.init({ getAgent: () => fakeAgent, agentIds: ['cto'] });
  });

  function entry(overrides = {}) {
    return {
      channel: CH, ts: '200.010', agentId: 'cto',
      text: '[from: CEO → CTO] do the thing https://example.com/x',
      fullText: '[from: CEO → CTO] do the thing https://example.com/x',
      reason: 'postcondition_failed', failedAt: new Date(Date.now() - 3600e3).toISOString(),
      requeues: 0, requeueAt: new Date(Date.now() - 60e3).toISOString(), // due
      ...overrides,
    };
  }

  test('a due entry is re-posted correctly: re-enters the queue with requeues+1 and leaves the store', () => {
    const state = { _deadLetter: [entry()] };
    const pending = [];
    const drained = finalize.drainDeadLetterRequeues(state, {}, pending, Date.now());
    expect(drained).toBe(1);
    expect(state._deadLetter).toHaveLength(0);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ channel: CH, agentId: 'cto', isRetry: true, requeues: 1 });
    expect(pending[0].text).toMatch(/do the thing/);
  });

  test('an entry whose cooldown has not elapsed stays in the store untouched', () => {
    const state = { _deadLetter: [entry({ requeueAt: new Date(Date.now() + 3600e3).toISOString() })] };
    const pending = [];
    expect(finalize.drainDeadLetterRequeues(state, {}, pending, Date.now())).toBe(0);
    expect(state._deadLetter).toHaveLength(1);
    expect(pending).toHaveLength(0);
  });

  test('an exhausted entry is closed with its reason on record: stays permanently and is finally logged', () => {
    const state = { _deadLetter: [entry({ requeues: 8 })] }; // MAX_REQUEUES = 8
    const pending = [];
    expect(finalize.drainDeadLetterRequeues(state, {}, pending, Date.now())).toBe(0);
    expect(pending).toHaveLength(0);
    expect(state._deadLetter).toHaveLength(1);
    expect(state._deadLetter[0].finalLogged).toBe(true);
    expect(state._deadLetter[0].reason).toBe('postcondition_failed');
  });

  test('an entry with no fullText can never be re-posted, even when due', () => {
    const e = entry(); delete e.fullText;
    const state = { _deadLetter: [e] };
    const pending = [];
    expect(finalize.drainDeadLetterRequeues(state, {}, pending, Date.now())).toBe(0);
    expect(state._deadLetter).toHaveLength(1);
    expect(pending).toHaveLength(0);
  });
});
