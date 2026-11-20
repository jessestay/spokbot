/**
 * engine/tests/pm-breakdown.test.js
 *
 * US-FW-031 TDD — PM breakdown (F12 Step D, zero-coverage closure).
 *
 * The component under test is two modules:
 *  - engine/pm-delegation.js — the deterministic CEO→PM layer:
 *    ceoToPm() validates a structured requirement and routes it to a
 *    role via ROLE_MAP (no LLM); its pmBreakdown() is a structural
 *    stub that hands the requirement to the LLM layer.
 *  - engine/pm-breakdown.js — the LLM layer: pmBreakdown() builds a
 *    prompt from the structured requirement, POSTs it to the local
 *    gateway (127.0.0.1:4001/v1/chat/completions, model
 *    muse-spark-1.3) via callGateway(), and parses the first JSON
 *    array out of the reply.
 *
 * Every assertion below pins behavior read from those two files —
 * nothing is invented. The gateway is replaced by a stub HTTP server
 * bound to the real port the module hardcodes, so callGateway's
 * actual HTTP path, request shape, and response handling are what
 * get exercised.
 *
 * NOT covered:
 *  - callGateway's 60s timeout (longer than jest's testTimeout).
 *
 * Step 6/7 update (2026-11-19): the two legs Step D recorded as
 * unimplemented — AC1's Vikunja subtask write and AC3's clarifying
 * questions — are now implemented in engine/pm-breakdown.js
 * (detectGaps / buildClarifyingQuestions / writeStoriesToVikunja /
 * processRequirement) on top of a new utils/vikunja addTaskRelation,
 * and are pinned by the second half of this suite (written first;
 * 13 tests RED against the Step D tree, GREEN after the build).
 */
'use strict';

const http = require('http');

const { ceoToPm, pmBreakdown: delegationBreakdown, ROLE_MAP } = require('../pm-delegation');
const { pmBreakdown, callGateway } = require('../pm-breakdown');

// ── ceoToPm: deterministic routing (pm-delegation.js) ──────────────

describe('ceoToPm routing (ROLE_MAP)', () => {
  test('ROLE_MAP is exactly the eight documented type→role routes', () => {
    expect(ROLE_MAP).toEqual({
      content: 'cmo',
      visual: 'cuxo',
      copy: 'cco',
      outreach: 'cro',
      finance: 'cfo',
      tech: 'cto',
      legal: 'lawyer',
      pm: 'execpm',
    });
  });

  test.each(Object.entries(ROLE_MAP))(
    'type "%s" routes to role "%s"',
    (type, role) => {
      const out = ceoToPm({ type, title: 'Anything' });
      expect(out.assignedRole).toBe(role);
    }
  );

  test('AC1 routing leg: a content requirement is assigned to the CMO', () => {
    const out = ceoToPm({
      type: 'content',
      title: 'Workshop promo content batch',
      description: 'X, Facebook, TikTok for Oct 11 workshop',
    });
    expect(out.assignedRole).toBe('cmo');
  });

  test('AC2 routing leg: a visual requirement is assigned to the CUXO', () => {
    const out = ceoToPm({
      type: 'visual',
      title: 'Workshop promo visuals',
      description: 'Stock-first feed and story visuals',
    });
    expect(out.assignedRole).toBe('cuxo');
  });
});

describe('ceoToPm requirement shape', () => {
  test('returns the structured requirement with status pending-pm-breakdown', () => {
    const out = ceoToPm({
      type: 'content',
      title: 'Workshop promo content batch',
      description: 'X, Facebook, TikTok for Oct 11 workshop',
      priority: 1,
      deadline: '2026-10-11',
    });
    expect(out).toEqual({
      type: 'content',
      title: 'Workshop promo content batch',
      description: 'X, Facebook, TikTok for Oct 11 workshop',
      priority: 1,
      deadline: '2026-10-11',
      assignedRole: 'cmo',
      status: 'pending-pm-breakdown',
    });
  });

  test('defaults: description "", priority 3, deadline null', () => {
    const out = ceoToPm({ type: 'tech', title: 'Fix the thing' });
    expect(out.description).toBe('');
    expect(out.priority).toBe(3);
    expect(out.deadline).toBeNull();
  });

  test('throws when type is missing', () => {
    expect(() => ceoToPm({ title: 'No type' }))
      .toThrow('Requirement must have type and title');
  });

  test('throws when title is missing', () => {
    expect(() => ceoToPm({ type: 'content' }))
      .toThrow('Requirement must have type and title');
  });

  test('throws on an unknown requirement type, naming the type', () => {
    expect(() => ceoToPm({ type: 'unknown', title: 'Bad type' }))
      .toThrow('Unknown requirement type: unknown');
  });
});

describe('pm-delegation pmBreakdown stub', () => {
  test('hands the requirement to the LLM layer untouched, stories empty', () => {
    const req = ceoToPm({ type: 'content', title: 'Workshop promo content batch' });
    const out = delegationBreakdown(req);
    expect(out.requirement).toBe(req);
    expect(out.stories).toEqual([]);
    expect(out.status).toBe('ready-for-llm-breakdown');
  });
});

// ── pm-breakdown.js: gateway-backed breakdown ──────────────────────
// Stub gateway on the module's hardcoded port. `handler` is set per
// test; `lastRequest` captures what the module actually sent.

let server;
let handler;
let lastRequest;

function gatewayReply(res, payload) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function storiesPayload(content) {
  return { choices: [{ message: { content } }] };
}

const STORIES = [
  {
    title: 'X post for workshop',
    story: 'As a workshop attendee, I want to see the promo on X so that I register',
    acceptance: ['1. Post is published', '2. Post links to registration'],
    assignTo: 'cmo',
  },
  {
    title: 'Facebook post for workshop',
    story: 'As a workshop attendee, I want to see the promo on Facebook so that I register',
    acceptance: ['1. Post is published'],
    assignTo: 'cmo',
  },
];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastRequest = { method: req.method, url: req.url, body: JSON.parse(body) };
      handler(res);
    });
  });
  await new Promise((resolve) => server.listen(4001, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const REQ = {
  type: 'content',
  title: 'Workshop promo content batch',
  description: 'X, Facebook, TikTok for Oct 11 workshop',
  assignedRole: 'cmo',
};

describe('pmBreakdown prompt construction', () => {
  test('POSTs model muse-spark-1.3 with the requirement fields in the user prompt', async () => {
    handler = (res) => gatewayReply(res, storiesPayload(JSON.stringify(STORIES)));
    await pmBreakdown(REQ);
    expect(lastRequest.method).toBe('POST');
    expect(lastRequest.url).toBe('/v1/chat/completions');
    expect(lastRequest.body.model).toBe('muse-spark-1.3');
    expect(lastRequest.body.max_tokens).toBe(2000);
    const [system, user] = lastRequest.body.messages;
    expect(system.role).toBe('system');
    expect(user.role).toBe('user');
    expect(user.content).toContain('Type: content');
    expect(user.content).toContain('Title: Workshop promo content batch');
    expect(user.content).toContain('Description: X, Facebook, TikTok for Oct 11 workshop');
    expect(user.content).toContain('Assigned role: cmo');
    expect(user.content).toContain('Assigned to: cmo');
  });
});

describe('pmBreakdown response parsing', () => {
  test('returns the parsed story array from a clean JSON reply', async () => {
    handler = (res) => gatewayReply(res, storiesPayload(JSON.stringify(STORIES)));
    await expect(pmBreakdown(REQ)).resolves.toEqual(STORIES);
  });

  test('extracts the JSON array from a prose/markdown-wrapped reply', async () => {
    const wrapped = 'Here are the stories:\n```json\n' + JSON.stringify(STORIES) + '\n```\nLet me know!';
    handler = (res) => gatewayReply(res, storiesPayload(wrapped));
    await expect(pmBreakdown(REQ)).resolves.toEqual(STORIES);
  });

  test('rejects when the reply contains no JSON array', async () => {
    handler = (res) => gatewayReply(res, storiesPayload('I cannot break that down.'));
    await expect(pmBreakdown(REQ))
      .rejects.toThrow('PM could not produce valid stories: I cannot break that down.');
  });

  test('rejects when the extracted array is malformed JSON', async () => {
    handler = (res) => gatewayReply(res, storiesPayload('[{bad json]'));
    await expect(pmBreakdown(REQ)).rejects.toThrow(SyntaxError);
  });
});

describe('callGateway response handling', () => {
  test('resolves choices[0].message.content', async () => {
    handler = (res) => gatewayReply(res, storiesPayload('hello'));
    await expect(callGateway([{ role: 'user', content: 'hi' }])).resolves.toBe('hello');
  });

  test('rejects with "Gateway error: …" when the reply carries an error', async () => {
    handler = (res) => gatewayReply(res, { error: 'model unavailable' });
    await expect(callGateway([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow('Gateway error: model unavailable');
  });

  test('rejects with "Unexpected gateway response" when the reply has neither choices nor error', async () => {
    handler = (res) => gatewayReply(res, { something: 'else' });
    await expect(callGateway([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow('Unexpected gateway response: {"something":"else"}');
  });

  test('rejects with "Gateway parse error" when the reply body is not JSON', async () => {
    handler = (res) => gatewayReply(res, 'this is not json');
    await expect(callGateway([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow('Gateway parse error: this is not json');
  });
});

// ── US-FW-031 missing legs (Step 6/7): Vikunja subtasks + clarifying ──
// questions. AC1's last clause ("written to Vikunja as subtasks") and
// AC3 (gaps → clarifying questions to the CEO → no stories until he
// responds) had no code path at Step D; these tests were written
// first and failed against the Step D tree (the four exports below
// did not exist), then the legs were implemented to satisfy them.

const {
  detectGaps,
  buildClarifyingQuestions,
  writeStoriesToVikunja,
  processRequirement,
} = require('../pm-breakdown');

function fakeVikunja({ configured = true } = {}) {
  const calls = [];
  let nextId = 100;
  return {
    calls,
    isConfigured: () => configured,
    createTask: async (agentId, projectId, fields) => {
      const id = ++nextId;
      calls.push({ op: 'createTask', agentId, projectId, fields, id });
      return { id, title: fields.title };
    },
    addTaskRelation: async (agentId, taskId, otherTaskId, relationKind) => {
      calls.push({ op: 'addTaskRelation', agentId, taskId, otherTaskId, relationKind });
      return {};
    },
  };
}

describe('detectGaps (AC3 gap identification)', () => {
  test('a requirement with neither description nor acceptance criteria is gapped on both', () => {
    const gaps = detectGaps({ type: 'content', title: 'Do the thing', description: '', assignedRole: 'cmo' });
    expect(gaps.map((g) => g.field)).toEqual(['description', 'acceptance']);
    for (const g of gaps) {
      expect(typeof g.question).toBe('string');
      expect(g.question.length).toBeGreaterThan(0);
    }
  });

  test('blank/whitespace description and empty acceptance array still count as missing', () => {
    const gaps = detectGaps({ type: 'content', title: 'T', description: '   ', acceptance: [] });
    expect(gaps.map((g) => g.field)).toEqual(['description', 'acceptance']);
  });

  test('a concrete description leaves no gaps (acceptance criteria are derivable — AC1 scenario)', () => {
    expect(detectGaps(REQ)).toEqual([]);
  });

  test('explicit acceptance criteria leave no gaps even without a description', () => {
    const gaps = detectGaps({ type: 'content', title: 'T', description: '', acceptance: ['1. It works'] });
    expect(gaps).toEqual([]);
  });
});

describe('buildClarifyingQuestions (AC3)', () => {
  test('one question per gap, each naming the requirement', () => {
    const req = { type: 'content', title: 'Ambiguous ask', description: '' };
    const questions = buildClarifyingQuestions(req, detectGaps(req));
    expect(questions).toHaveLength(2);
    for (const q of questions) expect(q).toContain('Ambiguous ask');
  });
});

describe('processRequirement — clarifying-questions leg (AC3)', () => {
  const AMBIGUOUS = { type: 'content', title: 'Ambiguous ask', description: '', assignedRole: 'cmo' };

  test('posts the questions to the CEO and creates NO stories (gateway and Vikunja untouched)', async () => {
    const asked = [];
    const vk = fakeVikunja();
    const breakdown = jest.fn(async () => { throw new Error('gateway must not be called'); });
    const out = await processRequirement(AMBIGUOUS, {
      askCeo: async (questions, req) => { asked.push({ questions, req }); },
      breakdown,
      vikunja: vk,
      projectId: 42,
    });
    expect(out.status).toBe('awaiting-ceo-clarification');
    expect(out.stories).toEqual([]);
    expect(out.gaps.map((g) => g.field)).toEqual(['description', 'acceptance']);
    expect(asked).toHaveLength(1);
    expect(asked[0].req).toBe(AMBIGUOUS);
    expect(asked[0].questions).toEqual(out.questions);
    expect(asked[0].questions.length).toBe(2);
    expect(breakdown).not.toHaveBeenCalled();
    expect(vk.calls).toEqual([]);
  });

  test('fails loudly when no askCeo channel is wired (questions are never silently dropped)', async () => {
    await expect(processRequirement(AMBIGUOUS, { breakdown: jest.fn(), vikunja: fakeVikunja() }))
      .rejects.toThrow(/askCeo/);
  });
});

describe('processRequirement — stories + Vikunja subtask leg (AC1)', () => {
  test('breakdown stories are written as subtasks of a parent requirement task', async () => {
    const vk = fakeVikunja();
    const out = await processRequirement(REQ, {
      breakdown: async () => STORIES,
      vikunja: vk,
      projectId: 42,
      askCeo: async () => { throw new Error('CEO must not be asked'); },
    });
    expect(out.status).toBe('stories-created');
    expect(out.stories).toEqual(STORIES);
    expect(out.vikunja.projectId).toBe(42);
    expect(out.vikunja.subtaskIds).toHaveLength(STORIES.length);

    const creates = vk.calls.filter((c) => c.op === 'createTask');
    const relations = vk.calls.filter((c) => c.op === 'addTaskRelation');
    expect(creates).toHaveLength(1 + STORIES.length);
    // Parent first: the requirement itself, in the target project, as execpm.
    expect(creates[0].projectId).toBe(42);
    expect(creates[0].agentId).toBe('execpm');
    expect(creates[0].fields.title).toBe(REQ.title);
    expect(out.vikunja.parentTaskId).toBe(creates[0].id);
    // One relation per story, each linking the story task as a subtask of the parent.
    expect(relations).toHaveLength(STORIES.length);
    for (const [i, rel] of relations.entries()) {
      expect(rel.taskId).toBe(creates[0].id);
      expect(rel.otherTaskId).toBe(creates[i + 1].id);
      expect(rel.relationKind).toBe('subtask');
    }
    expect(out.vikunja.subtaskIds).toEqual(relations.map((r) => r.otherTaskId));
    // Story task bodies carry the story text and its acceptance criteria.
    expect(creates[1].fields.title).toBe(STORIES[0].title);
    expect(creates[1].fields.description).toContain(STORIES[0].story);
    expect(creates[1].fields.description).toContain('Acceptance criteria:');
    expect(creates[1].fields.description).toContain('1. Post is published');
  });

  test('end-to-end via the real gateway stub: ceoToPm requirement → stories → subtasks', async () => {
    handler = (res) => gatewayReply(res, storiesPayload(JSON.stringify(STORIES)));
    const vk = fakeVikunja();
    const req = ceoToPm({
      type: 'content',
      title: 'Workshop promo content batch',
      description: 'X, Facebook, TikTok for Oct 11 workshop',
    });
    const out = await processRequirement(req, { vikunja: vk, projectId: 7 });
    expect(out.status).toBe('stories-created');
    expect(out.stories).toEqual(STORIES);
    expect(out.vikunja.parentTaskId).toBe(101);
    expect(out.vikunja.subtaskIds).toEqual([102, 103]);
  });

  test('when Vikunja is not configured the stories still return, with vikunja null', async () => {
    const vk = fakeVikunja({ configured: false });
    const out = await processRequirement(REQ, { breakdown: async () => STORIES, vikunja: vk, projectId: 42 });
    expect(out.status).toBe('stories-created');
    expect(out.stories).toEqual(STORIES);
    expect(out.vikunja).toBeNull();
    expect(vk.calls).toEqual([]);
  });
});

describe('writeStoriesToVikunja project resolution', () => {
  const ENV_KEY = 'VIKUNJA_PM_PROJECT_ID';
  let savedEnv;
  beforeEach(() => { savedEnv = process.env[ENV_KEY]; delete process.env[ENV_KEY]; });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  test('throws a clear error when no projectId is given and the env does not name one', async () => {
    await expect(writeStoriesToVikunja(REQ, STORIES, { vikunja: fakeVikunja() }))
      .rejects.toThrow(/projectId/);
  });

  test('falls back to VIKUNJA_PM_PROJECT_ID from the environment', async () => {
    process.env[ENV_KEY] = '9';
    const vk = fakeVikunja();
    const out = await writeStoriesToVikunja(REQ, STORIES, { vikunja: vk });
    expect(out.projectId).toBe(9);
    expect(vk.calls[0].projectId).toBe(9);
  });
});

describe('utils/vikunja addTaskRelation (the subtask client leg)', () => {
  const vikunja = require('../../utils/vikunja');
  let savedUrl;
  let savedToken;
  beforeEach(() => {
    savedUrl = process.env.VIKUNJA_URL;
    savedToken = process.env.VIKUNJA_TOKEN;
    process.env.VIKUNJA_URL = 'http://vikunja.test';
    process.env.VIKUNJA_TOKEN = 'test-token';
  });
  afterEach(() => {
    vikunja.setFetchImpl(null);
    if (savedUrl === undefined) delete process.env.VIKUNJA_URL; else process.env.VIKUNJA_URL = savedUrl;
    if (savedToken === undefined) delete process.env.VIKUNJA_TOKEN; else process.env.VIKUNJA_TOKEN = savedToken;
  });

  test('PUTs the subtask relation to the task relations endpoint with the bearer token', async () => {
    const seen = [];
    vikunja.setFetchImpl(async (url, opts) => {
      seen.push({ url, opts });
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 1 }) };
    });
    await vikunja.addTaskRelation('execpm', 5, 9);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('http://vikunja.test/api/v1/tasks/5/relations');
    expect(seen[0].opts.method).toBe('PUT');
    expect(JSON.parse(seen[0].opts.body)).toEqual({ other_task_id: 9, relation_kind: 'subtask' });
    expect(seen[0].opts.headers.Authorization).toBe('Bearer test-token');
  });
});
