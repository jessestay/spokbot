/**
 * workEngine round-exhaustion behavior test (Oct 21, 2026).
 *
 * Companion to generateWithTools.roundexhaustion.behavior.test.js: when
 * a contracted task run banks verified tool receipts but exhausts its
 * rounds before producing the deliverable (task #105's shape), workTask
 * must record the run as round_exhausted_with_work — NO failure strike,
 * NO lifecycle attempt consumed — while still advancing lastWorked so
 * the picker backs off, and feeding the miss forward as structured
 * verification data for the next attempt.
 *
 * Modeled on workEngine-completion.behavior.test.js (Vikunja mocked,
 * model scripted through the litellm mock, text-emulation route).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'we-roundexh-'));
process.env.MACF_STATE_DIR = TMP;
process.env.MACF_RECEIPTS_FILE = path.join(TMP, '.receipts.jsonl');
process.env.MACF_TOOL_AUDIT_GAP_FILE = path.join(TMP, 'gaps.json');
delete process.env.ANTHROPIC_API_KEY;

const mockChat = jest.fn();
jest.mock('../../utils/litellm', () => ({
  isConfigured: () => true,
  chat: (...args) => mockChat(...args),
  // no chatTurn: the scripted route exercises text emulation, whose
  // final-answer call is one of the classified round-exhaustion sites.
}));

const mockCompleteTask = jest.fn().mockResolvedValue({});
const mockAddComment = jest.fn().mockResolvedValue({});
jest.mock('../../utils/vikunja', () => ({
  completeTask: (...a) => mockCompleteTask(...a),
  addComment: (...a) => mockAddComment(...a),
  getTask: jest.fn().mockResolvedValue(null),
  listTasks: jest.fn().mockResolvedValue([]),
}));

const workEngine = require('../workEngine');
const state = require('../../utils/state');

function contractBlock(contract) {
  return `\n<!-- MACF-CONTRACT\n${JSON.stringify(contract)}\nMACF-CONTRACT -->`;
}

beforeEach(() => {
  mockChat.mockReset();
  mockCompleteTask.mockClear();
  mockAddComment.mockClear();
  workEngine.drainRelayQueue();
});
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('contracted task: round exhaustion with banked work', () => {
  test('no strike, no lifecycle attempt, lastWorked advances, miss feeds forward', async () => {
    const id = 991011;
    const task = {
      id,
      title: 'Evaluate the pricing report',
      description: 'Evaluate the pricing report and write the findings file.' + contractBlock({
        version: 1,
        taskId: id,
        executor: null,
        requiredTools: [{ tool: 'fileList', minSuccess: 1 }],
        postconditions: [{ type: 'receipt_count', tool: '*', status: 'ok', min: 1 }],
        deliverable: { schema: 'generic@v1' },
        maxAttempts: 3,
      }),
    };

    // Script: every tool round does real, successful tool work
    // (fileList → ok receipt). After the rounds are spent, the final
    // summary call comes back empty on all retries — the run dies at
    // its summary turn with a full receipts ledger.
    let calls = 0;
    mockChat.mockImplementation(async () => {
      calls++;
      if (calls <= 6) return '[TOOL: fileList] {"path":"."}';
      return '';
    });

    await workEngine.workTask(task);

    // No failure strike was recorded for the productive run.
    expect(state.get('workEngine', `failStrikes.${id}`) || []).toHaveLength(0);
    expect(workEngine.isParked(id)).toBe(false);
    // lastWorked advanced, so the picker backs off normally.
    expect(state.get('workEngine', `lastWorked.${id}`)).toBeTruthy();
    // Lifecycle: still WORKING, no attempt consumed, and the miss is
    // recorded as structured feed-forward for the next attempt.
    const lifecycle = state.get('workEngine', `taskLifecycle.${id}`);
    expect(lifecycle.state).toBe('WORKING');
    expect(lifecycle.attempts || 0).toBe(0);
    expect(lifecycle.lastVerification).toHaveLength(1);
    expect(lifecycle.lastVerification[0].type).toBe('round_exhausted_with_work');
    // Nothing was completed or commented as a delivery.
    expect(mockCompleteTask).not.toHaveBeenCalled();
  }, 30000);
});
