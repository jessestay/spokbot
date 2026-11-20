/**
 * engine/tests/vikunja-supervision.test.js
 *
 * TDD for Vikunja supervision (Oct 10, 2026 — Jesse's order).
 *
 * ROOT CAUSE (Oct 10, 2026): Vikunja died silently three times. The watchdog
 * HAD a Vikunja liveness probe and restart logic, but start.sh launched
 * Vikunja with `nohup ... &`. The runtime kills the entire PROCESS GROUP
 * when the exec session ends — nohup cannot escape a PGID-based kill. So
 * every restart died again hours later when its parent session terminated.
 *
 * Jesse's law: "The watchdog and auto healer that should be part of the MACF
 * should have detected this, and BDD and TDD should have alerted that it
 * wasn't."
 *
 * These tests verify:
 * 1. start.sh uses setsid (not bare nohup) so the process survives session teardown.
 * 2. start.sh detaches stdin (/dev/null).
 * 3. The watchdog contains a Vikunja liveness probe.
 * 4. The watchdog calls start.sh on probe failure.
 * 5. The watchdog's pkill is anchored (cannot kill its own caller).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// PORTABILITY (Oct 28, 2026): these files live in the MACF root of the VM
// host. The Oracle server supervises Vikunja via systemd units instead and
// has neither file, so hardcoding the VM's absolute paths made the suite
// fail on every other host while testing nothing about that host. Resolve
// against candidate roots (MACF_ROOT env wins); where neither file exists,
// skip — the invariants below still run wherever the files live.
// US-FW-002 (Nov 17, 2026): the per-machine candidate literals are gone —
// the running user's own home workspace is the candidate, whichever
// user or host that is.
const CANDIDATE_ROOTS = [
  process.env.MACF_ROOT,
  path.join(os.homedir(), 'workspace', 'macf'),
  path.resolve(__dirname, '..', '..', '..'),
].filter(Boolean);
function resolveUnderRoots(rel) {
  for (const root of CANDIDATE_ROOTS) {
    const p = path.join(root, rel);
    if (fs.existsSync(p)) return p;
  }
  return path.join(CANDIDATE_ROOTS[0] || '', rel);
}
const START_SH = resolveUnderRoots(path.join('vikunja', 'start.sh'));
const WATCHDOG_SH = resolveUnderRoots('engine-watchdog.sh');
const HAVE_SUPERVISION_FILES = fs.existsSync(START_SH) && fs.existsSync(WATCHDOG_SH);
const describeSupervision = HAVE_SUPERVISION_FILES ? describe : describe.skip;

describeSupervision('Vikunja start.sh process survival', () => {
  let content;

  beforeAll(() => {
    content = fs.readFileSync(START_SH, 'utf8');
  });

  test('start.sh exists and is executable', () => {
    expect(fs.existsSync(START_SH)).toBe(true);
    const stat = fs.statSync(START_SH);
    expect(stat.mode & 0o100).toBeTruthy();
  });

  test('uses setsid for process-group-independent launch', () => {
    // The critical invariant: bare `nohup ... &` dies with the parent session.
    // setsid creates a new session so Vikunja survives independently.
    expect(content).toMatch(/setsid/);
  });

  test('does NOT rely on bare nohup without setsid', () => {
    // If nohup appears, setsid must also appear (setsid wraps the launch).
    // A lone `nohup ... &` is the defect that killed Vikunja repeatedly.
    const hasBareNohup = /^nohup /m.test(content) && !content.includes('setsid');
    expect(hasBareNohup).toBe(false);
  });

  test('detaches stdin from /dev/null', () => {
    expect(content).toMatch(/<\s*\/dev\/null/);
  });

  test('is idempotent (probe-first, exits 0 if already up)', () => {
    expect(content).toMatch(/curl.*3456.*api\/v1\/info/);
    expect(content).toMatch(/already responding/);
  });
});

describeSupervision('Watchdog Vikunja supervision', () => {
  let content;

  beforeAll(() => {
    content = fs.readFileSync(WATCHDOG_SH, 'utf8');
  });

  test('watchdog probes Vikunja liveness', () => {
    expect(content).toMatch(/3456\/api\/v1\/info/);
  });

  test('watchdog restarts Vikunja via start.sh on probe failure', () => {
    expect(content).toMatch(/vikunja.*restart/i);
    expect(content).toMatch(/start\.sh/);
  });

  test('watchdog pkill is anchored (cannot kill its own caller)', () => {
    // Unanchored pkill -f matches any command line mentioning the pattern,
    // including the shell running the watchdog itself (learned Sep 25, 2026).
    const pkillLines = content.split('\n').filter(l => l.includes('pkill -f') && l.includes('vikunja'));
    expect(pkillLines.length).toBeGreaterThan(0);
    for (const line of pkillLines) {
      expect(line).toMatch(/\^/); // must be anchored with ^
    }
  });

  test('watchdog runs schedule self-healing check', () => {
    // Oct 10, 2026: check-schedules.js wired into watchdog.
    expect(content).toMatch(/check-schedules\.js/);
  });
});
