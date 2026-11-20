// US-FW-001 acceptance tests — SPOKBOT_INSTANCE_DIR / SPOKBOT_STATE_DIR
// resolution and config precedence. Dependency-free (node:test).
// Run: node --test tests/
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
const ip = require(path.join(ROOT, 'slack-agents', 'utils', 'instancePaths.js'));

const ENV_KEYS = ['SPOKBOT_INSTANCE_DIR', 'SPOKBOT_STATE_DIR', 'SPOKBOT_CONFIG_MODELS_YAML'];
function withEnv(vars, fn) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
function tmpInstance(layout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-inst-'));
  if (layout === 'split') {
    fs.mkdirSync(path.join(dir, 'personas', 'team-skills'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'personas', 'team-skills', 'jesse-voice.md'), '# voice (split)\n');
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'models.yaml'), 'tiers: {}\n');
  } else {
    fs.mkdirSync(path.join(dir, 'team-skills'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'team-skills', 'jesse-voice.md'), '# voice (unsplit)\n');
  }
  return dir;
}

test('AC1: defaults reproduce today\'s layout (instance dir = tree root, state = slack-agents/.state)', () => {
  withEnv({}, () => {
    assert.equal(ip.instanceDir(), ROOT);
    assert.equal(ip.stateDir(), path.join(ROOT, 'slack-agents', '.state'));
    assert.equal(ip.statePath('capability-audit.json'), path.join(ROOT, 'slack-agents', '.state', 'capability-audit.json'));
  });
});

test('AC2: SPOKBOT_INSTANCE_DIR wins; split layout (personas/) preferred, unsplit falls back', () => {
  const split = tmpInstance('split');
  withEnv({ SPOKBOT_INSTANCE_DIR: split }, () => {
    assert.equal(ip.instanceDir(), split);
    assert.equal(ip.personasPath('team-skills'), path.join(split, 'personas', 'team-skills'));
    assert.equal(ip.personasPath('team-skills', 'jesse-voice.md'), path.join(split, 'personas', 'team-skills', 'jesse-voice.md'));
  });
  const unsplit = tmpInstance('unsplit');
  withEnv({ SPOKBOT_INSTANCE_DIR: unsplit }, () => {
    assert.equal(ip.personasPath('team-skills'), path.join(unsplit, 'team-skills'));
  });
});

test('AC3: SPOKBOT_STATE_DIR overrides the state dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-state-'));
  withEnv({ SPOKBOT_STATE_DIR: dir }, () => {
    assert.equal(ip.stateDir(), dir);
    assert.equal(ip.statePath('x.json'), path.join(dir, 'x.json'));
  });
});

test('AC4: config precedence env > instance config/ > framework default', () => {
  const split = tmpInstance('split');
  withEnv({ SPOKBOT_INSTANCE_DIR: split }, () => {
    // instance config/ beats framework default
    assert.equal(ip.configPath('models.yaml'), path.join(split, 'config', 'models.yaml'));
  });
  withEnv({}, () => {
    // no instance copy -> framework default (today's path)
    assert.equal(ip.configPath('models.yaml'), path.join(ROOT, 'slack-agents', 'config', 'models.yaml'));
  });
  const explicit = path.join(os.tmpdir(), 'explicit-models.yaml');
  withEnv({ SPOKBOT_INSTANCE_DIR: split, SPOKBOT_CONFIG_MODELS_YAML: explicit }, () => {
    assert.equal(ip.configPath('models.yaml'), explicit);
  });
});

test('AC5: expertLens loads jesse-voice.md from the instance dir given by env (split + unsplit + production baseline)', () => {
  const script = `
    const lens = require(${JSON.stringify(path.join(ROOT, 'slack-agents', 'utils', 'expertLens.js'))});
    const c = lens.loadLens('jesse-voice');
    if (!c || c.length < 10) { console.error('empty lens'); process.exit(3); }
    console.log('lens-bytes=' + c.length);
  `;
  // Extra real-instance dirs: the two known local checkouts when they
  // exist on this machine, plus any dirs named by
  // SPOKBOT_TEST_INSTANCE_DIRS (path-delimited) — e.g. the staged
  // instance on macf-server (US-FW-002 portability fix: the hardcoded
  // local paths made this test un-runnable on any other host).
  const extraDirs = [
    '/home/hatch/workspace/spokbot-build/baseline-server',
    '/home/hatch/workspace/spokbot-build/spokbot-instance-jesse',
    ...(process.env.SPOKBOT_TEST_INSTANCE_DIRS || '').split(path.delimiter),
  ].filter((d) => d && fs.existsSync(d));
  for (const dir of [tmpInstance('split'), tmpInstance('unsplit'), ...extraDirs]) {
    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, SPOKBOT_INSTANCE_DIR: dir }, encoding: 'utf8',
    });
    assert.match(out, /lens-bytes=\d+/, `expertLens failed for instance dir ${dir}`);
  }
});

test('AC6: framework tree carries no instance content, live grants, state files, or credential files', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'team-skills')), 'team-skills/ must not be in the framework tree');
  assert.ok(!fs.existsSync(path.join(ROOT, 'hands', 'grants.json')), 'live grants.json must not be in the framework tree');
  assert.ok(fs.existsSync(path.join(ROOT, 'hands', 'grants.example.json')), 'grants.example.json ships instead');
  const engineState = fs.readdirSync(path.join(ROOT, 'slack-agents', 'engine'))
    .filter((f) => f.startsWith('.') && f.endsWith('.json'));
  assert.deepEqual(engineState, [], `engine state dotfiles present: ${engineState}`);
  for (const bad of ['.canva-tokens.json', '.engine-env']) {
    assert.ok(!fs.existsSync(path.join(ROOT, 'slack-agents', bad)), `${bad} must not be in the framework tree`);
  }
});

test('wiring: modelRouter and capabilityAudit resolve through instancePaths', () => {
  const mr = fs.readFileSync(path.join(ROOT, 'slack-agents', 'utils', 'modelRouter.js'), 'utf8');
  assert.match(mr, /instancePaths/, 'modelRouter must use instancePaths');
  assert.match(mr, /configPath\('models\.yaml'\)/, 'modelRouter must resolve models.yaml via configPath');
  const ca = fs.readFileSync(path.join(ROOT, 'slack-agents', 'engine', 'capabilityAudit.js'), 'utf8');
  assert.match(ca, /instancePaths/, 'capabilityAudit must use instancePaths');
  assert.match(ca, /statePath\('capability-audit\.json'\)/, 'capabilityAudit must resolve its output via statePath');
});
