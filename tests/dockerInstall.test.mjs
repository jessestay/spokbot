// US-FW-005 smoke tests — Docker Compose one-command install (draft).
// Dependency-free (node:test); YAML parsing shells out to python3 +
// PyYAML when available and skips only the parse assertion when not.
// No Docker daemon is required or assumed: these tests verify the
// compose file parses and that every path the install documents or
// references actually exists in the tree.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = path.join(ROOT, 'docker-compose.yml');
const DOCKERFILE = path.join(ROOT, 'Dockerfile');
const README = path.join(ROOT, 'README.md');

function parseCompose(t) {
  if (!fs.existsSync(COMPOSE)) return null;
  try {
    const out = execFileSync('python3', ['-c',
      'import yaml,json,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', COMPOSE],
      { encoding: 'utf8' });
    return JSON.parse(out);
  } catch {
    t.skip('python3 + PyYAML unavailable — YAML parse check skipped');
    return null;
  }
}

test('AC2: docker-compose.yml exists, parses, and defines the expected services', (t) => {
  assert.ok(fs.existsSync(COMPOSE), 'docker-compose.yml must exist at the repo root');
  const doc = parseCompose(t);
  if (!doc) return;
  assert.ok(doc.services, 'compose file must define services');
  for (const name of ['engine', 'gateway', 'vikunja']) {
    assert.ok(doc.services[name], `missing service: ${name}`);
  }
  assert.ok(doc.services.ollama, 'missing service: ollama');
  assert.ok((doc.services.ollama.profiles || []).includes('local-models'),
    'ollama must sit behind the local-models profile');
});

test('AC3: every path the compose file and Dockerfile rely on exists in the tree', (t) => {
  assert.ok(fs.existsSync(DOCKERFILE), 'Dockerfile must exist at the repo root');
  const doc = parseCompose(t);
  if (!doc) return;
  // Build context + dockerfile for the engine service.
  const build = doc.services.engine.build;
  const context = typeof build === 'string' ? build : (build && build.context) || '.';
  assert.ok(fs.existsSync(path.join(ROOT, context)), `build context missing: ${context}`);
  // Bind-mount sources that are files must exist (directories may be
  // operator-created, e.g. ./instance — checked in AC1 instead).
  for (const svc of Object.values(doc.services)) {
    for (const v of svc.volumes || []) {
      const src = String(v).split(':')[0];
      if (src.startsWith('./') || src.startsWith('../')) {
        const p = path.join(ROOT, src);
        if (fs.existsSync(p)) {
          assert.ok(fs.statSync(p).isDirectory() || fs.existsSync(p), `mount source unusable: ${src}`);
        }
      }
    }
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'gateway', 'litellm_config.yaml')), 'gateway config must exist');
  assert.ok(fs.existsSync(path.join(ROOT, 'slack-agents', 'engine', 'runStandalone.js')), 'engine entry point must exist');
  assert.ok(fs.existsSync(path.join(ROOT, 'slack-agents', 'package-lock.json')), 'engine lockfile must exist');
  assert.ok(fs.existsSync(path.join(ROOT, 'hands', 'package-lock.json')), 'hands lockfile must exist');
  const df = fs.readFileSync(DOCKERFILE, 'utf8');
  assert.match(df, /runStandalone\.js/, 'Dockerfile must run the standalone engine');
  assert.match(df, /npm ci/, 'Dockerfile must install from lockfiles with npm ci');
});

test('AC4: engine wiring — env file, instance/state mounts, ports match production', (t) => {
  const doc = parseCompose(t);
  if (!doc) return;
  const engine = doc.services.engine;
  const envFiles = (engine.env_file || []).map(e => typeof e === 'string' ? e : e.path);
  assert.ok(envFiles.some(f => String(f).endsWith('slack-agents/.env')),
    'engine must read secrets from slack-agents/.env');
  const env = engine.environment || {};
  assert.ok(String(env.SPOKBOT_INSTANCE_DIR || '').startsWith('/'), 'SPOKBOT_INSTANCE_DIR must be an absolute mount path');
  assert.ok(String(env.SPOKBOT_STATE_DIR || '').startsWith('/'), 'SPOKBOT_STATE_DIR must be an absolute mount path');
  const vols = (engine.volumes || []).map(String);
  assert.ok(vols.some(v => v.includes(String(env.SPOKBOT_INSTANCE_DIR))), 'instance dir must be mounted');
  assert.ok(vols.some(v => v.includes(String(env.SPOKBOT_STATE_DIR))), 'state dir must be mounted');
  assert.ok(!engine.ports, 'engine is a worker and must publish no ports');
  const gwPorts = (doc.services.gateway.ports || []).map(String);
  assert.ok(gwPorts.some(p => p.includes('4000')), 'gateway must publish 4000');
  const vkPorts = (doc.services.vikunja.ports || []).map(String);
  assert.ok(vkPorts.some(p => p.includes('3456')), 'vikunja must publish 3456');
});

test('AC1+AC5: README Docker section names the same steps, services, and command', () => {
  const readme = fs.readFileSync(README, 'utf8');
  const section = readme.split('## ').find(s => /docker/i.test(s.split('\n')[0]) || s.includes('docker compose up'));
  assert.ok(section, 'README must carry a Docker install section');
  for (const needle of ['docker compose up -d', 'slack-agents/.env.example', 'slack-agents/.env',
    'engine', 'gateway', 'vikunja', 'instance']) {
    assert.ok(section.includes(needle), `README Docker section must mention: ${needle}`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'slack-agents', '.env.example')),
    'the .env.example the README names must exist');
});

test('AC6: vikunja first-run volume ownership is fixed by an init service (Step 7 live finding)', (t) => {
  const doc = parseCompose(t);
  if (!doc) return;
  // The vikunja image runs as uid 1000 with no root entrypoint, and a
  // fresh named volume is root-owned: without the chown, vikunja
  // crash-loops on storage permission denied (verified live).
  const init = doc.services['vikunja-init'];
  assert.ok(init, 'a vikunja-init service must exist');
  const cmd = (init.command || []).map(String).join(' ');
  assert.match(cmd, /chown/, 'vikunja-init must chown the files volume');
  assert.match(cmd, /1000/, 'vikunja-init must chown to the vikunja uid (1000)');
  assert.match(cmd, /\/db/, 'vikunja-init must also chown the SQLite /db volume (second live finding)');
  const vols = (init.volumes || []).map(String);
  assert.ok(vols.some(v => v.startsWith('vikunja-data:')), 'vikunja-init must mount the vikunja-data volume');
  assert.ok(vols.some(v => v.startsWith('vikunja-db:')), 'vikunja-init must mount the vikunja-db volume');
  const vkVols = (doc.services.vikunja.volumes || []).map(String);
  assert.ok(vkVols.some(v => v.startsWith('vikunja-db:') && v.includes('/db')),
    'vikunja must mount a volume at /db for its SQLite database');
  const dep = (doc.services.vikunja.depends_on || {})['vikunja-init'];
  assert.ok(dep && dep.condition === 'service_completed_successfully',
    'vikunja must wait for vikunja-init to complete successfully');
});

test('AC8: the gateway receives the master key from the stack secrets file (Step 7 live finding)', (t) => {
  const doc = parseCompose(t);
  if (!doc) return;
  // Current LiteLLM refuses to boot with no master key ("refused
  // to start: no master key is set"). The draft mounted only the
  // config and wired no environment, so the gateway crash-looped
  // (verified live). The key must arrive via the one secrets file
  // the README names, and the example must tell the operator to
  // set it.
  const gw = doc.services.gateway;
  const envFiles = (gw.env_file || []).map(e => typeof e === 'string' ? e : e.path);
  assert.ok(envFiles.some(f => String(f).endsWith('slack-agents/.env')),
    'gateway must read slack-agents/.env for LITELLM_MASTER_KEY');
  const example = fs.readFileSync(path.join(ROOT, 'slack-agents', '.env.example'), 'utf8');
  assert.match(example, /^LITELLM_MASTER_KEY=/m, '.env.example must name LITELLM_MASTER_KEY');
});

test('AC7: every package production code requires is a declared runtime dependency (Step 7 live finding)', () => {
  // The image installs with `npm ci --omit=dev`. Production code
  // (utils/modelRouter.js) required js-yaml, which package.json
  // never declared — it reached production node_modules only as a
  // dev-transitive hoist (jest coverage tooling), so the image
  // crash-looped with MODULE_NOT_FOUND (verified live). Pin the
  // class: any bare require in production source must be declared
  // in slack-agents "dependencies".
  const saRoot = path.join(ROOT, 'slack-agents');
  const pkg = JSON.parse(fs.readFileSync(path.join(saRoot, 'package.json'), 'utf8'));
  const declared = new Set(Object.keys(pkg.dependencies || {}));
  const builtins = new Set(['http', 'https', 'fs', 'path', 'os', 'crypto', 'child_process', 'util',
    'events', 'stream', 'url', 'querystring', 'zlib', 'net', 'tls', 'readline', 'assert', 'buffer',
    'process', 'worker_threads', 'perf_hooks', 'async_hooks', 'module', 'tty', 'dns', 'http2',
    'timers', 'string_decoder', 'vm', 'inspector', 'node:test']);
  const undeclared = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'tests' && e.name !== 'node_modules') walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
        const name = m[1];
        if (name.startsWith('.') || name.startsWith('/') || name.startsWith('node:')) continue;
        const top = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
        if (!builtins.has(top) && !declared.has(top)) undeclared.add(top);
      }
    }
  };
  for (const base of ['utils', 'engine', 'agents']) {
    const dir = path.join(saRoot, base);
    if (fs.existsSync(dir)) walk(dir);
  }
  assert.deepEqual([...undeclared].sort(), [],
    'production code requires packages missing from slack-agents dependencies');
});
