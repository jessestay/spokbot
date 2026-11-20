'use strict';
/**
 * US-116 — Capability audit in the engine's own runtime context (F10).
 *
 * Story: As the CEO, I want every MCP baseline server verified daily in
 * the engine's own runtime context, so that a server cannot be fixed in
 * one context and broken in the one the team uses.
 * AC1: Given the daily capability audit runs, When it probes each
 * baseline server, Then the probe executes with the engine's HOME and
 * grants configuration, and any failure opens or updates a ticket the
 * same day.
 *
 * The framework-side contract proven here: probe() spawns each server
 * with the engine process environment (HOME included) merged with the
 * grants spec's env/cwd, authenticated as the CEO role; buildReport()
 * names exactly the failing BASELINE servers (the report + non-zero
 * exit are the signal the supervision layer tickets on — the ticket
 * filing itself is the instance-side audit service's job).
 */
const path = require('path');
const audit = require('../capabilityAudit');

function fakeSdk({ failConnect = false, tools = ['alpha', 'beta'] } = {}) {
  const captured = { transports: [], clients: [] };
  class FakeTransport {
    constructor(opts) { this.opts = opts; captured.transports.push(opts); }
  }
  class FakeClient {
    constructor(info, opts) { this.info = info; captured.clients.push(this); }
    async connect() { if (failConnect) throw new Error('spawn refused'); }
    async listTools() { return { tools: tools.map(name => ({ name })) }; }
    async close() {}
  }
  return { sdk: { Client: FakeClient, StdioClientTransport: FakeTransport }, captured };
}

describe('US-116 capability audit — probe context', () => {
  const SENTINEL = 'US116_ENGINE_HOME_SENTINEL';
  beforeEach(() => { process.env[SENTINEL] = '/engine-home-fixture'; });
  afterEach(() => { delete process.env[SENTINEL]; });

  test('probe spawns the server with the engine process env (HOME context) plus grants env, as CEO', async () => {
    const { sdk, captured } = fakeSdk();
    const spec = { command: 'node', args: ['server.js'], env: { EXTRA: 'from-grants' } };
    const res = await audit.probe('srv-a', spec, sdk, { CEO: 'tok-ceo' });
    expect(res).toEqual({ ok: true, tools: 2 });
    expect(captured.transports).toHaveLength(1);
    const t = captured.transports[0];
    // Engine runtime context: the ambient process env rides along —
    // this is what makes the probe run in the engine's HOME, not the
    // caller's shell context.
    expect(t.env[SENTINEL]).toBe('/engine-home-fixture');
    expect(t.env.HOME).toBe(process.env.HOME);
    // Grants configuration: spec env merged in, CEO role auth attached.
    expect(t.env.EXTRA).toBe('from-grants');
    expect(t.env.MACF_ROLE).toBe('CEO');
    expect(t.env.MACF_ROLE_TOKEN).toBe('tok-ceo');
    expect(t.command).toBe('node');
    expect(t.args).toEqual(['server.js']);
  });

  test('probe resolves a grants-configured cwd against the framework root, defaulting to hands/', async () => {
    const { sdk, captured } = fakeSdk();
    await audit.probe('srv-a', { command: 'node', args: [] }, sdk, {});
    await audit.probe('srv-b', { command: 'node', args: [], cwd: 'hands/servers/x' }, sdk, {});
    const root = require('../../utils/instancePaths').frameworkRoot();
    expect(captured.transports[0].cwd).toBe(path.join(root, 'hands'));
    expect(captured.transports[1].cwd).toBe(path.join(root, 'hands', 'servers', 'x'));
  });

  test('a server that refuses the connection probes as a failure with the error, never as ok', async () => {
    const { sdk } = fakeSdk({ failConnect: true });
    const res = await audit.probe('srv-dead', { command: 'node', args: [] }, sdk, {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/spawn refused/);
  });
});

describe('US-116 capability audit — baseline failure accounting', () => {
  test('buildReport names exactly the baseline servers that failed or never answered', () => {
    const report = audit.buildReport(['a', 'b', 'c'], {
      a: { ok: true, tools: 3 },
      b: { ok: false, error: 'timeout 45000ms' },
      // c never answered — absent from results
    });
    expect(report.baseline).toEqual(['a', 'b', 'c']);
    expect(report.baselineFailures).toEqual(['b', 'c']);
    expect(report.results.a).toEqual({ ok: true, tools: 3 });
    expect(typeof report.at).toBe('string');
  });

  test('a failing role-granted (non-baseline) server is reported but is not a baseline failure', () => {
    const report = audit.buildReport(['a'], {
      a: { ok: true, tools: 1 },
      'role-only': { ok: false, error: 'boom' },
    });
    expect(report.baselineFailures).toEqual([]);
    expect(report.results['role-only'].ok).toBe(false);
  });
});
