/**
 * CEO Build 3 (F4 throughput) — picker batching contract tests (Oct 22, 2026).
 *
 * The pre-fix picker worked exactly ONE candidate per 30-minute cycle,
 * capping the board at ~33-48 task-touches/day against ~589 open tasks.
 * Build 3 contract:
 * - With the tracked task-work dispatcher injected, a cycle dispatches up
 *   to WORK_ENGINE_BATCH (default 4) candidates, in lane order
 *   (revenue-focus -> contracted -> any eligible) and, inside a lane,
 *   priority desc then stalest-first.
 * - The inline fallback (no dispatcher) stays at exactly ONE task per
 *   cycle — in-process executions remain serialized, pre-fix behavior.
 * - Eligibility (cooldowns, strikes/parking, lifecycle DONE/BLOCKED,
 *   Jesse-gated, dormant) is unchanged; these tests pin selection only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'we-b3-test-'));
process.env.MACF_STATE_DIR = TMP;
process.env.MACF_RECEIPTS_FILE = path.join(TMP, '.receipts.jsonl');
process.env.MACF_TOOL_AUDIT_GAP_FILE = path.join(TMP, 'gaps.json');
process.env.VIKUNJA_PROJECT_ID = '2';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.WORK_ENGINE_BATCH; // pin the default (4)

const mockChat = jest.fn();
const mockCompleteTask = jest.fn(async () => ({}));
let mockTaskLists = { 2: [], 16: [] };
jest.mock('../../utils/litellm', () => ({
  chat: (...a) => mockChat(...a),
  chatTurn: (...a) => mockChat(...a),
  isConfigured: () => true,
  _resetCache: () => {},
}));
jest.mock('../../utils/vikunja', () => ({
  listTasks: jest.fn(async (agentId, pid) => mockTaskLists[pid] || []),
  getTask: jest.fn(async () => ({ id: 999, done: false })),
  completeTask: (...a) => mockCompleteTask(...a),
  addComment: jest.fn(async () => ({})),
  createTask: jest.fn(),
  isConfigured: () => true,
}));
jest.mock('../lock', () => ({
  acquireLock: jest.fn(async () => true),
  releaseLock: jest.fn(async () => {}),
  isLockTask: () => false,
  holderId: () => 'test-holder',
}));
jest.mock('../../utils/agentBase', () => {
  const actual = jest.requireActual('../../utils/agentBase');
  return {
    ...actual,
    postAs: jest.fn(async () => ({ ts: '1.0' })),
    resolveChannelId: jest.fn(async () => 'C123'),
  };
});

const workEngine = require('../workEngine');
const state = require('../../utils/state');
const { stampContract } = require('../taskContract');
const { SANDBOX } = require('../../utils/agentTools');

function contracted(id, { priority = 0, updated = '2026-10-10T00:00:00Z', title } = {}) {
  const p = `reports/b3-${id}.md`;
  return {
    id, title: title || `Contracted task ${id}`, priority, done: false, updated,
    description: stampContract(`Do the work for task ${id}.`, {
      taskId: id, executor: null, requiredTools: [],
      postconditions: [{ type: 'file_exists', path: p, minBytes: 10 }],
      deliverable: { schema: 'file-report@v1' }, maxAttempts: 3,
    }),
  };
}

function scriptModel(turns) {
  const queue = [...turns];
  mockChat.mockImplementation(async () => {
    const t = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof t === 'string') return { content: t, text: t, toolCalls: [], model: 'test-model', usage: {} };
    return { content: t.text || '', text: t.text || '', toolCalls: t.toolCalls || [], model: 'test-model', usage: {} };
  });
}

const fakeClient = { chat: { postMessage: jest.fn(async () => ({ ts: '1.0' })) } };
let dispatchCalls = [];

beforeAll(() => {
  workEngine.init({ client: fakeClient, startTimer: false });
});
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
beforeEach(() => {
  mockChat.mockReset();
  mockCompleteTask.mockClear();
  mockTaskLists = { 2: [], 16: [] };
  dispatchCalls = [];
  workEngine.setTaskDispatcher(async (taskId) => {
    dispatchCalls.push(taskId);
    return { runId: `run-${taskId}`, taskId };
  });
});

test('dispatcher path: one cycle dispatches a batch in lane + priority-band order', async () => {
  const revenue = contracted(82, { priority: 0, updated: '2026-10-20T00:00:00Z' }); // REVENUE_FOCUS lane wins outright
  const p5newer = contracted(901, { priority: 5, updated: '2026-10-10T00:00:00Z' });
  const p5staler = contracted(902, { priority: 5, updated: '2026-10-01T00:00:00Z' });
  const p4 = contracted(904, { priority: 4, updated: '2026-10-05T00:00:00Z' });
  const p3stalest = contracted(903, { priority: 3, updated: '2026-09-01T00:00:00Z' }); // stalest overall, lower band -> 5th, cut by batch
  const uncontracted = { id: 905, title: 'Legacy task 905', description: 'Do the old thing.', priority: 5, done: false, updated: '2026-09-15T00:00:00Z' }; // lane 3
  mockTaskLists = { 2: [p3stalest, uncontracted, p5newer, revenue, p4, p5staler], 16: [] };

  await workEngine.runCycle();

  expect(dispatchCalls).toEqual([82, 902, 901, 904]);
});

test('dispatcher path: batch is capped at the default 4, top priorities first', async () => {
  const tasks = [5, 4, 3, 2, 1, 0].map((p, i) => contracted(911 + i, { priority: p, updated: '2026-10-10T00:00:00Z' }));
  mockTaskLists = { 2: tasks, 16: [] };

  await workEngine.runCycle();

  expect(dispatchCalls).toEqual([911, 912, 913, 914]);
});

test('board scan follows server-capped pagination to the last page (Build 3b)', async () => {
  // Vikunja caps per_page at 50 server-side regardless of the requested
  // size (verified live Oct 22, 2026). Simulate a harsher cap of 2: the
  // picker must keep fetching until a partial page, not stop after page 1
  // just because the page was smaller than the requested 100.
  const vikunja = require('../../utils/vikunja');
  const tasks = [5, 4, 3, 2, 1].map((p, i) => contracted(931 + i, { priority: p, updated: '2026-10-10T00:00:00Z' }));
  mockTaskLists = { 2: tasks, 16: [] };
  const defaultImpl = async (agentId, pid) => mockTaskLists[pid] || [];
  vikunja.listTasks.mockImplementation(async (agentId, pid, opts) => {
    const all = mockTaskLists[pid] || [];
    const per = 2; // the server's own cap, not the requested perPage
    const page = (opts && opts.page) || 1;
    return all.slice((page - 1) * per, page * per);
  });
  process.env.WORK_ENGINE_BATCH = '5';
  try {
    await workEngine.runCycle();
  } finally {
    delete process.env.WORK_ENGINE_BATCH;
    vikunja.listTasks.mockImplementation(defaultImpl);
  }
  // Task 935 (priority 1) only exists on page 3 of the capped listing.
  expect(dispatchCalls).toEqual([931, 932, 933, 934, 935]);
});

test('inline path (no dispatcher): still exactly one task per cycle', async () => {
  workEngine.setTaskDispatcher(null);
  const first = contracted(921, { priority: 5, updated: '2026-10-10T00:00:00Z' });
  const second = contracted(922, { priority: 4, updated: '2026-10-09T00:00:00Z' });
  mockTaskLists = { 2: [second, first], 16: [] };
  const p = 'reports/b3-921.md';
  scriptModel([
    { toolCalls: [{ toolName: 'fileWrite', args: { path: p, content: 'build three inline report body.' } }] },
    { text: JSON.stringify({ status: 'produced', summary: 'Inline report written.', artifactRefs: [p] }) },
  ]);

  await workEngine.runCycle();

  expect(mockCompleteTask).toHaveBeenCalledTimes(1);
  expect(mockCompleteTask).toHaveBeenCalledWith('execPM', 921);
  expect(state.get('workEngine', 'taskLifecycle.922.state')).not.toBe('DONE');
  fs.unlinkSync(path.join(SANDBOX, p));
});
