/**
 * engine/tests/hands-servers.test.js
 *
 * US-FW-016 / F12 Step D — first automated coverage for the
 * first-party hands/ MCP servers beyond linkedin/x:
 *   - hands/servers/desktop        (desktop-agent: desktop_health,
 *                                   desktop_run, desktop_log)
 *   - hands/servers/finance-files  (4 read + 2 write finance tools)
 *   - hands/servers/finance        (macf-finance: PayPal read-only)
 *   - hands/servers/slack/launch.js (launcher fail-closed paths)
 * plus unit tests for the two dependency-free paths.js resolvers,
 * whose headers say they were kept dependency-free precisely so the
 * resolution is unit-testable — no suite ever did.
 *
 * Method: the servers are spawned as real processes and driven
 * over stdio with raw newline-delimited JSON-RPC (initialize →
 * tools/list → tools/call), the same wire the MCP client uses.
 * Role gates are exercised through the servers' documented env
 * contract (MACF_ROLE / MACF_ROLE_TOKEN / MACF_<ROLE>_ROLE_TOKEN),
 * with synthetic probe tokens — the tree's real hands/.role-tokens
 * is never read by these tests. finance-files runs against a temp
 * SPOKBOT_FINANCE_DIR; macf-finance runs with no PayPal credentials
 * so its tools take their coded "not configured" path. Nothing
 * here contacts the desktop, PayPal, or any network service.
 *
 * Module resolution: in a deployed tree the servers resolve
 * @modelcontextprotocol/sdk from hands/node_modules; a bare
 * framework tree has none, so the spawn env carries NODE_PATH
 * pointing at slack-agents/node_modules (SDK 1.31.0, the version
 * hands/package.json declares) as the fallback. Local node_modules
 * still win wherever they exist.
 *
 * NOT covered (recorded in the Step D report): the mcp-remote
 * wrapper servers in grants (canva, buffer, …) — third-party
 * packages behind npx + OAuth with no first-party code in this
 * tree; their grants-shape/spawn contract is US-FW-033's. The
 * vendored hands/servers/linkedin project ships its own tests.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SA_ROOT = path.resolve(__dirname, '..', '..');
const FW_ROOT = path.resolve(SA_ROOT, '..');
const HANDS = path.join(FW_ROOT, 'hands');
const SDK_FALLBACK = path.join(SA_ROOT, 'node_modules');

const DESKTOP_ENTRY = path.join(HANDS, 'servers', 'desktop', 'index.js');
const FINFILES_ENTRY = path.join(HANDS, 'servers', 'finance-files', 'index.js');
const FINANCE_ENTRY = path.join(HANDS, 'servers', 'finance', 'index.js');
const SLACK_LAUNCH = path.join(HANDS, 'servers', 'slack', 'launch.js');

function baseEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: os.homedir(),
    NODE_PATH: SDK_FALLBACK,
    ...extra,
  };
}

// ── Minimal stdio JSON-RPC driver ──────────────────────────────────
function startServer(entry, env) {
  const child = spawn('node', [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let buf = '';
  const pending = new Map();
  const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out; stderr so far: ${stderr.slice(-300)}`)), 8000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async function initialize() {
    const res = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'hands-servers-probe', version: '0.1.0' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return res;
  }
  return {
    child,
    request,
    initialize,
    exitPromise,
    stderr: () => stderr,
    stop: () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } },
  };
}

async function expectRefusal(entry, env, stderrNeedle) {
  const s = startServer(entry, env);
  const code = await Promise.race([
    s.exitPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('server did not exit within 5s')), 5000)),
  ]).finally(() => s.stop());
  expect(code).toBe(2);
  expect(s.stderr()).toContain(stderrNeedle);
}

// ── paths.js unit tests (no server, no SDK) ────────────────────────
describe('hands paths.js resolvers (US-FW-002 pattern)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ['DESKTOP_RUN_CLIENT', 'SPOKBOT_FINANCE_DIR']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  test('desktopRunClient: DESKTOP_RUN_CLIENT env wins verbatim', () => {
    process.env.DESKTOP_RUN_CLIENT = '/probe/desktop-run';
    const { desktopRunClient } = require('../../../hands/servers/desktop/paths');
    expect(desktopRunClient()).toBe('/probe/desktop-run');
  });

  test('desktopRunClient: default is the home-workspace desktop-agent client', () => {
    delete process.env.DESKTOP_RUN_CLIENT;
    const { desktopRunClient } = require('../../../hands/servers/desktop/paths');
    expect(desktopRunClient()).toBe(
      path.join(os.homedir(), 'workspace', 'desktop-agent', 'bin', 'desktop-run'));
  });

  test('financeDir: SPOKBOT_FINANCE_DIR env wins verbatim', () => {
    process.env.SPOKBOT_FINANCE_DIR = '/probe/finance';
    const { financeDir } = require('../../../hands/servers/finance-files/paths');
    expect(financeDir()).toBe('/probe/finance');
  });

  test('financeDir: default is $HOME/workspace/agent-sandbox/finance', () => {
    delete process.env.SPOKBOT_FINANCE_DIR;
    const { financeDir } = require('../../../hands/servers/finance-files/paths');
    expect(financeDir()).toBe(
      path.join(os.homedir(), 'workspace', 'agent-sandbox', 'finance'));
  });
});

// ── desktop-agent ──────────────────────────────────────────────────
describe('desktop-agent server (hands/servers/desktop)', () => {
  test('role gate: a non-granted role is refused at startup, exit 2', async () => {
    await expectRefusal(DESKTOP_ENTRY, baseEnv({ MACF_ROLE: 'CMO' }),
      'REFUSED: MACF_ROLE CMO is not granted desktop access');
  });

  test('role gate: granted role with a wrong token is refused, exit 2', async () => {
    await expectRefusal(DESKTOP_ENTRY, baseEnv({
      MACF_ROLE: 'CTO', MACF_CTO_ROLE_TOKEN: 'probe-expected', MACF_ROLE_TOKEN: 'probe-wrong',
    }), 'REFUSED: invalid role token');
  });

  describe('serving (no role set: grants layer-1 context)', () => {
    let s;
    beforeAll(async () => {
      s = startServer(DESKTOP_ENTRY, baseEnv());
      await s.initialize();
    });
    afterAll(() => s.stop());

    test('initialize reports server name desktop-agent', async () => {
      const res = await s.request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p', version: '0' },
      });
      expect(res.result.serverInfo.name).toBe('desktop-agent');
    });

    test('tools/list is exactly desktop_health, desktop_run, desktop_log', async () => {
      const res = await s.request('tools/list', {});
      const tools = res.result.tools;
      expect(tools.map((t) => t.name)).toEqual(['desktop_health', 'desktop_run', 'desktop_log']);
      const run = tools.find((t) => t.name === 'desktop_run');
      expect(run.inputSchema.required).toEqual(['command']);
    });

    test('desktop_health without DESKTOP_RUN_TOKEN errors honestly, never fabricates', async () => {
      const res = await s.request('tools/call', { name: 'desktop_health', arguments: {} });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain('DESKTOP_RUN_TOKEN not configured');
      expect(res.result.content[0].text).toContain('Not fabricating output');
    });

    test('unknown tool is an error naming the tool', async () => {
      const res = await s.request('tools/call', { name: 'desktop_nope', arguments: {} });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain('Unknown tool: desktop_nope');
    });
  });
});

// ── finance-files ──────────────────────────────────────────────────
describe('finance-files server (hands/servers/finance-files)', () => {
  test('fail closed: no MACF_ROLE at all is refused, exit 2', async () => {
    await expectRefusal(FINFILES_ENTRY, baseEnv(),
      'REFUSED: MACF_ROLE must be CFO or CEO');
  });

  test('fail closed: CFO with a wrong token is refused, exit 2', async () => {
    await expectRefusal(FINFILES_ENTRY, baseEnv({
      MACF_ROLE: 'CFO', MACF_CFO_ROLE_TOKEN: 'probe-expected', MACF_ROLE_TOKEN: 'probe-wrong',
    }), 'REFUSED: invalid role token');
  });

  describe('serving as CFO against a temp finance dir', () => {
    let s;
    let dir;
    const auth = { MACF_ROLE: 'CFO', MACF_CFO_ROLE_TOKEN: 'probe-token', MACF_ROLE_TOKEN: 'probe-token' };
    beforeAll(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macf-finance-files-'));
      s = startServer(FINFILES_ENTRY, baseEnv({ ...auth, SPOKBOT_FINANCE_DIR: dir }));
      await s.initialize();
    });
    afterAll(() => { s.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

    test('tools/list is exactly the 4 read + 2 write tools', async () => {
      const res = await s.request('tools/list', {});
      expect(res.result.tools.map((t) => t.name)).toEqual([
        'finance_snapshot_read', 'finance_obligations_read', 'finance_income_read',
        'finance_flags_read', 'finance_obligation_upsert', 'finance_income_append',
      ]);
    });

    test('reading a missing file errors with "Not fabricating data."', async () => {
      const res = await s.request('tools/call', { name: 'finance_snapshot_read', arguments: {} });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain('finance-files read failed for finance-snapshot.md');
      expect(res.result.content[0].text).toContain('Not fabricating data.');
    });

    test('obligation upsert: add, then update by name, preserving the file shape', async () => {
      fs.writeFileSync(path.join(dir, 'obligations.json'), JSON.stringify({ obligations: [] }));
      const add = await s.request('tools/call', {
        name: 'finance_obligation_upsert',
        arguments: { name: 'Probe Creditor', amount: 42.5, due: '2027-01-15' },
      });
      expect(add.result.isError).toBeFalsy();
      expect(add.result.content[0].text).toContain('obligations.json added');
      const upd = await s.request('tools/call', {
        name: 'finance_obligation_upsert',
        arguments: { name: 'Probe Creditor', amount: 50, due: '2027-01-15', paid: true },
      });
      expect(upd.result.content[0].text).toContain('obligations.json updated');
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'obligations.json'), 'utf8'));
      expect(saved.obligations).toEqual([{ name: 'Probe Creditor', amount: 50, due: '2027-01-15', paid: true }]);
    });

    test('obligation upsert validation: bad date and missing amount are errors', async () => {
      const badDate = await s.request('tools/call', {
        name: 'finance_obligation_upsert',
        arguments: { name: 'X', amount: 1, due: '15-01-2027' },
      });
      expect(badDate.result.isError).toBe(true);
      expect(badDate.result.content[0].text).toContain('due must be a valid date in YYYY-MM-DD form');
      const noAmount = await s.request('tools/call', {
        name: 'finance_obligation_upsert',
        arguments: { name: 'X', due: '2027-01-15' },
      });
      expect(noAmount.result.isError).toBe(true);
      expect(noAmount.result.content[0].text).toContain('amount is required and must be a finite number');
    });

    test('income append writes one JSONL record and the read tool returns it', async () => {
      const app = await s.request('tools/call', {
        name: 'finance_income_append',
        arguments: { date: '2026-11-19', source: 'Probe Source', amount: 10, status: 'received' },
      });
      expect(app.result.isError).toBeFalsy();
      const lines = fs.readFileSync(path.join(dir, 'income-ledger.jsonl'), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual(
        { date: '2026-11-19', source: 'Probe Source', amount: 10, status: 'received' });
      const read = await s.request('tools/call', { name: 'finance_income_read', arguments: {} });
      expect(read.result.content[0].text).toContain('income-ledger.jsonl (last modified');
      expect(read.result.content[0].text).toContain('Probe Source');
    });

    test('unknown tool is an error naming the tool', async () => {
      const res = await s.request('tools/call', { name: 'finance_nope', arguments: {} });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain('Unknown tool: finance_nope');
    });
  });
});

// ── macf-finance ───────────────────────────────────────────────────
describe('macf-finance server (hands/servers/finance)', () => {
  test('fail closed: CEO is refused — CFO only, exit 2', async () => {
    await expectRefusal(FINANCE_ENTRY, baseEnv({
      MACF_ROLE: 'CEO', MACF_CEO_ROLE_TOKEN: 'probe-token', MACF_ROLE_TOKEN: 'probe-token',
    }), 'REFUSED: MACF_ROLE must be CFO');
  });

  describe('serving as CFO with no PayPal credentials', () => {
    let s;
    beforeAll(async () => {
      s = startServer(FINANCE_ENTRY, baseEnv({
        MACF_ROLE: 'CFO', MACF_CFO_ROLE_TOKEN: 'probe-token', MACF_ROLE_TOKEN: 'probe-token',
      }));
      await s.initialize();
    });
    afterAll(() => s.stop());

    test('tools/list is exactly the two read-only PayPal tools', async () => {
      const res = await s.request('tools/list', {});
      expect(res.result.tools.map((t) => t.name)).toEqual(
        ['finance_transactions_read', 'finance_balance_read']);
    });

    test('balance read without PayPal credentials errors honestly', async () => {
      const res = await s.request('tools/call', { name: 'finance_balance_read', arguments: {} });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain('PayPal API credentials not configured');
      expect(res.result.content[0].text).toContain('Not fabricating data.');
    });

    test('unknown tool is an error naming the tool', async () => {
      const res = await s.request('tools/call', { name: 'finance_nope', arguments: {} });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain('ERROR: Unknown tool: finance_nope');
    });
  });
});

// ── slack launcher ─────────────────────────────────────────────────
// In a deployed tree slack-agents/.env exists and the launcher goes
// on to spawn the real slack-mcp-server binary; that path needs the
// real token + binary and is not probed here. The framework tree
// has no .env, so the launcher's first fail-closed path is the one
// this tree can pin.
describe('slack launcher (hands/servers/slack/launch.js)', () => {
  const envPresent = fs.existsSync(path.join(SA_ROOT, '.env'));
  const itHere = envPresent ? test.skip : test;
  itHere('fails closed with exit 1 when slack-agents/.env is unreadable', async () => {
    const s = startServer(SLACK_LAUNCH, baseEnv());
    const code = await Promise.race([
      s.exitPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('launcher did not exit within 5s')), 5000)),
    ]).finally(() => s.stop());
    expect(code).toBe(1);
    expect(s.stderr()).toContain('slack launch: cannot read .env');
  });
});
