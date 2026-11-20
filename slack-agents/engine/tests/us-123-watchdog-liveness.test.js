'use strict';
/**
 * US-123 — Watchdog auto-restore of known failure classes.
 *
 * Story: As Jesse, I want the engine, Vikunja, gateway, and n8n kept
 * up by a watchdog that auto-restores known failure classes, so that
 * health means workflows actually execute, not that a heartbeat is
 * fresh.
 * AC1: Given a known failure class occurs (MCP binary loss, user
 * wipe, permission reset, gateway empty-200 stall), When the
 * watchdog runs, Then the service is restored automatically and a
 * workflow task run completing afterwards proves execution, not just
 * process liveness.
 *
 * Framework component proven here: engine/watchdog-liveness.js, the
 * zombie-engine probe the watchdog's restore decision rests on. It
 * judges LIVENESS, not presence — the Oct 16, 2026 failure class,
 * where the engine's Postgres died while every process stayed alive
 * and a presence-only watchdog reported healthy. The probe requires
 * BOTH the engine-home Postgres postmaster AND a fresh engine
 * heartbeat; consecutive bad evaluations strike, and only at
 * STRIKES_TO_KILL does the verdict become 'zombie' (the watchdog
 * then kills + relaunches). A healthy evaluation resets the count,
 * so a slow boot or a single transient read can never trigger a
 * restore.
 *
 * Step-B boundary (recorded in the worklog): the auto-restore
 * ORCHESTRATOR — engine-watchdog.sh, which acts on the zombie
 * verdict and restores the other failure classes (MCP binary loss,
 * permission resets, gateway stalls) — is instance-side and is NOT
 * present in the framework tree; the framework carries this probe,
 * engine/gateway-watchdog.sh, and the supervision/ checks. No
 * orchestrator was invented here.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'macf-us123-'));
const HB = path.join(TMP, 'engine-heartbeat.json');
const STATE = path.join(TMP, 'liveness-state.json');
process.env.MACF_HEARTBEAT_FILE = HB;
process.env.MACF_LIVENESS_STATE = STATE;

const { evaluateLiveness, HEARTBEAT_STALE_MS, STRIKES_TO_KILL } = require('../watchdog-liveness');

function heartbeat(ageMs) {
  fs.writeFileSync(HB, JSON.stringify({ at: Date.now() - ageMs }));
}
beforeEach(() => { try { fs.unlinkSync(STATE); } catch {} try { fs.unlinkSync(HB); } catch {} });

describe('US-123 watchdog liveness — health means execution, not presence', () => {
  test('fresh heartbeat + database present: healthy, no strikes', () => {
    heartbeat(1000);
    const v = evaluateLiveness({ pgPresent: true });
    expect(v).toMatchObject({ verdict: 'healthy', strikes: 0, reasons: [] });
  });

  test('database gone while processes live: strike with pg_missing — presence is not health', () => {
    heartbeat(1000);
    const v = evaluateLiveness({ pgPresent: false });
    expect(v.verdict).toBe('strike');
    expect(v.reasons).toEqual(['pg_missing']);
  });

  test('stale heartbeat: strike with heartbeat_stale', () => {
    heartbeat(HEARTBEAT_STALE_MS + 60000);
    const v = evaluateLiveness({ pgPresent: true });
    expect(v.verdict).toBe('strike');
    expect(v.reasons).toEqual(['heartbeat_stale']);
  });

  test('a missing heartbeat file counts as stale, never as healthy', () => {
    const v = evaluateLiveness({ pgPresent: true });
    expect(v.verdict).toBe('strike');
    expect(v.reasons).toEqual(['heartbeat_stale']);
    expect(v.heartbeatAgeMs).toBeNull();
  });

  test(`only ${STRIKES_TO_KILL} consecutive bad evaluations declare a zombie — a transient never restores`, () => {
    heartbeat(HEARTBEAT_STALE_MS + 60000);
    expect(evaluateLiveness({ pgPresent: true }).verdict).toBe('strike');
    expect(evaluateLiveness({ pgPresent: true }).verdict).toBe('zombie');
    // Recovery resets the count: the next bad evaluation is a first
    // strike again, not an instant zombie.
    heartbeat(1000);
    expect(evaluateLiveness({ pgPresent: true })).toMatchObject({ verdict: 'healthy', strikes: 0 });
    heartbeat(HEARTBEAT_STALE_MS + 60000);
    expect(evaluateLiveness({ pgPresent: true }).verdict).toBe('strike');
  });
});
