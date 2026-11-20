// US-FW-009 / F12 Step D — gateway config contract tests.
//
// gateway/ ships exactly two artifacts: litellm_config.yaml (the
// LiteLLM gateway's routing contract) and local-canary.sh (its
// probe). Until now nothing validated either. These tests pin the
// invariants the config's own header declares and the structure
// LiteLLM depends on — every assertion traces to a line in the
// file or its header comment:
//
//   - every deployment carries model_name + litellm_params.model;
//   - "NO SECRETS IN THIS FILE (all via os.environ/...)": every
//     api_key is an os.environ/ reference, never a literal;
//   - the fallback chain is referentially intact: every source
//     and every target is a defined model_name (a typo here makes
//     LiteLLM fail a route at runtime, silently for the caller);
//   - the documented chain edges exist: desk -> server local,
//     smart -> smart-free -> best -> best-direct (the header's
//     "$0 local -> $0 free -> paid -> direct" order);
//   - macf-cheap / macf-classify are local-only and macf-smart is
//     a single local deployment (their header blocks say so);
//   - the canary probes groups that exist in the config, posts to
//     the gateway's chat-completions path, and reads its key from
//     gateway.env instead of embedding one.
//
// NOT a live smoke test: standing the gateway up needs LiteLLM +
// Ollama/LM Studio backends and the master key, none of which a
// framework tree carries. That remains a deployment-side check
// (local-canary.sh against a running gateway is its instrument).
// js-yaml is resolved from slack-agents/node_modules — the same
// copy utils/modelRouter.js requires at runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const saRequire = createRequire(path.join(ROOT, 'slack-agents', 'package.json'));
const yaml = saRequire('js-yaml');

const CONFIG_PATH = path.join(ROOT, 'gateway', 'litellm_config.yaml');
const CANARY_PATH = path.join(ROOT, 'gateway', 'local-canary.sh');
const cfg = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));

const names = cfg.model_list.map((m) => m.model_name);
const nameSet = new Set(names);
const byName = (n) => cfg.model_list.filter((m) => m.model_name === n);
const fallbacks = cfg.router_settings.fallbacks;
const edges = new Map();
for (const entry of fallbacks) {
  for (const [src, targets] of Object.entries(entry)) edges.set(src, targets);
}
const isLocal = (dep) => {
  const p = dep.litellm_params || {};
  return String(p.api_base || '').includes('LOCAL_DESK_URL')
    || String(p.api_base || '').includes('OLLAMA_URL')
    || String(p.model || '').startsWith('ollama/');
};

test('config parses with the three top-level sections LiteLLM needs', () => {
  assert.ok(Array.isArray(cfg.model_list) && cfg.model_list.length > 0);
  assert.ok(Array.isArray(fallbacks) && fallbacks.length > 0);
  assert.equal(typeof cfg.litellm_settings, 'object');
});

test('every deployment carries a model_name and a litellm_params.model', () => {
  for (const dep of cfg.model_list) {
    assert.equal(typeof dep.model_name, 'string');
    assert.ok(dep.model_name.length > 0);
    assert.equal(typeof dep.litellm_params?.model, 'string');
    assert.ok(dep.litellm_params.model.length > 0);
  }
});

test('no literal secrets: every api_key is an os.environ/ reference', () => {
  for (const dep of cfg.model_list) {
    const key = dep.litellm_params?.api_key;
    if (key !== undefined) {
      assert.ok(String(key).startsWith('os.environ/'),
        `${dep.model_name} has a non-env api_key`);
    }
  }
});

test('fallback chain is referentially intact (sources and targets all defined)', () => {
  for (const entry of fallbacks) {
    const entries = Object.entries(entry);
    assert.equal(entries.length, 1, 'each fallback entry names exactly one source');
    const [src, targets] = entries[0];
    assert.ok(nameSet.has(src), `fallback source ${src} is not a defined model`);
    assert.ok(Array.isArray(targets) && targets.length > 0, `${src} has empty fallbacks`);
    for (const t of targets) {
      assert.ok(nameSet.has(t), `fallback target ${t} (from ${src}) is not a defined model`);
    }
  }
});

test('the documented budget-first chain edges exist', () => {
  // Header: "$0 local -> $0 OpenRouter free -> OpenRouter paid ->
  // direct paid APIs", and the 2026-10-22 desk-first local chain.
  assert.deepEqual(edges.get('macf-local-desk'), ['macf-local-srv']);
  assert.ok(edges.get('macf-smart').includes('macf-smart-free'));
  assert.deepEqual(edges.get('macf-smart-free'), ['macf-best']);
  assert.deepEqual(edges.get('macf-best'), ['macf-best-direct']);
});

test('macf-cheap and macf-classify are local-only; macf-smart is a single local deployment', () => {
  for (const group of ['macf-cheap', 'macf-classify']) {
    assert.ok(byName(group).length > 0, `${group} missing`);
    for (const dep of byName(group)) assert.ok(isLocal(dep), `${group} has a non-local deployment`);
  }
  const smart = byName('macf-smart');
  assert.equal(smart.length, 1);
  assert.ok(isLocal(smart[0]));
});

test('router guards are positive numbers (allowed_fails, cooldown_time)', () => {
  assert.ok(Number(cfg.router_settings.allowed_fails) > 0);
  assert.ok(Number(cfg.router_settings.cooldown_time) > 0);
});

test('canary probes only groups the config defines, via the gateway path, key from gateway.env', () => {
  const sh = fs.readFileSync(CANARY_PATH, 'utf8');
  const groups = [...sh.matchAll(/for GROUP in ([^;]+); do/g)][0][1].trim().split(/\s+/);
  assert.deepEqual(groups.sort(), ['macf-cheap', 'macf-local']);
  for (const g of groups) assert.ok(nameSet.has(g), `canary group ${g} not in config`);
  assert.ok(sh.includes('http://127.0.0.1:4000/v1/chat/completions'));
  assert.ok(sh.includes('gateway.env'), 'canary must source its key from gateway.env');
  assert.ok(!/Bearer [A-Za-z0-9_\-]{16,}/.test(sh), 'canary embeds a literal bearer key');
});
