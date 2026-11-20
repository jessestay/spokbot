// kernel-p3-content-batch.test.js — #925 round 3 (Nov 2, 2026).
//
// The weekly content batch directive finalized as "completed" on a prose
// failure report because (1) it named its deliverable by absolute path, so
// derivePostconditions derived NOTHING, and (2) directives could not carry
// the MACF-CONTRACT postconditions the task path has had since #724.
// Round 3: the finalize gate merges a directive's MACF-CONTRACT block
// (sync checker types only), completion.js gains a json_array_min
// checker, and litellm flags unparseable (truncated) tool-call arguments
// instead of silently executing them as {}.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'macf-cb3-'));
process.env.MACF_STATE_DIR = TMP;
process.env.MACF_RECEIPTS_FILE = path.join(TMP, '.receipts.jsonl');
process.env.MACF_BREAKER_STATE_PATH = path.join(TMP, 'circuit-breaker.json');
process.env.MACF_EMPTY_RETRY_DELAY_MS = '0';
delete process.env.VIKUNJA_TOKEN;

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('http-proxy-agent', () => ({ HttpProxyAgent: class { constructor() {} } }));
jest.mock('https-proxy-agent', () => ({ HttpsProxyAgent: class { constructor() {} } }));
jest.mock('../../utils/modelRouter', () => ({
  getFallbackChain: (tier) => (tier === 'smart' ? ['macf-smart-paid', 'macf-smart-free', 'macf-local'] : [tier]),
  loadConfig: () => ({ settings: { empty_response_retries: 2, model_timeout_ms: 5000, log_routing: false } }),
  getModelForTier: (tier) => tier,
}));

const { derivePostconditions, verifyPostconditions } = require('../directivePostconditions');
const { renderContractBlock } = require('../taskContract');
const { SANDBOX } = require('../../utils/agentTools');

const BATCH = 'content/weekly-batch-2026-11-02.json';

function batchDirective(contractPostconditions) {
  const contract = {
    taskId: null,
    executor: null,
    requiredTools: [{ tool: 'fileWrite', minSuccess: 1 }],
    postconditions: contractPostconditions || [
      { type: 'file_exists', path: BATCH, minBytes: 200 },
      { type: 'json_array_min', path: BATCH, field: 'drafts', min: 3 },
    ],
    deliverable: { schema: 'generic@v1' },
    maxAttempts: 3,
  };
  return `[from: CEO → CCO] WEEKLY CONTENT BATCH. Write the batch file ${BATCH} incrementally, one draft per fileWrite call.\n\n${renderContractBlock(contract)}`;
}

describe('#925 A — contract-carried postconditions for directives', () => {
  test('contract merges file_exists (with minBytes) + json_array_min for the batch path', () => {
    const pcs = derivePostconditions(batchDirective());
    const fe = pcs.filter(p => p.type === 'file_exists' && p.path === BATCH);
    expect(fe).toHaveLength(1);
    expect(fe[0].minBytes).toBe(200);
    const jam = pcs.filter(p => p.type === 'json_array_min');
    expect(jam).toEqual([{ type: 'json_array_min', path: BATCH, field: 'drafts', min: 3 }]);
  });

  test('prose-only directive keeps legacy derivation (no minBytes, no json_array_min)', () => {
    const pcs = derivePostconditions(`[from: CEO → CCO] Write the batch file ${BATCH} please.`);
    expect(pcs).toEqual([{ type: 'file_exists', path: BATCH }]);
  });

  test('contract postconditions with absolute paths are rejected', () => {
    const pcs = derivePostconditions(batchDirective([
      { type: 'file_exists', path: '/operator/machine/workspace/agent-sandbox/content/x.json' },
      { type: 'json_array_min', path: BATCH, field: 'drafts', min: 3 },
    ]));
    expect(pcs.some(p => String(p.path || '').startsWith('/'))).toBe(false);
    expect(pcs.filter(p => p.type === 'json_array_min')).toHaveLength(1);
  });

  test('async-only checker types are NOT merged into the directive gate', () => {
    const pcs = derivePostconditions(batchDirective([
      { type: 'http_status', url: 'https://example.com/x', expect: [200] },
      { type: 'vikunja_task_exists', taskId: 925 },
    ]));
    expect(pcs.some(p => p.type === 'http_status')).toBe(false);
    expect(pcs.some(p => p.type === 'vikunja_task_exists')).toBe(false);
  });

  test('receipt_count contract postconditions merge (sync checker)', () => {
    const pcs = derivePostconditions(batchDirective([
      { type: 'receipt_count', tool: 'fileWrite', status: 'ok', min: 1 },
    ]));
    expect(pcs).toContainEqual({ type: 'receipt_count', tool: 'fileWrite', min: 1, status: 'ok' });
  });
});

describe('#925 A — json_array_min verification against the world', () => {
  const batchAbs = path.join(SANDBOX, BATCH);
  const pcs = [
    { type: 'file_exists', path: BATCH, minBytes: 200 },
    { type: 'json_array_min', path: BATCH, field: 'drafts', min: 3 },
  ];
  function writeBatch(drafts) {
    fs.mkdirSync(path.dirname(batchAbs), { recursive: true });
    fs.writeFileSync(batchAbs, JSON.stringify({ week_of: '2026-11-02', drafts }), 'utf8');
  }
  const draft = (n) => ({ label: String(n), platform: 'LinkedIn', hook: `hook ${n}`, body: 'x'.repeat(120), gate_scores: { r1: 5 } });
  afterAll(() => { try { fs.unlinkSync(batchAbs); } catch { /* ignore */ } });

  test('3 drafts satisfying both postconditions', () => {
    writeBatch([draft(1), draft(2), draft(3)]);
    const v = verifyPostconditions(pcs, { taskId: null });
    expect(v.allSatisfied).toBe(true);
    const jam = v.results.find(r => r.type === 'json_array_min');
    expect(jam.observed.count).toBe(3);
  });

  test('2 drafts fails json_array_min with the observed count', () => {
    writeBatch([draft(1), draft(2)]);
    const v = verifyPostconditions(pcs, { taskId: null });
    expect(v.allSatisfied).toBe(false);
    const jam = v.failures.find(r => r.type === 'json_array_min');
    expect(jam).toBeTruthy();
    expect(jam.observed.count).toBe(2);
  });

  test('unparseable JSON fails closed', () => {
    fs.mkdirSync(path.dirname(batchAbs), { recursive: true });
    fs.writeFileSync(batchAbs, '{"week_of": "2026-11-02", "drafts": [', 'utf8');
    const v = verifyPostconditions(pcs, { taskId: null });
    expect(v.allSatisfied).toBe(false);
    const jam = v.failures.find(r => r.type === 'json_array_min');
    expect(jam.observed.parseOk).toBe(false);
  });

  test('missing file fails both postconditions', () => {
    try { fs.unlinkSync(batchAbs); } catch { /* ignore */ }
    const v = verifyPostconditions(pcs, { taskId: null });
    expect(v.allSatisfied).toBe(false);
    expect(v.failures).toHaveLength(2);
  });
});

describe('#925 D — litellm flags unparseable tool-call arguments', () => {
  const axios = require('axios');
  process.env.LITELLM_BASE_URL = 'http://127.0.0.1:4000';
  process.env.LITELLM_MASTER_KEY = 'test-key';
  const litellm = require('../../utils/litellm');
  const TOOLS = [{ type: 'function', function: { name: 'fileWrite', parameters: { type: 'object', properties: {} } } }];

  beforeEach(() => {
    litellm._resetGatewayCache();
    axios.get.mockReset(); axios.post.mockReset();
    axios.get.mockResolvedValue({ status: 200, data: {} });
  });

  test('truncated arguments are flagged argsParseError, never silently {}', async () => {
    axios.post.mockResolvedValue({
      data: {
        choices: [{
          message: {
            content: '',
            tool_calls: [{ id: 'c1', function: { name: 'fileWrite', arguments: '{"path":"content/weekly-batch-2026-11-02.json","content":"{\\"week_of\\":\\"2026-11-02\\",\\"drafts\\":[{\\"label\\":\\"1\\",\\"body\\":\\"a very long draft that got cut off mid-str' } }],
          },
        }],
      },
    });
    const turn = await litellm.chatTurn({ systemPrompt: 's', userMessage: 'hi', model: 'smart', tools: TOOLS });
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0].toolName).toBe('fileWrite');
    expect(turn.toolCalls[0].args).toEqual({});
    expect(turn.toolCalls[0].argsParseError).toBeTruthy();
    expect(turn.toolCalls[0].argsParseError.rawBytes).toBeGreaterThan(50);
  });

  test('parseable arguments pass through with no flag', async () => {
    axios.post.mockResolvedValue({
      data: {
        choices: [{
          message: {
            content: '',
            tool_calls: [{ id: 'c1', function: { name: 'fileRead', arguments: '{"path":"team-skills/jesse-voice.md"}' } }],
          },
        }],
      },
    });
    const turn = await litellm.chatTurn({ systemPrompt: 's', userMessage: 'hi', model: 'smart', tools: TOOLS });
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0].args).toEqual({ path: 'team-skills/jesse-voice.md' });
    expect(turn.toolCalls[0].argsParseError).toBeUndefined();
  });
});
