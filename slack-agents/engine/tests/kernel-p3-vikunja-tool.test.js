// kernel-p3-vikunja-tool.test.js — Vikunja agent tools (Oct 21, 2026, CEO
// mechanism repair). Agents had no path to the board: utils/vikunja.js is
// engine-internal and webFetch cannot send Authorization headers, so
// execPM's API calls 401'd. The agentTools Vikunja tools hold the token
// server-side (VIKUNJA_TOKEN from the engine env) and are role-granted to
// the whole working team. Tests run the REAL tools against a local HTTP
// stub (real curl, real auth header) — no live board is touched.
const fs0 = require('fs');
const os0 = require('os');
const path0 = require('path');
const TMP_STATE = fs0.mkdtempSync(path0.join(os0.tmpdir(), 'p3-vik-test-'));
process.env.MACF_STATE_DIR = TMP_STATE;
process.env.MACF_RECEIPTS_FILE = path0.join(TMP_STATE, '.receipts.jsonl');
process.env.MACF_TOOL_AUDIT_GAP_FILE = path0.join(TMP_STATE, 'gaps.json');

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { executeTool } = require('../../utils/agentTools');

const LAST_FILE = path.join(TMP_STATE, 'vik-stub-last.json');
let stubProc = null;
function readLast() {
  try { return JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')); } catch { return null; }
}

beforeAll(async () => {
  stubProc = spawn(process.execPath, [path.join(__dirname, 'kernel-p3-vikunja-stub.js')], {
    env: { ...process.env, VIK_STUB_LAST: LAST_FILE },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    stubProc.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/PORT=(\d+)/);
      if (m) resolve(parseInt(m[1], 10));
    });
    stubProc.on('exit', () => reject(new Error('stub exited early')));
    setTimeout(() => reject(new Error('stub start timeout')), 10000);
  });
  process.env.VIKUNJA_URL = `http://127.0.0.1:${port}`;
  process.env.VIKUNJA_TOKEN = 'test-token-123';
});

afterAll(() => {
  if (stubProc) stubProc.kill();
  try { fs.rmSync(TMP_STATE, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Vikunja agent tools — role gate', () => {
  test('ungranted agent is refused with errorClass permission', () => {
    const r = executeTool('vikunjaGetTask', { taskId: 834 }, { agentId: 'stranger', taskId: 834 });
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe('permission');
  });

  test('missing agentId is refused (fail closed)', () => {
    const r = executeTool('vikunjaGetTask', { taskId: 834 }, {});
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe('permission');
  });

  test.each(['execPM', 'cto', 'cmo', 'cco', 'cfo', 'cro', 'cuxo', 'lawyer', 'jobcoach', 'hr', 'facebook'])(
    'granted role %s can read a task', (agentId) => {
      const r = executeTool('vikunjaGetTask', { taskId: 834 }, { agentId, taskId: 834 });
      expect(r.ok).toBe(true);
      expect(r.id).toBe(834);
    });
});

describe('Vikunja agent tools — behavior against the stub', () => {
  test('vikunjaGetTask returns the shaped task with recent comments', () => {
    const r = executeTool('vikunjaGetTask', { taskId: 834 }, { agentId: 'execPM', taskId: 834 });
    expect(r.ok).toBe(true);
    expect(r.title).toMatch(/burn-down/);
    expect(r.description).toBe('Full brief here');
    expect(r.assignees).toEqual([{ id: 2, username: 'execpm' }]);
    expect(r.commentCount).toBe(1);
    expect(r.comments[0].id).toBe(55);
  });

  test('vikunjaListTasks sends the done filter and the bearer header', () => {
    const r = executeTool('vikunjaListTasks', { projectId: 2, done: false }, { agentId: 'execPM', taskId: 1 });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
    const last = readLast();
    expect(last.auth).toBe('Bearer test-token-123');
    expect(decodeURIComponent(last.url)).toContain('filter=done = false');
  });

  test('vikunjaComment PUTs the comment and never leaks the token', () => {
    const r = executeTool('vikunjaComment', { taskId: 834, comment: 'triage note' }, { agentId: 'execPM', taskId: 834 });
    expect(r.ok).toBe(true);
    expect(r.commentId).toBe(999);
    const last = readLast();
    expect(last.method).toBe('PUT');
    expect(JSON.parse(last.body).comment).toBe('triage note');
    expect(JSON.stringify(r)).not.toContain('test-token-123');
  });

  test('vikunjaAttachEvidence posts an EVIDENCE comment', () => {
    const r = executeTool('vikunjaAttachEvidence', { taskId: 834, evidence: 'https://example.com/proof', label: 'demo' }, { agentId: 'cmo', taskId: 834 });
    expect(r.ok).toBe(true);
    expect(r.evidence).toBe(true);
    const last = readLast();
    expect(JSON.parse(last.body).comment).toMatch(/^EVIDENCE — demo/);
    expect(JSON.parse(last.body).comment).toContain('https://example.com/proof');
  });

  test('vikunjaUpdateTask merges over the current task (title, description, assignees preserved)', () => {
    const r = executeTool('vikunjaUpdateTask', { taskId: 834, priority: 4 }, { agentId: 'execPM', taskId: 834 });
    expect(r.ok).toBe(true);
    expect(r.priority).toBe(4);
    const last = readLast();
    expect(last.method).toBe('POST');
    const posted = JSON.parse(last.body);
    expect(posted.title).toMatch(/burn-down/);
    expect(posted.description).toBe('Full brief here');
    expect(posted.assignees).toEqual([{ id: 2 }]);
    expect(posted.priority).toBe(4);
  });

  test('vikunjaUpdateTask cannot write done (no such arg — schema rejects it)', () => {
    const r = executeTool('vikunjaUpdateTask', { taskId: 834, done: true }, { agentId: 'execPM', taskId: 834 });
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe('invalid_input');
    expect(r.correction.unknown).toEqual(['done']);
  });

  test('schema validation: missing taskId is a correction, fn never invoked', () => {
    const r = executeTool('vikunjaGetTask', {}, { agentId: 'execPM', taskId: 1 });
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe('invalid_input');
    expect(r.correction.missing).toEqual(['taskId']);
  });

  test('missing VIKUNJA_TOKEN fails as missing_credential, token-free error', () => {
    const saved = process.env.VIKUNJA_TOKEN;
    delete process.env.VIKUNJA_TOKEN;
    try {
      const r = executeTool('vikunjaGetTask', { taskId: 834 }, { agentId: 'execPM', taskId: 834 });
      expect(r.ok).toBe(false);
      expect(r.errorClass).toBe('missing_credential');
    } finally {
      process.env.VIKUNJA_TOKEN = saved;
    }
  });
});
