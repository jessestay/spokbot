// tests/workEngineLock.test.js — runCycle honors the single-instance lock
//
// TDD contract for the workEngine change: runCycle() must call acquireLock()
// FIRST; when the lock is not acquired it logs and returns WITHOUT touching
// the board, Slack, or Jesse. Lock tasks must also be excluded from the board
// listing so the engine never tries to "work" the lock task itself.
//
// Mocks ../engine/lock and ../utils/anthropic at the module boundary so no
// real Vikunja writes, Slack posts, or LLM calls can happen in these tests.
'use strict';

// Env before config loads (VIKUNJA.projectId is read at require time).
// The pre-existing environment is backed up first and restored in afterAll so
// other test files sharing the jest worker see a clean environment.
const FILE_ENV_BACKUP = { ...process.env };
process.env.VIKUNJA_URL = 'https://tasks.example.com';
process.env.VIKUNJA_TOKEN = 'tk_test';
process.env.VIKUNJA_PROJECT_ID = '2';

jest.mock('../engine/lock', () => ({
  acquireLock: jest.fn(),
  releaseLock: jest.fn(),
  isLockTask: jest.fn((t) => /engine lock/i.test(((t && t.title) || ''))),
  holderId: jest.fn(() => 'testhost:12345'),
}));
jest.mock('../utils/anthropic', () => ({
  generateReport: jest.fn(),
  // Since #724 the contracted work path runs through generateWithTools with
  // a typed deliverable; generateReport is no longer the work seam.
  generateWithTools: jest.fn(),
  // New since the original tests: runCycle checks this before doing any LLM
  // task work. Defaults to configured so the original contracts hold.
  isConfigured: jest.fn(() => true),
}));
// Pin engine memory to a clean in-memory double: runCycle must not depend on
// (or pollute) real on-disk state in tests.
jest.mock('../utils/state', () => ({
  get: jest.fn(),
  set: jest.fn(),
  push: jest.fn(),
}));

const { ensureContract } = require('../engine/taskContract');
// Since #724 Phase 3, workTask fail-closes on any task without a
// MACF-CONTRACT block. Board fixtures that are meant to be WORKED must
// therefore carry a contract — an uncontracted fixture now proves the
// opposite of what these lock tests intend.
const CONTRACTED = ensureContract('Fixture task details.');
const we = require('../engine/workEngine');
const lock = require('../engine/lock');
const vikunja = require('../utils/vikunja');
const { generateReport, generateWithTools, isConfigured } = require('../utils/anthropic');

const LOCK_TITLE = '🔒 ENGINE LOCK — do not complete';

// Restore the pre-existing environment after the run (see backup at top).
afterAll(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in FILE_ENV_BACKUP)) delete process.env[k];
  }
  Object.assign(process.env, FILE_ENV_BACKUP);
});

function mockFetch(handler) {
  const calls = [];
  vikunja.setFetchImpl(async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts);
  });
  return calls;
}

function okJson(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

let fakeClient;

beforeEach(() => {
  jest.useFakeTimers();
  lock.acquireLock.mockReset().mockResolvedValue(true);
  lock.releaseLock.mockReset().mockResolvedValue(undefined);
  generateReport.mockReset().mockResolvedValue(null);
  generateWithTools.mockReset().mockResolvedValue({
    response: JSON.stringify({ status: 'produced', summary: 'Launch post drafted.', artifactRefs: [] }),
    toolResults: [], ok: true,
  });
  // Reset (not just clear): re-arm the default "LLM configured" behavior so
  // the original work-the-board contracts hold unless a test opts out.
  isConfigured.mockReset().mockReturnValue(true);
  vikunja.setFetchImpl(null);
  fakeClient = {
    chat: { postMessage: jest.fn() },
    conversations: { open: jest.fn() },
  };
  we.init({ client: fakeClient });
});

afterEach(() => {
  we.stop();
  jest.useRealTimers();
  vikunja.setFetchImpl(null);
});

describe('runCycle single-instance lock', () => {
  test('calls acquireLock first and stands down without touching anything when it returns false', async () => {
    lock.acquireLock.mockResolvedValue(false);
    const calls = mockFetch(async () => okJson([]));

    await we.runCycle();

    // Lock checked first, exactly once, with a hostname:pid-style holder.
    expect(lock.acquireLock).toHaveBeenCalledTimes(1);
    expect(lock.acquireLock).toHaveBeenCalledWith(
      expect.objectContaining({ holderId: expect.stringMatching(/:/) })
    );

    // Board untouched: no project task listing.
    expect(calls.filter(c => /\/projects\//.test(c.url))).toHaveLength(0);
    // Slack untouched: no channel posts, no DM opens (Jesse never pinged).
    expect(fakeClient.chat.postMessage).not.toHaveBeenCalled();
    expect(fakeClient.conversations.open).not.toHaveBeenCalled();
    // Vikunja untouched: no writes of any kind.
    expect(calls.filter(c => c.opts.method === 'POST' || c.opts.method === 'PUT')).toHaveLength(0);
    // LLM untouched.
    expect(generateReport).not.toHaveBeenCalled();
  });

  test('proceeds to work the board when the lock is acquired', async () => {
    const board = [{ id: 8, title: 'Write the launch post', description: CONTRACTED, done: false, priority: 1 }];
    mockFetch(async (url) => {
      if (/\/projects\/2\/tasks/.test(url)) return okJson(board);
      return okJson({});
    });

    await we.runCycle();

    expect(lock.acquireLock).toHaveBeenCalledTimes(1);
    // The top actionable task was actually worked (deliverable generated).
    expect(generateWithTools).toHaveBeenCalledTimes(1);
    expect(generateWithTools.mock.calls[0][0].context).toMatch('Write the launch post');
  });

  test('never tries to work the lock task itself', async () => {
    const board = [
      {
        id: 7,
        title: LOCK_TITLE,
        description: JSON.stringify({ holder: 'someone-else:1', heartbeat: new Date().toISOString() }),
        done: false,
        priority: 5, // highest priority — must STILL be skipped
      },
      { id: 8, title: 'Write the launch post', description: CONTRACTED, done: false, priority: 1 },
    ];
    mockFetch(async (url) => {
      if (/\/projects\/2\/tasks/.test(url)) return okJson(board);
      return okJson({});
    });

    await we.runCycle();

    // Exactly one task worked, and it is the real task — not the lock.
    expect(generateWithTools).toHaveBeenCalledTimes(1);
    const context = generateWithTools.mock.calls[0][0].context;
    expect(context).toMatch('Write the launch post');
    expect(context).not.toMatch(/ENGINE LOCK/);
  });

  test('a board containing ONLY the lock task does not work anything', async () => {
    const board = [
      {
        id: 7,
        title: LOCK_TITLE,
        description: JSON.stringify({ holder: 'someone-else:1', heartbeat: new Date().toISOString() }),
        done: false,
        priority: 5,
      },
    ];
    mockFetch(async (url) => {
      if (/\/projects\/2\/tasks/.test(url)) return okJson(board);
      return okJson({});
    });

    await we.runCycle();

    // Nothing actionable -> the lock task itself must never be worked.
    // (generateReport MAY be called once by the idle-proposal path — that
    // is the engine inventing new work on an empty board, not working the
    // lock task, and its context must not mention the lock either.)
    for (const call of generateWithTools.mock.calls) {
      expect(call[0].context || '').not.toMatch(/ENGINE LOCK/);
    }
    for (const call of generateReport.mock.calls) {
      expect(call[0].context || '').not.toMatch(/ENGINE LOCK/);
    }
  });

  test('watch mode: without an LLM it still pings Jesse-gated tasks but never works anything', async () => {
    isConfigured.mockReturnValue(false);
    // Let the DM open succeed so the ping path runs end to end.
    fakeClient.conversations.open.mockResolvedValue({ channel: { id: 'D123' } });
    fakeClient.chat.postMessage.mockResolvedValue({ ok: true, ts: '1' });
    const board = [
      // M3 (#771): the gate marker must LEAD the title (or be a bracketed
      // description tag) — a trailing marker no longer gates.
      { id: 9, title: 'JESSE ACTION — Renew domain', description: '', done: false, priority: 4 },
      { id: 8, title: 'Write the launch post', description: '', done: false, priority: 1 },
    ];
    mockFetch(async (url) => {
      if (/\/projects\/2\/tasks/.test(url)) return okJson(board);
      return okJson({});
    });

    await we.runCycle();

    expect(lock.acquireLock).toHaveBeenCalledTimes(1);
    // The Jesse-gated ping went out as a DM...
    expect(fakeClient.conversations.open).toHaveBeenCalledWith({ users: expect.any(String) });
    const dmText = fakeClient.chat.postMessage.mock.calls.map(c => c[0].text).join('\n');
    expect(dmText).toMatch(/JESSE ACTION/);
    // ...but no LLM task work happened: no report, no task work, no proposal.
    expect(generateReport).not.toHaveBeenCalled();
  });
});
