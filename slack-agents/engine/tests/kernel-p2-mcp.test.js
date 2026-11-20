// kernel-p2-mcp.test.js — #807 Phase 2 (US-P2.5): MCP wiring.
//
// hands/grants.json was a health-checked config that no delegation could
// reach. These tests pin the wiring: a granted agent's MCP tools appear
// in its tool loop and dispatch through the real grant/receipt choke
// point; agents without a grant for a server see none of its tools; a dead
// server degrades quietly. mcpClient is mocked (no real servers spawn);
// grants.json is the REAL file. NOTE (Oct 24 baseline): EVERY agent now
// inherits defaults.baseline_servers (canva included) — there is no longer
// a named agent with zero MCP servers; fail-closed applies to a missing
// agent id, which is what the second test pins.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-mcp-'));
process.env.MACF_STATE_DIR = TMP;
process.env.MACF_RECEIPTS_FILE = path.join(TMP, '.receipts.jsonl');
delete process.env.ANTHROPIC_API_KEY;

const mockChat = jest.fn();
const mockChatTurn = jest.fn();
jest.mock('../../utils/litellm', () => ({
  isConfigured: () => true,
  chat: (...args) => mockChat(...args),
  chatTurn: (...args) => mockChatTurn(...args),
}));

const mockListTools = jest.fn();
const mockInvokeTool = jest.fn();
jest.mock('../../engine/mcpClient', () => ({
  listTools: (...args) => mockListTools(...args),
  invokeTool: (...args) => mockInvokeTool(...args),
  closeAll: async () => {},
}));

const { generateWithTools } = require('../../utils/anthropic');

const CANVA_TOOLS = [{ name: 'create_design', description: 'Create a Canva design', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }];

beforeEach(() => {
  mockChat.mockReset(); mockChatTurn.mockReset();
  mockListTools.mockReset(); mockInvokeTool.mockReset();
  mockListTools.mockImplementation(async (server) => {
    if (server === 'canva') return CANVA_TOOLS;
    return [];
  });
  mockInvokeTool.mockResolvedValue({ content: [{ type: 'text', text: 'design created: https://canva.example/d/123' }] });
});
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('US-P2.5 — MCP grants wired into the delegation loop', () => {
  test('granted agent (cmo/canva) sees and can invoke its MCP tool', async () => {
    const seenTools = [];
    let turn = 0;
    mockChatTurn.mockImplementation(async (args) => {
      seenTools.push((args.tools || []).map(t => t.function.name));
      turn++;
      if (turn === 1) return { text: '', toolCalls: [{ id: 'm1', toolName: 'mcp_canva_create_design', args: { title: 'Workshop promo' } }] };
      return { text: 'Design created. [DEMO]', toolCalls: [] };
    });
    const result = await generateWithTools({
      systemPrompt: 'You are the CMO.', context: 'Make a design.',
      maxTokens: 500, agentId: 'cmo', taskId: 807,
    });
    expect(result.response).toMatch(/Design created/);
    expect(seenTools[0]).toContain('mcp_canva_create_design');
    expect(mockInvokeTool).toHaveBeenCalledWith('canva', 'create_design', { title: 'Workshop promo' });
    expect(result.toolResults.some(t => t.tool === 'mcp_canva_create_design' && t.result.ok)).toBe(true);
    // Receipt issued through the standard choke point:
    const receipts = fs.readFileSync(process.env.MACF_RECEIPTS_FILE, 'utf8');
    expect(receipts).toContain('mcp_canva_create_design');
  });

  test('baseline inheritance: lawyer sees baseline MCP tools (Oct 24 baseline)', async () => {
    const seenTools = [];
    mockChatTurn.mockImplementation(async (args) => {
      seenTools.push((args.tools || []).map(t => t.function.name));
      return { text: 'Memo done. [DEMO]', toolCalls: [] };
    });
    const result = await generateWithTools({
      systemPrompt: 'You are the Lawyer.', context: 'Write a memo.',
      maxTokens: 500, agentId: 'lawyer', taskId: 807,
    });
    expect(result.response).toMatch(/Memo done/);
    // Canva is in defaults.baseline_servers, so even a role with no
    // role-level MCP grants inherits it.
    expect(seenTools[0]).toContain('mcp_canva_create_design');
    // NOTE: mockListTools call counts are not asserted — anthropic.js caches
    // MCP tool lists across generateWithTools calls in the same process, so
    // a later agent may be served from cache without a fresh listTools call.
  });

  test('no agent id means no MCP tools (fail-closed for anonymous paths)', async () => {
    const seenTools = [];
    mockChatTurn.mockImplementation(async (args) => {
      seenTools.push((args.tools || []).map(t => t.function.name));
      return { text: 'Done. [DEMO]', toolCalls: [] };
    });
    const result = await generateWithTools({
      systemPrompt: 'You are anonymous.', context: 'Work.',
      maxTokens: 500, taskId: 807,
    });
    expect(result.response).toMatch(/Done/);
    expect(seenTools[0].some(n => n.startsWith('mcp_'))).toBe(false);
    expect(mockListTools).not.toHaveBeenCalled();
  });

  test('hallucinated MCP call for an ungranted server fails as permission', async () => {
    let turn = 0;
    mockChatTurn.mockImplementation(async () => {
      turn++;
      if (turn === 1) return { text: '', toolCalls: [{ id: 'h1', toolName: 'mcp_github_create_issue', args: { title: 'x' } }] };
      return { text: 'Understood, cannot do that. [DEMO]', toolCalls: [] };
    });
    const result = await generateWithTools({
      systemPrompt: 'You are the CMO.', context: 'Try something ungranted.',
      maxTokens: 500, agentId: 'cmo', taskId: 807,
    });
    const hallucinated = result.toolResults.find(t => t.tool === 'mcp_github_create_issue');
    expect(hallucinated).toBeTruthy();
    expect(hallucinated.result.ok).toBe(false);
    expect(hallucinated.result.errorClass).toBe('permission');
    expect(mockInvokeTool).not.toHaveBeenCalledWith('github', expect.anything(), expect.anything());
  });

  test('a dead MCP server degrades gracefully (cro/tavily down, run still completes)', async () => {
    mockListTools.mockRejectedValue(new Error('server unavailable'));
    mockChatTurn.mockResolvedValue({ text: 'Research summary done. [DEMO]', toolCalls: [] });
    const result = await generateWithTools({
      systemPrompt: 'You are the CRO.', context: 'Summarize.',
      maxTokens: 500, agentId: 'cro', taskId: 807,
    });
    expect(result.response).toMatch(/Research summary done/);
  });
});
