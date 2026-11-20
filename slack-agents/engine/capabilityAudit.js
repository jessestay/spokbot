/**
 * capabilityAudit.js — live health probe for the capability baseline.
 *
 * Jesse's rule: granted-but-broken counts as missing. This script probes
 * every server in grants.defaults.baseline_servers (plus every gated
 * server granted to any role) with a real MCP connect + listTools, and
 * writes the result to .state/capability-audit.json. A baseline server
 * that fails is named in the output — the CEO learns about dead tools
 * from this audit, not from Jesse.
 *
 * Run: node engine/capabilityAudit.js   (exit 1 if any baseline server fails)
 */

const fs = require('fs');
const path = require('path');

const instancePaths = require('../utils/instancePaths');
const MACF_ROOT = instancePaths.frameworkRoot();
const HANDS_DIR = path.join(MACF_ROOT, 'hands');
const OUT_PATH = instancePaths.statePath('capability-audit.json');
const PROBE_TIMEOUT_MS = 45000;

function loadRoleTokens() {
  const tokens = {};
  try {
    for (const line of fs.readFileSync(path.join(HANDS_DIR, '.role-tokens'), 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) tokens[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch { /* role-gated servers will report their own refusal */ }
  return tokens;
}

async function probe(name, spec, sdk, tokens) {
  const env = {
    ...process.env,
    ...(spec.env || {}),
    MACF_ROLE: 'CEO',
    MACF_ROLE_TOKEN: tokens.CEO || '',
  };
  const cwd = spec.cwd ? path.resolve(MACF_ROOT, spec.cwd) : HANDS_DIR;
  const transport = new sdk.StdioClientTransport({
    command: spec.command, args: spec.args || [], cwd, env, stderr: 'ignore',
  });
  const client = new sdk.Client({ name: 'capability-audit', version: '1.0.0' }, { capabilities: {} });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS));
  try {
    await Promise.race([client.connect(transport), timeout]);
    const res = await Promise.race([client.listTools(), timeout]);
    return { ok: true, tools: (res.tools || []).length };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  } finally {
    try { await client.close(); } catch { /* already closed */ }
  }
}

/**
 * The audit report (US-116): baselineFailures names exactly the
 * BASELINE servers that failed or never answered — a role-granted
 * server's failure is carried in results but is not a baseline
 * failure. main() exits non-zero iff baselineFailures is non-empty;
 * that exit + this report are the signal the supervision layer
 * tickets on the same day.
 */
function buildReport(baseline, results) {
  return {
    at: new Date().toISOString(),
    baseline,
    baselineFailures: baseline.filter(s => !results[s] || !results[s].ok),
    results,
  };
}

async function main() {
  const grants = JSON.parse(fs.readFileSync(path.join(HANDS_DIR, 'grants.json'), 'utf8'));
  const baseline = (grants.defaults && grants.defaults.baseline_servers) || [];
  const roleGranted = new Set();
  for (const role of Object.values(grants.roles || {})) {
    for (const s of role.servers || []) roleGranted.add(s);
  }
  const targets = [...new Set([...baseline, ...roleGranted])].filter(s => grants.servers[s]);

  const sdkBase = path.join(HANDS_DIR, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');
  const sdk = {
    Client: require(path.join(sdkBase, 'client', 'index.js')).Client,
    StdioClientTransport: require(path.join(sdkBase, 'client', 'stdio.js')).StdioClientTransport,
  };
  const tokens = loadRoleTokens();

  const results = {};
  const batches = [];
  for (let i = 0; i < targets.length; i += 6) batches.push(targets.slice(i, i + 6));
  for (const batch of batches) {
    const probed = await Promise.all(batch.map(async n => [n, await probe(n, grants.servers[n], sdk, tokens)]));
    for (const [n, r] of probed) results[n] = r;
  }

  const report = buildReport(baseline, results);
  const baselineFailures = report.baselineFailures;
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));

  for (const [n, r] of Object.entries(results)) {
    console.log(r.ok ? `OK   ${n} tools=${r.tools}` : `FAIL ${n} :: ${r.error}`);
  }
  console.log(baselineFailures.length
    ? `BASELINE FAILURES: ${baselineFailures.join(', ')}`
    : 'BASELINE HEALTHY: every baseline server answers.');
  process.exit(baselineFailures.length ? 1 : 0);
}

if (require.main === module) {
  main().catch(e => { console.error('capabilityAudit error:', e.message); process.exit(2); });
}

module.exports = { main, probe, buildReport };
