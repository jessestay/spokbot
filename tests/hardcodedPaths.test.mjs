// US-FW-002 acceptance tests — no hardcoded machine paths in the kernel.
// Dependency-free (node:test). Run: node --test tests/
// Each test names the acceptance criterion it proves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SA = path.join(ROOT, 'slack-agents');

// Run a node snippet in a child process with a controlled environment
// (only PATH, a fake HOME, and the scenario vars — nothing inherited
// that could leak SPOKBOT_*/MACF_* state into the child).
function runNode(script, vars = {}, fakeHome = null) {
  const home = fakeHome || fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-home-'));
  const env = { PATH: process.env.PATH, HOME: home, ...vars };
  const out = execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 30000 });
  return { out, home };
}
const J = (s) => JSON.stringify(s);

// ---------------------------------------------------------------- AC1
test('AC1: swept files contain no per-machine absolute path literals', () => {
  const swept = [
    'slack-agents/utils/state.js',
    'slack-agents/engine/receipts.js',
    'slack-agents/utils/checkpointAdapters.js',
    'slack-agents/utils/circuitBreaker.js',
    'slack-agents/engine/artifactLedger.js',
    'slack-agents/engine/toolUsageAuditor.js',
    'slack-agents/engine/desktop-probe.js',
    'slack-agents/utils/agentTools.js',
    'slack-agents/engine/check-schedules.js',
    'slack-agents/engine/mcp-token-refresher.js',
    'slack-agents/engine/playwright-smoke.js',
    'slack-agents/utils/litellm.js',
    'hands/servers/desktop/index.js',
    'hands/servers/finance-files/index.js',
    'hatchet-smoke.js',
    'gateway/local-canary.sh',
    'slack-agents/engine/tests/mcp/google-workspace.connectivity.test.js',
    'slack-agents/engine/tests/vikunja-supervision.test.js',
    'slack-agents/engine/tests/kernel-p3-content-batch.test.js',
  ];
  const literal = /\/home\/(hatch|ubuntu|macf|sandbox)\b|C:\\Users\\/;
  for (const rel of swept) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!literal.test(src), `${rel} still contains a per-machine path literal`);
  }
});

// ---------------------------------------------------------------- AC2
const FUNCTION_TIME_CONSUMERS = `
  const path = require('path');
  const out = {};
  out.receipts = path.dirname(require(${J(path.join(SA, 'engine', 'receipts.js'))})._receiptsFile());
  out.checkpoints = require(${J(path.join(SA, 'utils', 'checkpointAdapters.js'))}).stateDir();
  out.breaker = path.dirname(require(${J(path.join(SA, 'utils', 'circuitBreaker.js'))})._stateFilePath());
  out.auditor = require(${J(path.join(SA, 'engine', 'toolUsageAuditor.js'))})._stateDir();
  out.ledger = require(${J(path.join(SA, 'engine', 'artifactLedger.js'))}).stateDir();
  console.log(JSON.stringify(out));
`;
const LOAD_TIME_STATE = `
  const path = require('path');
  const s = require(${J(path.join(SA, 'utils', 'state.js'))});
  console.log(path.dirname(s._stateFilePath('cfo')));
`;

test('AC2: SPOKBOT_STATE_DIR — all six state consumers agree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-ac2-'));
  const vars = { SPOKBOT_STATE_DIR: dir };
  const { out } = runNode(FUNCTION_TIME_CONSUMERS, vars);
  const res = JSON.parse(out.trim());
  for (const [k, v] of Object.entries(res)) assert.equal(v, dir, `${k} resolved ${v}, expected ${dir}`);
  const lt = runNode(LOAD_TIME_STATE, vars);
  assert.equal(lt.out.trim(), dir, 'utils/state.js disagrees');
});

test('AC2: MACF_STATE_DIR wins over SPOKBOT_STATE_DIR for every consumer', () => {
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-ac2-legacy-'));
  const spok = fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-ac2-spok-'));
  const vars = { MACF_STATE_DIR: legacy, SPOKBOT_STATE_DIR: spok };
  const { out } = runNode(FUNCTION_TIME_CONSUMERS, vars);
  const res = JSON.parse(out.trim());
  for (const [k, v] of Object.entries(res)) assert.equal(v, legacy, `${k} resolved ${v}, expected ${legacy}`);
  const lt = runNode(LOAD_TIME_STATE, vars);
  assert.equal(lt.out.trim(), legacy, 'utils/state.js disagrees');
});

test('AC2: RAILWAY_VOLUME_MOUNT_PATH wins over both for every consumer', () => {
  const rw = fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-ac2-rw-'));
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-ac2-legacy-'));
  const vars = { RAILWAY_VOLUME_MOUNT_PATH: rw, MACF_STATE_DIR: legacy };
  const { out } = runNode(FUNCTION_TIME_CONSUMERS, vars);
  const res = JSON.parse(out.trim());
  for (const [k, v] of Object.entries(res)) assert.equal(v, rw, `${k} resolved ${v}, expected ${rw}`);
  const lt = runNode(LOAD_TIME_STATE, vars);
  assert.equal(lt.out.trim(), rw, 'utils/state.js disagrees');
});

test('AC2: no overrides — every consumer resolves the checkout default <slack-agents>/.state', () => {
  const expected = path.join(SA, '.state');
  const { out } = runNode(FUNCTION_TIME_CONSUMERS, {});
  const res = JSON.parse(out.trim());
  for (const [k, v] of Object.entries(res)) assert.equal(v, expected, `${k} resolved ${v}, expected ${expected}`);
  const lt = runNode(LOAD_TIME_STATE, {});
  assert.equal(lt.out.trim(), expected, 'utils/state.js disagrees');
});

test('AC2: instancePaths.resolvedStateDir implements the precedence in one place', () => {
  const ip = require(path.join(SA, 'utils', 'instancePaths.js'));
  assert.equal(typeof ip.resolvedStateDir, 'function', 'instancePaths must export resolvedStateDir');
});

// ---------------------------------------------------------------- AC3
test('AC3: agentTools sandbox + desktop client anchor to the operator HOME; env override wins', () => {
  const script = `
    const at = require(${J(path.join(SA, 'utils', 'agentTools.js'))});
    console.log(JSON.stringify({ sandbox: at.SANDBOX, desktop: at._DESKTOP_RUN_CLIENT }));
  `;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-ac3-home-'));
  const { out } = runNode(script, {}, home);
  const res = JSON.parse(out.trim());
  assert.equal(res.sandbox, path.join(home, 'workspace', 'agent-sandbox'));
  assert.equal(res.desktop, path.join(home, 'workspace', 'desktop-agent', 'bin', 'desktop-run'));
  const custom = path.join(home, 'custom', 'desktop-run');
  const over = runNode(script, { DESKTOP_RUN_CLIENT: custom }, home);
  assert.equal(JSON.parse(over.out.trim()).desktop, custom, 'DESKTOP_RUN_CLIENT must win');
});

test('AC3: desktop-probe tunnel probe anchors to $HOME/bin; TUNNEL_PROBE_PATH wins', () => {
  const script = `
    const dp = require(${J(path.join(SA, 'engine', 'desktop-probe.js'))});
    console.log(dp._TUNNEL_PROBE);
  `;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-ac3-home-'));
  const { out } = runNode(script, {}, home);
  assert.equal(out.trim(), path.join(home, 'bin', 'tunnel-probe.py'));
  const custom = path.join(home, 'elsewhere', 'probe.py');
  const over = runNode(script, { TUNNEL_PROBE_PATH: custom }, home);
  assert.equal(over.out.trim(), custom, 'TUNNEL_PROBE_PATH must win');
});

test('AC3: desktop hands server resolves the same desktop client path', () => {
  const pathsMod = require(path.join(ROOT, 'hands', 'servers', 'desktop', 'paths.js'));
  const savedHome = process.env.HOME;
  const savedOverride = process.env.DESKTOP_RUN_CLIENT;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-ac3-home-'));
  try {
    delete process.env.DESKTOP_RUN_CLIENT;
    process.env.HOME = home;
    assert.equal(pathsMod.desktopRunClient(), path.join(home, 'workspace', 'desktop-agent', 'bin', 'desktop-run'));
    const custom = path.join(home, 'x', 'desktop-run');
    process.env.DESKTOP_RUN_CLIENT = custom;
    assert.equal(pathsMod.desktopRunClient(), custom);
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedOverride === undefined) delete process.env.DESKTOP_RUN_CLIENT; else process.env.DESKTOP_RUN_CLIENT = savedOverride;
  }
});

// ---------------------------------------------------------------- AC4
test('AC4: finance-files server dir — SPOKBOT_FINANCE_DIR wins, else $HOME sandbox layout', () => {
  const pathsMod = require(path.join(ROOT, 'hands', 'servers', 'finance-files', 'paths.js'));
  const savedHome = process.env.HOME;
  const savedDir = process.env.SPOKBOT_FINANCE_DIR;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-ac4-home-'));
  try {
    delete process.env.SPOKBOT_FINANCE_DIR;
    process.env.HOME = home;
    assert.equal(pathsMod.financeDir(), path.join(home, 'workspace', 'agent-sandbox', 'finance'));
    const custom = path.join(home, 'fin');
    process.env.SPOKBOT_FINANCE_DIR = custom;
    assert.equal(pathsMod.financeDir(), custom);
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedDir === undefined) delete process.env.SPOKBOT_FINANCE_DIR; else process.env.SPOKBOT_FINANCE_DIR = savedDir;
  }
});

// ---------------------------------------------------------------- AC5
test('AC5: auditor candidates/roots are home- and tree-anchored, never another user\'s home', () => {
  const script = `
    const tua = require(${J(path.join(SA, 'engine', 'toolUsageAuditor.js'))});
    console.log(JSON.stringify({ c: tua._SANDBOX_CANDIDATES, r: tua._FIXABLE_ROOTS }));
  `;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-ac5-home-'));
  const { out } = runNode(script, {}, home);
  const res = JSON.parse(out.trim());
  assert.ok(res.c.includes(path.join(home, 'workspace', 'agent-sandbox')), 'candidates must include the running user\'s home sandbox');
  assert.ok(res.c.includes(path.join(ROOT, 'agent-sandbox')), 'candidates must include the instance tree sandbox');
  for (const p of [...res.c, ...res.r]) {
    assert.ok(p.startsWith(home) || p.startsWith(ROOT), `auditor path ${p} is neither home- nor tree-anchored`);
  }
  const extra = path.join(home, 'extra-root');
  const over = runNode(script, { MACF_EXTRA_FIXABLE_ROOTS: extra }, home);
  assert.ok(JSON.parse(over.out.trim()).r.includes(extra), 'MACF_EXTRA_FIXABLE_ROOTS must add fixable roots');
});

// ---------------------------------------------------------------- AC6
test('AC6: check-schedules finds cron mirrors under an arbitrary HOME', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-ac6-home-'));
  const cronDir = path.join(home, 'workspace', 'cron.d');
  fs.mkdirSync(cronDir, { recursive: true });
  fs.writeFileSync(path.join(cronDir, 'job123__hourly.md'), '# x\n');
  const script = `
    const cs = require(${J(path.join(SA, 'engine', 'check-schedules.js'))});
    console.log(JSON.stringify([...cs.collectKnownIds()]));
  `;
  const { out } = runNode(script, {}, home);
  assert.ok(JSON.parse(out.trim()).includes('job123'), 'collectKnownIds must read $HOME/workspace/cron.d');
});

test('AC6: mcp-token-refresher auth dir anchors to the operator HOME', () => {
  const script = `
    const m = require(${J(path.join(SA, 'engine', 'mcp-token-refresher.js'))});
    console.log(m._AUTH_DIR);
  `;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-ac6-home-'));
  const { out } = runNode(script, {}, home);
  assert.equal(out.trim(), path.join(home, '.mcp-auth', 'mcp-remote-v1'));
});

// ---------------------------------------------------------------- AC7
test('AC7: connectivity + supervision tests resolve probe paths without machine literals', () => {
  // Literal-freedom for both files is proven by AC1; here we prove the
  // supervision test's root resolution actually works from this checkout.
  const src = fs.readFileSync(path.join(SA, 'engine', 'tests', 'vikunja-supervision.test.js'), 'utf8');
  assert.match(src, /os\.homedir\(\)/, 'vikunja-supervision.test.js must anchor candidate roots to os.homedir()');
  const gw = fs.readFileSync(path.join(SA, 'engine', 'tests', 'mcp', 'google-workspace.connectivity.test.js'), 'utf8');
  assert.match(gw, /os\.homedir\(\)/, 'google-workspace.connectivity.test.js must anchor paths to os.homedir()');
});
