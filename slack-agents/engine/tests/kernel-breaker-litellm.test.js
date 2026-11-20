// kernel-breaker-litellm.test.js — Phase C integration (Vikunja #789).
//
// Proves utils/litellm consults the circuit breaker (utils/circuitBreaker):
//   - a tripped leg is never attempted (fail-fast skip, not another
//     60-second timeout into a dead route)
//   - when EVERY leg is tripped, chatTurn throws a circuit-open error
//     immediately, with ZERO gateway calls — the caller's retry/dead-letter
//     machinery gets a fast failure it can schedule around
//   - real outcomes feed the breaker: empties count, a success resets
//   - the VM-direct failover chain gets the same treatment (direct: keys)
//
// Same mock harness as kernel-resilience-litellm.test.js (axios + proxy
// agents + modelRouter mocked); the breaker runs for REAL against a temp
// state file so the test exercises the actual cross-call memory.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.MACF_EMPTY_RETRY_DELAY_MS = '0';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'macf-breaker-litellm-'));
process.env.MACF_BREAKER_STATE_PATH = path.join(TMP, 'circuit-breaker.json');

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('http-proxy-agent', () => ({ HttpProxyAgent: class { constructor() {} } }));
jest.mock('https-proxy-agent', () => ({ HttpsProxyAgent: class { constructor() {} } }));
jest.mock('../../utils/modelRouter', () => ({
  getFallbackChain: (tier) => (tier === 'smart'
    ? ['macf-smart-paid', 'macf-smart-free']
    : tier === 'delegation'
      ? ['macf-smart-paid', 'macf-local']
      : [tier]),
  loadConfig: () => ({ settings: { empty_response_retries: 2, model_timeout_ms: 5000, log_routing: false } }),
  getModelForTier: (tier) => tier,
}));

describe('litellm chatTurn + circuit breaker', () => {
  const axios = require('axios');
  process.env.LITELLM_BASE_URL = 'http://127.0.0.1:4000';
  process.env.LITELLM_MASTER_KEY = 'test-key';
  const litellm = require('../../utils/litellm');
  const breaker = require('../../utils/circuitBreaker');

  beforeEach(() => {
    litellm._resetGatewayCache();
    breaker.resetAll();
    axios.get.mockReset(); axios.post.mockReset();
    axios.get.mockResolvedValue({ status: 200, data: {} });
  });

  function trip(route) {
    const now = Date.now();
    for (let i = 0; i < 3; i++) breaker.recordEmpty(route, now + i);
  }

  test('a tripped leg is skipped entirely; the healthy leg answers', async () => {
    trip('macf-smart-paid');
    const modelsTried = [];
    axios.post.mockImplementation(async (url, body) => {
      modelsTried.push(body.model);
      return { data: { choices: [{ message: { content: 'free answered' } }] } };
    });
    const turn = await litellm.chatTurn({ systemPrompt: 's', userMessage: 'hi', model: 'smart' });
    expect(turn.text).toBe('free answered');
    expect(modelsTried).toEqual(['macf-smart-free']); // paid never attempted
  });

  test('all legs tripped -> circuit-open error with ZERO gateway calls', async () => {
    trip('macf-smart-paid');
    trip('macf-smart-free');
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content: 'x' } }] } });
    await expect(litellm.chatTurn({ systemPrompt: 's', userMessage: 'hi', model: 'smart' }))
      .rejects.toThrow(/circuit open/i);
    expect(axios.post.mock.calls.length).toBe(0);
  });

  test('real empties feed the breaker across calls', async () => {
    axios.post.mockImplementation(async (url, body) => {
      if (body.model === 'macf-smart-paid') return { data: { choices: [{ message: { content: '' } }] } };
      return { data: { choices: [{ message: { content: 'free ok' } }] } };
    });
    // Each call tries paid first (empty) then succeeds on free, so paid
    // accrues exactly one consecutive empty per call. Three calls trip it.
    await litellm.chatTurn({ systemPrompt: 's', userMessage: 'hi', model: 'smart' });
    await litellm.chatTurn({ systemPrompt: 's', userMessage: 'hi', model: 'smart' });
    await litellm.chatTurn({ systemPrompt: 's', userMessage: 'hi', model: 'smart' });
    expect(breaker.getRouteState('macf-smart-paid').state).toBe('open');
    // Next call must not attempt paid at all.
    const modelsTried = [];
    axios.post.mockImplementation(async (url, body) => {
      modelsTried.push(body.model);
      return { data: { choices: [{ message: { content: 'free ok' } }] } };
    });
    await litellm.chatTurn({ systemPrompt: 's', userMessage: 'hi', model: 'smart' });
    expect(modelsTried).toEqual(['macf-smart-free']);
  });

  test('REGRESSION (Nov 2, 2026): a tool-requiring delegation is NOT assigned macf-local when the capable route sits in a stale half-open claim', async () => {
    // The exact production state that killed the 2026-11-02 weekly
    // content batch: macf-smart-paid half-open since Oct 23 with NO
    // probeClaimedAt (the claiming call died without recording an
    // outcome). Before the probe lease, shouldSkip returned true
    // forever, the capable route was never attempted, and the CCO's
    // delegation fell through to macf-local — a text-only route whose
    // answer the generateWithTools quality gate rejects as no_result.
    const stuck = {
      routes: {
        'macf-smart-paid': {
          route: 'macf-smart-paid', state: 'half-open', consecutiveEmpties: 3,
          trips: 31, openedAt: 1792767132389, openUntil: 1792767252389,
          cooldownMs: 120000, totals: { success: 2934, empty: 179 },
        },
      },
    };
    fs.writeFileSync(process.env.MACF_BREAKER_STATE_PATH, JSON.stringify(stuck));
    const modelsTried = [];
    axios.post.mockImplementation(async (url, body) => {
      modelsTried.push(body.model);
      if (body.model === 'macf-smart-paid') {
        return { data: { choices: [{ message: { content: '', tool_calls: [{ id: 'tc1', function: { name: 'tavily_search', arguments: '{"query":"ai news"}' } }] } }] } };
      }
      return { data: { choices: [{ message: { content: 'local text answer' } }] } };
    });
    const turn = await litellm.chatTurn({
      systemPrompt: 's', userMessage: 'draft the weekly batch', model: 'delegation',
      tools: [{ type: 'function', function: { name: 'tavily_search', parameters: { type: 'object', properties: {} } } }],
    });
    expect(modelsTried[0]).toBe('macf-smart-paid'); // capable route probed FIRST, not skipped
    expect(modelsTried).not.toContain('macf-local'); // local never became the answering route
    expect(turn.route).toBe('macf-smart-paid');
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0].toolName).toBe('tavily_search');
    // The successful probe closed the breaker.
    expect(breaker.getRouteState('macf-smart-paid').state).toBe('closed');
  });

  test('a success on a streaking leg resets its breaker streak', async () => {
    const now = Date.now();
    breaker.recordEmpty('macf-smart-paid', now);
    breaker.recordEmpty('macf-smart-paid', now + 1);
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content: 'paid answered' } }] } });
    const turn = await litellm.chatTurn({ systemPrompt: 's', userMessage: 'hi', model: 'smart' });
    expect(turn.text).toBe('paid answered');
    expect(breaker.getRouteState('macf-smart-paid').consecutiveEmpties).toBe(0);
  });
});

describe('litellm VM-direct failover + circuit breaker', () => {
  const axios = require('axios');
  process.env.LITELLM_BASE_URL = 'http://127.0.0.1:4000';
  process.env.LITELLM_MASTER_KEY = 'test-key';
  process.env.OPENROUTER_API_KEY = 'test-or-key';
  const litellm = require('../../utils/litellm');
  const breaker = require('../../utils/circuitBreaker');

  beforeEach(() => {
    litellm._resetGatewayCache();
    breaker.resetAll();
    axios.get.mockReset(); axios.post.mockReset();
    axios.get.mockRejectedValue(new Error('connect ECONNREFUSED')); // gateway down -> direct path
  });

  test('all direct legs tripped -> circuit-open error, zero OpenRouter calls', async () => {
    const now = Date.now();
    for (const id of ['liquid/lfm-2.5-2.6b:free', 'nvidia/nemotron-3.5-lightning:free', 'deepseek/deepseek-v4-flash']) {
      for (let i = 0; i < 3; i++) breaker.recordEmpty(`direct:${id}`, now + i);
    }
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content: 'x' } }] } });
    await expect(litellm.chatTurn({ systemPrompt: 's', userMessage: 'hi', model: 'smart' }))
      .rejects.toThrow(/circuit open/i);
    expect(axios.post.mock.calls.length).toBe(0);
  });
});
