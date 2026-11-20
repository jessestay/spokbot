/**
 * capability-baseline.test.js — Jesse's order, Oct 24, 2026.
 *
 * Every MACF agent — present or future, listed in grants.json or not —
 * inherits the default capability baseline (the "just works out of the box"
 * toolset, modeled on what Claude Code / Cowork / Dispatch / Meta Muse /
 * Grok ship with). Role grants only ADD. Spend-capable, paid-generation,
 * and desktop-control servers stay gated behind explicit role entries.
 *
 * If this test fails, an agent is missing tools by default. That is a
 * defect in the platform, not a task for the agent.
 */

const fs = require('fs');
const path = require('path');

// Grants resolution mirrors utils/mcpTools.loadGrants (and the
// tree's instance-first / framework-default doctrine): a deployed
// tree carries the live instance grants at hands/grants.json; a
// bare framework tree deliberately carries none (US-FW-001 AC6) and
// ships hands/grants.example.json as the default instead. Before
// the Step 3 parameterization this suite hard-read grants.json at
// load and died with ENOENT in the framework tree; it now asserts
// against whichever source the engine itself would load.
const HANDS_DIR = path.join(__dirname, '..', '..', '..', 'hands');
const GRANTS_PATH = [path.join(HANDS_DIR, 'grants.json'), path.join(HANDS_DIR, 'grants.example.json')]
  .find((p) => fs.existsSync(p));
const { grantedServers, mcpBudgetFor } = require('../../utils/mcpTools');

const grants = JSON.parse(fs.readFileSync(GRANTS_PATH, 'utf8'));
const baseline = (grants.defaults && grants.defaults.baseline_servers) || [];

// The out-of-the-box productivity set every agent must have.
const REQUIRED_BASELINE = [
  'google-workspace', // Gmail, Drive, Docs, Sheets
  'tavily',           // web search / research
  'linkedin',         // professional network, jobs
  'canva',            // design
  'buffer',           // social scheduling
  'github',           // code and repos
  'n8n-mcp',          // automation
  'google-analytics', // analytics reads
  'youtube',          // video platform data
  'slack',            // team comms
  'x',                // social
  'figma',            // design files
  'google-tag-manager',
  'tiktok-research',
  'tiktok-strategy',
];

// Never in the baseline: spending, paid generation, desktop control,
// payment rails. These require Jesse's explicit per-tool decision and a
// role-level grant.
const GATED = [
  'stripe', 'meta-ads',
  'video-gen', 'heygen', 'elevenlabs', 'capcut',
  'desktop-agent', 'desktop-commander',
  'macf-finance',
  'finance-files', // role-token gated: answers only CEO/CFO/CTO tokens
];

// Every agent id the engine can run today.
const AGENT_IDS = [
  'ceo', 'execpm', 'cmo', 'cco', 'cfo', 'cro', 'cto', 'cuxo',
  'lawyer', 'jobcoach', 'facebook', 'hr',
];

describe('capability baseline (grants.json)', () => {
  test('defaults.baseline_servers covers the required out-of-the-box set', () => {
    for (const s of REQUIRED_BASELINE) {
      expect(baseline).toContain(s);
    }
  });

  test('no gated server leaks into the baseline', () => {
    for (const s of GATED) {
      expect(baseline).not.toContain(s);
    }
  });

  test('every baseline server is defined in grants.servers', () => {
    for (const s of baseline) {
      expect(grants.servers[s]).toBeDefined();
    }
  });

  test('tool-call budget floor is at least 24 for every agent', () => {
    for (const id of AGENT_IDS) {
      expect(mcpBudgetFor(id)).toBeGreaterThanOrEqual(24);
    }
  });
});

describe('baseline inheritance (utils/mcpTools.grantedServers)', () => {
  test.each(AGENT_IDS)('agent %s receives the full baseline', (id) => {
    const effective = grantedServers(id);
    for (const s of REQUIRED_BASELINE) {
      expect(effective).toContain(s);
    }
  });

  test('a future agent with no role entry still receives the baseline', () => {
    const effective = grantedServers('some-future-agent');
    for (const s of REQUIRED_BASELINE) {
      expect(effective).toContain(s);
    }
  });

  test('role grants add to the baseline rather than replacing it', () => {
    const cfo = grantedServers('cfo');
    expect(cfo).toContain('macf-finance'); // role-specific, gated
    for (const s of REQUIRED_BASELINE) expect(cfo).toContain(s);
  });

  test('no agent id means no tools (fail-closed for anonymous paths)', () => {
    expect(grantedServers(null)).toEqual([]);
    expect(grantedServers(undefined)).toEqual([]);
  });
});

describe('grants fallback is LOUD (Step 6/7 follow-up to Step D)', () => {
  // The framework tree deliberately carries no hands/grants.json
  // (US-FW-001 AC6), so loadGrants falls back to grants.example.json
  // here. In a deployed tree that fallback means the instance's real
  // grants are missing — a deployment defect — so it must warn, once
  // per process, instead of silently serving the shipped defaults.
  // In a tree WITH grants.json present the fallback never fires and
  // no warning may be emitted; this block asserts whichever behavior
  // matches the tree it runs in.
  const LIVE_GRANTS = path.join(HANDS_DIR, 'grants.json');
  const EXAMPLE_GRANTS = path.join(HANDS_DIR, 'grants.example.json');

  test('fallback to grants.example.json emits one deployment-defect warning per process', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      jest.resetModules();
      const fresh = require('../../utils/mcpTools');
      fresh._resetGrantsFallbackWarning();
      const loaded = fresh.loadGrants();
      fresh.loadGrants(); // second call must not re-warn
      if (fs.existsSync(LIVE_GRANTS)) {
        expect(spy).not.toHaveBeenCalled();
        expect(loaded).toEqual(JSON.parse(fs.readFileSync(LIVE_GRANTS, 'utf8')));
      } else {
        expect(spy).toHaveBeenCalledTimes(1);
        const msg = String(spy.mock.calls[0][0]);
        expect(msg).toContain('[mcpTools] WARNING');
        expect(msg).toContain('grants.json is MISSING');
        expect(msg).toContain('grants.example.json');
        expect(msg).toContain('DEPLOYMENT DEFECT');
        expect(loaded).toEqual(JSON.parse(fs.readFileSync(EXAMPLE_GRANTS, 'utf8')));
      }
    } finally {
      spy.mockRestore();
      jest.resetModules();
    }
  });
});
