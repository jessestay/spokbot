// engine/mcpSpawnSmoke.js — pre-cutover MCP spawn smoke (US-FW-033).
//
// Spawns MCP servers from a tree exactly as the engine and the capability
// audit spawn them, and verifies each answers an MCP initialize +
// tools/list handshake over stdio. Built after the first Step 5 attempt
// (2026-11-18) was rolled back at the W6 capability gate: the staged
// x-mcp had no node_modules and the W6 audit was the first spawn from
// the new tree. This smoke makes the new tree prove its spawns first.
//
// Spawn shape mirrors the two production consumers:
//   - mcpClient.js: loads slack-agents/.env, expands ${VAR} placeholders
//     in the grants config from it, spawns with {...process.env, ...env}.
//   - capabilityAudit.js: cwd = spec.cwd resolved against the framework
//     root (default hands/), env adds MACF_ROLE + MACF_ROLE_TOKEN from
//     hands/.role-tokens, 45s probe timeout.
//
// Dependency-free. CLI:
//   node mcpSpawnSmoke.js [--root <frameworkRoot>] [--grants <path>]
//                         [--seven | --only a,b] [--timeout <ms>] [--role CEO]
// Exit 0 iff no probed server FAILs (ROLE-REFUSAL is reported as its own
// class and does not fail the run — see US-FW-033 AC5).
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// The seven grants entries whose absolute paths §2.4 of the Step 5
// runbook rewrites into the new tree. These are the spawns a cutover
// can silently break; the other grants servers are npx/HOME-cache or
// host-level and layout-independent.
const REWRITTEN_SEVEN = ['desktop-commander', 'n8n-mcp', 'macf-finance', 'finance-files', 'desktop-agent', 'slack', 'x'];

const DEFAULT_TIMEOUT_MS = 45000;

function loadDotEnv(filePath) {
  const env = {};
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return env; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function loadRoleTokens(filePath) {
  const tokens = {};
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return tokens; }
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) tokens[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return tokens;
}

// Same semantics as mcpClient.expandEnv: ${VAR} is replaced from the
// .env map; an unknown variable is left as the literal placeholder.
function expandEnv(value, env) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (m, name) => env[name] || m);
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v, env);
    return out;
  }
  return value;
}

function buildSpawnPlan({ grants, name, frameworkRoot, dotEnv = {}, baseEnv = {}, role, roleTokens = {} }) {
  const spec = (grants.servers || {})[name];
  if (!spec) throw new Error(`MCP server '${name}' not found in grants.json`);
  const config = expandEnv(spec, dotEnv);
  if (!config.command) throw new Error(`Server ${name} has no command configured`);
  const cwd = config.cwd ? path.resolve(frameworkRoot, config.cwd) : path.join(frameworkRoot, 'hands');
  const env = { ...baseEnv, ...(config.env || {}) };
  if (role) {
    env.MACF_ROLE = role;
    if (roleTokens[role]) env.MACF_ROLE_TOKEN = roleTokens[role];
  }
  return { name, command: config.command, args: config.args || [], cwd, env };
}

function selectServers(grants, { seven = false, only = null } = {}) {
  if (seven) return [...REWRITTEN_SEVEN];
  if (only) return only.split(',').map((s) => s.trim()).filter(Boolean);
  return Object.keys(grants.servers || {});
}

// Probe one server: spawn it, run the initialize + tools/list handshake.
// Resolves (never rejects) with { name, status, tools?, reason?, stderrTail }
// where status is 'pass' | 'fail' | 'role-refusal'.
function probeServer(plan, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stage = 'initialize';
    let stderr = '';
    let buf = '';
    let child;
    const done = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (child && child.exitCode === null) child.kill('SIGTERM'); } catch { /* already gone */ }
      resolve({ name: plan.name, stderrTail: stderr.slice(-2000), ...res });
    };
    const timer = setTimeout(() => {
      done({ status: 'fail', reason: `timeout after ${timeoutMs}ms waiting for ${stage}` });
    }, timeoutMs);
    try {
      child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      done({ status: 'fail', reason: `spawn threw: ${err.message}` });
      return;
    }
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-16000); });
    child.on('error', (err) => done({ status: 'fail', reason: `spawn error: ${err.message}` }));
    child.on('exit', (code, signal) => {
      const refusal = /MACF_ROLE|role/i.test(stderr);
      if (refusal) {
        done({ status: 'role-refusal', reason: `server started, then refused the probe role (exit ${code})` });
      } else {
        done({ status: 'fail', reason: `exited (code ${code}${signal ? `, signal ${signal}` : ''}) before completing ${stage}` });
      }
    });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // servers may log non-JSON to stdout
        if (msg.id === 1 && stage === 'initialize') {
          if (msg.error) { done({ status: 'fail', reason: `initialize error: ${JSON.stringify(msg.error).slice(0, 300)}` }); return; }
          if (!msg.result) continue;
          stage = 'tools/list';
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        } else if (msg.id === 2 && stage === 'tools/list') {
          if (msg.error) { done({ status: 'fail', reason: `tools/list error: ${JSON.stringify(msg.error).slice(0, 300)}` }); return; }
          if (!msg.result) continue;
          done({ status: 'pass', tools: (msg.result.tools || []).length });
          return;
        }
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-spawn-smoke', version: '1.0.0' } },
    }) + '\n');
  });
}

async function runSmoke({ grantsPath, frameworkRoot, seven = false, only = null, timeoutMs = DEFAULT_TIMEOUT_MS, role = 'CEO' }) {
  const grants = JSON.parse(fs.readFileSync(grantsPath, 'utf8'));
  const dotEnv = loadDotEnv(path.join(frameworkRoot, 'slack-agents', '.env'));
  const roleTokens = loadRoleTokens(path.join(frameworkRoot, 'hands', '.role-tokens'));
  const names = selectServers(grants, { seven, only });
  const results = [];
  for (const name of names) {
    let plan;
    try {
      plan = buildSpawnPlan({ grants, name, frameworkRoot, dotEnv, baseEnv: process.env, role, roleTokens });
    } catch (err) {
      results.push({ name, status: 'fail', reason: err.message, stderrTail: '' });
      continue;
    }
    results.push(await probeServer(plan, { timeoutMs }));
  }
  return { results, ok: results.every((r) => r.status !== 'fail') };
}

function formatResult(r) {
  if (r.status === 'pass') return `${r.name} PASS tools=${r.tools}`;
  if (r.status === 'role-refusal') return `${r.name} ROLE-REFUSAL ${r.reason}`;
  return `${r.name} FAIL ${r.reason}`;
}

async function main(argv) {
  const args = { root: path.resolve(__dirname, '..', '..'), timeout: DEFAULT_TIMEOUT_MS, role: 'CEO' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = path.resolve(argv[++i]);
    else if (a === '--grants') args.grants = path.resolve(argv[++i]);
    else if (a === '--seven') args.seven = true;
    else if (a === '--only') args.only = argv[++i];
    else if (a === '--timeout') args.timeout = parseInt(argv[++i], 10);
    else if (a === '--role') args.role = argv[++i];
    else { console.error(`unknown argument: ${a}`); return 2; }
  }
  const grantsPath = args.grants || path.join(args.root, 'hands', 'grants.json');
  const { results, ok } = await runSmoke({
    grantsPath, frameworkRoot: args.root,
    seven: args.seven, only: args.only, timeoutMs: args.timeout, role: args.role,
  });
  for (const r of results) {
    console.log(formatResult(r));
    if (r.status === 'fail' && r.stderrTail) {
      console.log('  stderr tail: ' + r.stderrTail.trim().split('\n').slice(-3).join('\n  '));
    }
  }
  const passed = results.filter((r) => r.status === 'pass').length;
  const refused = results.filter((r) => r.status === 'role-refusal').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  console.log(`SMOKE SUMMARY: ${passed} pass, ${refused} role-refusal, ${failed} fail of ${results.length}`);
  return ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    console.error('smoke crashed:', err.message);
    process.exit(1);
  });
}

module.exports = { REWRITTEN_SEVEN, loadDotEnv, loadRoleTokens, expandEnv, buildSpawnPlan, selectServers, probeServer, runSmoke, formatResult };
