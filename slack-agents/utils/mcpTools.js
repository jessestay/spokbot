/**
 * mcpTools.js — #807 Phase 2 (US-P2.5): wire hands/grants.json into the
 * generateWithTools loop.
 *
 * The root-cause audit found MCP grants were health-checked daily but
 * NEVER reachable from a delegation: agents' tool registry was a static
 * six-tool map, and the two Tavily prefetches were the only MCP-shaped
 * code path. This module turns an agent's granted MCP servers into
 * registry-shaped tool entries (namespaced mcp_<server>_<tool>) that the
 * loops merge into their tool definitions and runTool dispatches through
 * agentTools.executeMcpTool (which re-checks the grant and issues the
 * standard receipt).
 *
 * Discovery is cached per process; a failing server degrades gracefully
 * (its tools simply don't appear) and backs off for 60s so a dead server
 * never stalls every delegation.
 */

const fs = require('fs');
const path = require('path');

const GRANTS_PATH = path.join(__dirname, '..', '..', 'hands', 'grants.json');
const GRANTS_EXAMPLE_PATH = path.join(__dirname, '..', '..', 'hands', 'grants.example.json');
const FAILURE_BACKOFF_MS = 60000;

const discoveryCache = new Map(); // server -> { tools: [...], at }
const failureCache = new Map(); // server -> failedAt

let grantsFallbackWarned = false;

function loadGrants() {
  // Resolution follows the tree's instance-first / framework-default
  // doctrine (utils/instancePaths.js configPath): the live instance
  // grants (hands/grants.json, placed at deploy time) win; when they
  // are absent — a bare framework tree, which by design carries no
  // live grants (US-FW-001 AC6) — the shipped default
  // hands/grants.example.json applies, so the capability baseline
  // Jesse ordered (Oct 24, 2026: every agent inherits it by default)
  // holds in the framework tree too instead of silently reading as
  // "no grants at all". Deployed trees are unaffected: grants.json
  // takes precedence whenever it exists. If neither file parses,
  // fail soft to no grants, as before.
  //
  // The fallback is LOUD (Step 6/7 follow-up to Step D, CEO review):
  // in a DEPLOYED tree a missing grants.json is a deployment defect —
  // the instance's real role grants are not being applied — so the
  // first fallback per process raises a console.error naming the
  // defect. Once per process, not per call: loadGrants runs on every
  // grant check and a per-call warning would flood the engine log.
  try {
    return JSON.parse(fs.readFileSync(GRANTS_PATH, 'utf8'));
  } catch { /* fall through to the shipped example */ }
  try {
    const example = JSON.parse(fs.readFileSync(GRANTS_EXAMPLE_PATH, 'utf8'));
    if (!grantsFallbackWarned) {
      grantsFallbackWarned = true;
      console.error(
        '[mcpTools] WARNING: hands/grants.json is MISSING — falling back to ' +
        'hands/grants.example.json (shipped framework defaults). In a deployed ' +
        'tree this is a DEPLOYMENT DEFECT: instance role grants are NOT being ' +
        `applied. Expected live grants at: ${GRANTS_PATH}`
      );
    }
    return example;
  } catch { /* fall through to the fail-soft shape */ }
  return { roles: {}, servers: {}, defaults: {} };
}

function grantedServers(agentId) {
  if (!agentId) return [];
  const grants = loadGrants();
  const roles = grants.roles || {};
  const role = roles[agentId] || roles[String(agentId).toLowerCase()];
  const own = (role && Array.isArray(role.servers)) ? role.servers : [];
  // Capability baseline (Jesse, Oct 24, 2026): every agent — listed in
  // grants.json or not, present or future — inherits defaults.baseline_servers.
  // Role grants only ADD to the baseline; no agent starts with less.
  const baseline = (grants.defaults && Array.isArray(grants.defaults.baseline_servers))
    ? grants.defaults.baseline_servers : [];
  return [...new Set([...baseline, ...own])];
}

function mcpBudgetFor(agentId) {
  const grants = loadGrants();
  const role = (grants.roles && grants.roles[agentId]) || {};
  const budgets = role.budgets || {};
  const defaults = grants.defaults || {};
  return budgets.max_tool_calls || defaults.max_tool_calls || 8;
}

function sanitize(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
}

const DISCOVERY_TIMEOUT_MS = 30000; // cold npx starts routinely exceed 8s (Oct 24, 2026 baseline audit)

async function discoverServerTools(server) {
  const cached = discoveryCache.get(server);
  if (cached) return cached.tools;
  const failedAt = failureCache.get(server);
  if (failedAt && Date.now() - failedAt < FAILURE_BACKOFF_MS) return [];
  try {
    const mcpClient = require('../engine/mcpClient');
    // Time-boxed: a wedged MCP server must never stall a delegation
    // (or a test suite) — discovery is an enhancement, not a dependency.
    const tools = await Promise.race([
      mcpClient.listTools(server),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`discovery timeout ${DISCOVERY_TIMEOUT_MS}ms`)), DISCOVERY_TIMEOUT_MS)),
    ]);
    const list = Array.isArray(tools) ? tools : [];
    discoveryCache.set(server, { tools: list, at: Date.now() });
    failureCache.delete(server);
    return list;
  } catch (e) {
    failureCache.set(server, Date.now());
    console.log(`[mcpTools] discovery failed for ${server}: ${e.message.slice(0, 120)} (tools unavailable this run)`);
    return [];
  }
}

/**
 * Build registry-shaped tool entries for every MCP tool granted to the
 * agent. Returns {} when the agent has no grants or all servers fail.
 */
async function buildMcpToolDefs(agentId) {
  const servers = grantedServers(agentId);
  if (!servers.length) return {};
  const defs = {};
  // Servers discovered in parallel — total discovery time is bounded by
  // the slowest server's timeout, not the sum.
  const perServer = await Promise.all(servers.map(async (server) => [server, await discoverServerTools(server)]));
  for (const [server, tools] of perServer) {
    for (const tool of tools) {
      const name = `mcp_${sanitize(server)}_${sanitize(tool.name)}`;
      defs[name] = {
        description: `[MCP:${server}] ${tool.description || tool.name}`,
        argsSchema: tool.inputSchema || { type: 'object', properties: {}, required: [] },
        strict: false, // server schemas are arbitrary JSON Schema — no OpenAI strict forcing
        mcp: { server, tool: tool.name },
      };
    }
  }
  return defs;
}

module.exports = { buildMcpToolDefs, grantedServers, mcpBudgetFor, loadGrants, _discoveryCache: discoveryCache, _resetGrantsFallbackWarning: () => { grantsFallbackWarned = false; } };
