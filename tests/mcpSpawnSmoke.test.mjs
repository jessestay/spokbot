// US-FW-033 acceptance tests — pre-cutover MCP spawn smoke.
// Dependency-free (node:test). Run: node --test tests/
// The smoke spawns rewritten-path MCP servers exactly as mcpClient.js /
// capabilityAudit.js do and verifies the initialize + tools/list handshake,
// so a missing dependency in a new tree fails in staging, not at the W6 gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smoke = require(path.join(ROOT, 'slack-agents', 'engine', 'mcpSpawnSmoke.js'));
const SCRIPT = path.join(ROOT, 'slack-agents', 'engine', 'mcpSpawnSmoke.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-smoke-')); }

const GOOD_STUB = `'use strict';
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'stub', version: '0' } } }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } }) + '\\n');
    }
  }
});
`;

const BROKEN_STUB = `'use strict';\nrequire('definitely-missing-module-xyz');\n`;
const SILENT_STUB = `'use strict';\nsetInterval(() => {}, 1000);\n`;
const REFUSAL_STUB = `'use strict';\nconsole.error('macf-finance: refusing to start: MACF_ROLE must be "CFO"');\nprocess.exit(1);\n`;

function writeStub(dir, name, src) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, src);
  return p;
}

function planFor(entry, extra = {}) {
  return smoke.buildSpawnPlan({
    grants: { servers: { stub: entry } },
    name: 'stub',
    frameworkRoot: extra.frameworkRoot || '/tree',
    dotEnv: extra.dotEnv || {},
    baseEnv: extra.baseEnv || {},
    role: extra.role,
    roleTokens: extra.roleTokens || {},
  });
}

// AC1 — spawn plan shape: verbatim command/args, cwd resolution, env expansion.
test('AC1: plan resolves cwd against the framework root and expands env from .env', () => {
  const plan = planFor(
    { command: 'node', args: ['/tree/x-mcp/dist/index.js'], cwd: 'hands', env: { X_API_KEY: '${X_API_KEY}', PLAIN: ' literal ' } },
    { dotEnv: { X_API_KEY: 'sekrit' }, baseEnv: { HOME: '/home/engine' }, role: 'CEO', roleTokens: { CEO: 'tok123' } },
  );
  assert.equal(plan.command, 'node');
  assert.deepEqual(plan.args, ['/tree/x-mcp/dist/index.js']);
  assert.equal(plan.cwd, path.join('/tree', 'hands'));
  assert.equal(plan.env.X_API_KEY, 'sekrit');
  assert.equal(plan.env.PLAIN, ' literal ');
  assert.equal(plan.env.HOME, '/home/engine');
  assert.equal(plan.env.MACF_ROLE, 'CEO');
  assert.equal(plan.env.MACF_ROLE_TOKEN, 'tok123');
});

test('AC1b: plan defaults cwd to hands/ and leaves unknown ${VARS} unexpanded', () => {
  const plan = planFor({ command: 'node', args: ['s.js'], env: { A: '${NOPE}' } });
  assert.equal(plan.cwd, path.join('/tree', 'hands'));
  assert.equal(plan.env.A, '${NOPE}');
  assert.equal(plan.env.MACF_ROLE, undefined);
});

// AC2 — a healthy stub passes with its exact tool count.
test('AC2: a stub answering initialize + tools/list passes with tool count 3', async () => {
  const dir = tmpDir();
  const entry = writeStub(dir, 'good.js', GOOD_STUB);
  const plan = planFor({ command: 'node', args: [entry], cwd: '.' }, { frameworkRoot: dir });
  const res = await smoke.probeServer(plan, { timeoutMs: 5000 });
  assert.equal(res.status, 'pass', JSON.stringify(res));
  assert.equal(res.tools, 3);
});

// AC3 — a spawn death on a missing module is a FAIL with stderr evidence.
test('AC3: a stub dying on a missing module fails with stderr evidence', async () => {
  const dir = tmpDir();
  const entry = writeStub(dir, 'broken.js', BROKEN_STUB);
  const plan = planFor({ command: 'node', args: [entry], cwd: '.' }, { frameworkRoot: dir });
  const res = await smoke.probeServer(plan, { timeoutMs: 5000 });
  assert.equal(res.status, 'fail');
  assert.match(res.reason + res.stderrTail, /MODULE_NOT_FOUND|definitely-missing-module-xyz/);
});

// AC4 — a server that never answers fails on timeout.
test('AC4: a silent stub fails with a timeout reason', async () => {
  const dir = tmpDir();
  const entry = writeStub(dir, 'silent.js', SILENT_STUB);
  const plan = planFor({ command: 'node', args: [entry], cwd: '.' }, { frameworkRoot: dir });
  const res = await smoke.probeServer(plan, { timeoutMs: 400 });
  assert.equal(res.status, 'fail');
  assert.match(res.reason, /timeout/i);
});

// AC5 — a role refusal is its own class, not a dependency failure.
test('AC5: a role-refusing stub is classified role-refusal', async () => {
  const dir = tmpDir();
  const entry = writeStub(dir, 'refuse.js', REFUSAL_STUB);
  const plan = planFor({ command: 'node', args: [entry], cwd: '.' }, { frameworkRoot: dir });
  const res = await smoke.probeServer(plan, { timeoutMs: 5000 });
  assert.equal(res.status, 'role-refusal', JSON.stringify(res));
  assert.match(res.stderrTail, /MACF_ROLE/);
});

// AC6 — --seven selects exactly the §2.4 rewritten-path servers, in order.
test('AC6: selectServers --seven returns exactly the seven rewritten-path servers', () => {
  const names = smoke.selectServers({}, { seven: true });
  assert.deepEqual(names, ['desktop-commander', 'n8n-mcp', 'macf-finance', 'finance-files', 'desktop-agent', 'slack', 'x']);
});

// AC6b — the CLI exits 0 when all probed servers pass and 1 when one fails.
test('AC6b: CLI exit code follows the probe results', async () => {
  const dir = tmpDir();
  const good = writeStub(dir, 'good.js', GOOD_STUB);
  const broken = writeStub(dir, 'broken.js', BROKEN_STUB);
  const grantsPath = path.join(dir, 'grants.json');
  const run = (servers) => new Promise((resolve) => {
    fs.writeFileSync(grantsPath, JSON.stringify({ servers }));
    execFile('node', [SCRIPT, '--grants', grantsPath, '--root', dir, '--timeout', '5000'],
      { env: { ...process.env } }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout }));
  });
  const okRun = await run({ stub: { command: 'node', args: [good], cwd: '.' } });
  assert.equal(okRun.code, 0, okRun.stdout);
  assert.match(okRun.stdout, /stub\s+PASS\s+tools=3/);
  const badRun = await run({ stub: { command: 'node', args: [broken], cwd: '.' } });
  assert.equal(badRun.code, 1, badRun.stdout);
  assert.match(badRun.stdout, /stub\s+FAIL/);
});
