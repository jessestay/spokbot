// kernel-p3-content-batch-r5.test.js — #925 round 5 (Nov 2, 2026).
//
// Round 4 proved the CCO produces the weekly batch and the finalize
// gate verifies it (file_exists + json_array_min), but the batch could
// not LAND in #content: no agent tool could post to a Slack channel
// (agentTools had no Slack-post tool; the baseline slack MCP is
// read-only by design). Round 5: (1) a local slackPost tool in
// utils/agentTools (bot token server-side, roles cco+ceo, receipted
// like every local tool); (2) the batch contract gains
// receipt_count(slackPost, ok) >= 1; (3) STEP 5 directs the CCO to
// present the batch in #content via slackPost with media on every
// draft. These tests pin the tool's gate/validation/receipt behavior
// and the contract chain — including that the exact round-4 end state
// (batch file verified, zero slackPost receipts) now FAILS the gate.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'macf-cb5-'));
process.env.MACF_STATE_DIR = TMP;
process.env.MACF_RECEIPTS_FILE = path.join(TMP, '.receipts.jsonl');
process.env.MACF_TOOL_AUDIT_GAP_FILE = path.join(TMP, 'gaps.json');

const { executeTool, TOOLS, SANDBOX } = require('../../utils/agentTools');
const { derivePostconditions, verifyPostconditions } = require('../directivePostconditions');
const { buildDirectiveText, MAX_DIRECTIVE_CHARS } = require('../contentBatchTrigger');
const receipts = require('../receipts');

const CHANNEL = 'C0ASA532BGD';
const PROBE = 'content/weekly-batch-2099-01-04.json';

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('#925 round 5 — slackPost registry, role gate, validation', () => {
  test('slackPost is registered with roles cco+ceo and required channel/text', () => {
    expect(TOOLS.slackPost).toBeDefined();
    expect(TOOLS.slackPost.roles).toEqual(['cco', 'ceo']);
    expect(TOOLS.slackPost.argsSchema.required).toEqual(['channel', 'text']);
    expect(Object.keys(TOOLS.slackPost.argsSchema.properties)).toEqual(
      expect.arrayContaining(['channel', 'text', 'thread_ts', 'mediaUrl', 'filePath']),
    );
  });

  test('role gate: cmo is refused with errorClass permission and the fn never runs', () => {
    const original = TOOLS.slackPost.fn;
    const spy = jest.fn(() => ({ ok: true }));
    TOOLS.slackPost.fn = spy;
    try {
      const r = executeTool('slackPost', { channel: CHANNEL, text: 'hi' }, { agentId: 'cmo', taskId: null });
      expect(r.ok).toBe(false);
      expect(r.errorClass).toBe('permission');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      TOOLS.slackPost.fn = original;
    }
  });

  test('schema validation: missing text returns a structured correction, fn never runs', () => {
    const original = TOOLS.slackPost.fn;
    const spy = jest.fn(() => ({ ok: true }));
    TOOLS.slackPost.fn = spy;
    try {
      const r = executeTool('slackPost', { channel: CHANNEL }, { agentId: 'cco', taskId: null });
      expect(r.ok).toBe(false);
      expect(r.errorClass).toBe('invalid_input');
      expect(r.correction.missing).toEqual(['text']);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      TOOLS.slackPost.fn = original;
    }
  });

  test('fn validation: a channel NAME is rejected (IDs only), before any API call', () => {
    const r = executeTool('slackPost', { channel: '#content', text: 'hi' }, { agentId: 'cco', taskId: null });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/channel ID/);
  });

  test('fn validation: a non-URL mediaUrl is rejected before any API call', () => {
    const r = executeTool('slackPost', { channel: CHANNEL, text: 'hi', mediaUrl: 'not-a-url' }, { agentId: 'cco', taskId: null });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/mediaUrl/);
  });

  test('fn validation: filePath traversal and missing files are rejected before any API call', () => {
    const trav = executeTool('slackPost', { channel: CHANNEL, text: 'hi', filePath: '../.env' }, { agentId: 'cco', taskId: null });
    expect(trav.ok).toBe(false);
    expect(trav.error).toMatch(/sandbox-relative/);
    const missing = executeTool('slackPost', { channel: CHANNEL, text: 'hi', filePath: 'content/does-not-exist-r5.png' }, { agentId: 'cco', taskId: null });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/not readable/);
  });

  test('transport: an invalid bot token maps to a Slack API error, never a throw, never a leak', async () => {
    const prev = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = 'xoxb-deliberately-invalid-r5-test';
    try {
      const r = executeTool('slackPost', { channel: CHANNEL, text: 'round 5 staging probe (invalid token — must fail)' }, { agentId: 'cco', taskId: null });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/Slack/);
      expect(r.error).not.toMatch(/xoxb/);
      expect(JSON.stringify(r)).not.toMatch(/deliberately-invalid/);
    } finally {
      if (prev === undefined) delete process.env.SLACK_BOT_TOKEN; else process.env.SLACK_BOT_TOKEN = prev;
    }
  }, 30000);

  test('receipt discipline: failed slackPost calls still land in the ledger as errors', () => {
    const mine = receipts.readAllReceipts().filter(r => r.tool === 'slackPost');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every(r => r.status === 'error')).toBe(true);
    expect(mine.some(r => r.errorClass === 'permission')).toBe(true);
  });
});

describe('#925 round 5 — contract: receipt_count(slackPost) joins the batch postconditions', () => {
  const text = buildDirectiveText('2099-01-04');
  const pcs = derivePostconditions(text);

  test('directive stays under the length guard and names the tool + channel', () => {
    expect(text.length).toBeLessThanOrEqual(MAX_DIRECTIVE_CHARS);
    expect(text).toMatch(/slackPost/);
    expect(text).toMatch(/C0ASA532BGD/);
    expect(text).toMatch(/mediaUrl/);
    expect(text).toMatch(/source link next to the first mention/);
  });

  test('derived set = file_exists(minBytes) + json_array_min + receipt_count(slackPost, ok, >=1)', () => {
    expect(pcs.filter(p => p.type === 'file_exists' && p.path === PROBE)[0].minBytes).toBe(200);
    expect(pcs.filter(p => p.type === 'json_array_min')).toEqual([
      { type: 'json_array_min', path: PROBE, field: 'drafts', min: 3 },
    ]);
    expect(pcs.filter(p => p.type === 'receipt_count')).toEqual([
      { type: 'receipt_count', tool: 'slackPost', min: 1, status: 'ok' },
    ]);
  });

  test('the merge survives Slack HTML-escaping (the round-4 path)', () => {
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const ep = derivePostconditions(escaped);
    expect(ep.filter(p => p.type === 'receipt_count')).toEqual([
      { type: 'receipt_count', tool: 'slackPost', min: 1, status: 'ok' },
    ]);
  });
});

describe('#925 round 5 — the gate now refuses the round-4 end state', () => {
  const probeAbs = path.join(SANDBOX, PROBE);
  // The full directive also derives file_exists for the two reference
  // docs it names; production seeds them as sandbox mirrors (trigger
  // refreshMirrors), so seed them here too for a like-for-like gate.
  const refDocs = ['team-skills/jesse-voice.md', 'engine/content-quality-gate.md'];
  const draft = (n) => ({ label: String(n), platform: 'LinkedIn', hook: `hook ${n}`, body: 'x'.repeat(120), gate_scores: { r1: 5, r2: 5, r3: 5, r4: 5, r5: 5, r6: 5 } });
  const pcs = derivePostconditions(buildDirectiveText('2099-01-04'));

  beforeAll(() => {
    fs.mkdirSync(path.dirname(probeAbs), { recursive: true });
    fs.writeFileSync(probeAbs, JSON.stringify({ week_of: '2099-01-04', drafts: [draft(1), draft(2), draft(3)] }), 'utf8');
    for (const rel of refDocs) {
      const abs = path.join(SANDBOX, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (!fs.existsSync(abs)) fs.writeFileSync(abs, 'staging probe mirror\n', 'utf8');
    }
  });
  afterAll(() => { try { fs.unlinkSync(probeAbs); } catch { /* ignore */ } });

  test('batch file verified but NO slackPost receipt: gate refuses (receipt_count unmet)', () => {
    const v = verifyPostconditions(pcs, { taskId: null });
    const rc = v.results.find(r => r.type === 'receipt_count');
    // Isolate from receipts other describes may have issued into TMP:
    // every slackPost receipt in this ledger is an error, so the ok
    // count for the gate must be 0 regardless of ordering.
    expect(rc.satisfied).toBe(false);
    expect(rc.observed).toBe(0);
    expect(v.results.find(r => r.type === 'file_exists' && r.path === PROBE).satisfied).toBe(true);
    expect(v.results.find(r => r.type === 'json_array_min').satisfied).toBe(true);
    expect(v.allSatisfied).toBe(false);
  });

  test('one ok slackPost receipt: the full contract verifies', () => {
    receipts.issueReceipt({
      agentId: 'cco', taskId: null, tool: 'slackPost',
      args: { channel: CHANNEL, text: 'probe' },
      result: { ok: true, channel: CHANNEL, ts: '1793000000.000100' },
    });
    const v = verifyPostconditions(pcs, { taskId: null });
    expect(v.results.find(r => r.type === 'receipt_count').satisfied).toBe(true);
    expect(v.results.find(r => r.type === 'receipt_count').observed).toBeGreaterThanOrEqual(1);
    expect(v.allSatisfied).toBe(true);
  });
});
