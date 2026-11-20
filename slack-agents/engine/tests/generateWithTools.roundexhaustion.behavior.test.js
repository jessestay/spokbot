/**
 * Round-exhaustion-with-work behavior tests (Oct 21, 2026).
 *
 * The error 'LLM returned empty response after retries' conflated two
 * failure shapes. (a) True empty-completion streaks: the model returned
 * nothing — the throw (and the caller's failure strike) is correct.
 * (b) Round exhaustion: the agent spent its rounds doing VERIFIED tool
 * work and the final summary turn came back empty or was consumed by a
 * deliverable-judgement continuation — task #105, Oct 21 16:44Z (seven
 * first-attempt tool turns, 7 ok receipts, ~30s of the 240s deadline,
 * then the throw and a failure strike for real work).
 *
 * Pins:
 *  (a) >=1 banked ok receipt + round exhaustion with the step deadline
 *      untouched → generateWithTools RETURNS a distinctly-classed
 *      failure (errorClass 'round_exhausted_with_work'), never throws;
 *  (b) zero successful receipts → the throw is exactly as before;
 *  (c) a deadline-burned exit throws even with receipts banked — the
 *      deadline, not the round count, was the binding constraint.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roundexh-test-'));
process.env.MACF_STATE_DIR = TMP;
process.env.MACF_RECEIPTS_FILE = path.join(TMP, '.receipts.jsonl');
process.env.MACF_TOOL_AUDIT_GAP_FILE = path.join(TMP, 'gaps.json');
delete process.env.ANTHROPIC_API_KEY; // litellm route → mocked below

const mockChat = jest.fn();
const mockChatTurn = jest.fn();
jest.mock('../../utils/litellm', () => ({
  isConfigured: () => true,
  chat: (...args) => mockChat(...args),
  chatTurn: (...args) => mockChatTurn(...args),
}));

const { generateWithTools } = require('../../utils/anthropic');
const { getSchema } = require('../../engine/deliverableSchemas');
const { SANDBOX } = require('../../utils/agentTools');

beforeEach(() => { mockChat.mockReset(); mockChatTurn.mockReset(); });
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('round exhaustion classification (gateway native loop)', () => {
  test('(a) banked receipts + rounds spent → returns round_exhausted_with_work, does not throw', async () => {
    let turn = 0;
    mockChatTurn.mockImplementation(async () => {
      turn++;
      if (turn === 1) return { text: '', toolCalls: [{ id: 'r1', toolName: 'fileWrite', args: { path: 'roundexh-a.txt', content: 'work product A' } }] };
      if (turn === 2) return { text: '', toolCalls: [{ id: 'r2', toolName: 'fileWrite', args: { path: 'roundexh-b.txt', content: 'work product B' } }] };
      // Final (no-tools) round: prose instead of the schema JSON — the
      // deliverable-judgement continuation consumes the last round and
      // the loop exits. Exactly task #105's shape.
      return { text: 'All done — I wrote the files and checked everything.', toolCalls: [] };
    });

    const result = await generateWithTools({
      systemPrompt: 'You are a test agent.', context: 'Write two files, then summarize.',
      maxTokens: 500, maxToolRounds: 2, agentId: 'cmo', taskId: 991001,
      outputSchema: getSchema('generic@v1'), schemaName: 'generic@v1',
    });

    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe('round_exhausted_with_work');
    expect(result.roundExhaustedWithWork).toBe(true);
    expect(result.okReceipts).toBe(2);
    expect(result.toolResults).toHaveLength(2);
    // The work really happened (the receipts are real, not asserted).
    expect(fs.readFileSync(path.join(SANDBOX, 'roundexh-a.txt'), 'utf8')).toBe('work product A');
    expect(fs.readFileSync(path.join(SANDBOX, 'roundexh-b.txt'), 'utf8')).toBe('work product B');
  });

  test('(b) zero successful receipts → throws the empty-streak error exactly as before', async () => {
    let turn = 0;
    mockChatTurn.mockImplementation(async () => {
      turn++;
      // Every tool call FAILS (missing files): toolResults is non-empty
      // but banks zero ok receipts — the predicate must not fire.
      return { text: '', toolCalls: [{ id: `f${turn}`, toolName: 'fileRead', args: { path: `missing-${turn}-991/nope.txt` } }] };
    });

    await expect(generateWithTools({
      systemPrompt: 'You are a test agent.', context: 'Read two missing files.',
      maxTokens: 500, maxToolRounds: 1, agentId: 'cmo', taskId: 991002,
    })).rejects.toMatchObject({ message: 'LLM returned empty response after retries', errorClass: 'no_result' });
  });

  test('(c) deadline-burned exit → throws even with receipts banked (shape a preserved)', async () => {
    process.env.MACF_STEP_DEADLINE_MS = '1';
    try {
      let turn = 0;
      mockChatTurn.mockImplementation(async () => {
        turn++;
        if (turn <= 2) return { text: '', toolCalls: [{ id: `d${turn}`, toolName: 'fileWrite', args: { path: `roundexh-d${turn}.txt`, content: 'x' } }] };
        return { text: 'Prose summary, not the deliverable JSON.', toolCalls: [] };
      });

      await expect(generateWithTools({
        systemPrompt: 'You are a test agent.', context: 'Write, then summarize.',
        maxTokens: 500, maxToolRounds: 2, agentId: 'cmo', taskId: 991003,
        outputSchema: getSchema('generic@v1'), schemaName: 'generic@v1',
      })).rejects.toMatchObject({ message: 'LLM returned empty response after retries', errorClass: 'no_result' });
    } finally {
      delete process.env.MACF_STEP_DEADLINE_MS;
    }
  });
});
