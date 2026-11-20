// US-FW-032 — supervision shell layer invariants (F12 step D).
// First coverage for the supervision/ tree. The scripts hardcode
// the production server's absolute paths (recorded finding in the
// story doc), so this suite pins their contracts statically:
// inventory shape, the runner's atomic-stamp + exit-code contract,
// the liveness probe's health definition and transition-only
// alerting, token-health's exit-code rule, and the guard that the
// Oct 10 failure class (unanchored pkill / bare nohup) never
// enters this layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SUP = path.join(import.meta.dirname, '..', 'supervision');
const read = (rel) => fs.readFileSync(path.join(SUP, rel), 'utf8');

const unitsTxt = read('UNITS.txt');
const runSh = read('run.sh');
const livenessSh = read(path.join('checks', 'liveness.sh'));
const tokenHealthSh = read(path.join('checks', 'token_health.sh'));
const checkFiles = fs.readdirSync(path.join(SUP, 'checks')).sort();
const allScripts = ['run.sh', ...checkFiles.map(f => path.join('checks', f))]
  .map(rel => ({ rel, body: read(rel) }));

test('AC1: UNITS.txt is well-formed service/timer pairs with unique names', () => {
  const names = [];
  for (const line of unitsTxt.split('\n')) {
    const m = line.trim().match(/^(macf-sup-[a-z0-9-]+)\.service \/ (macf-sup-[a-z0-9-]+)\.timer$/);
    if (!m) continue;
    assert.equal(m[1], m[2], `service/timer name mismatch: ${line}`);
    names.push(m[1]);
  }
  assert.equal(names.length, 15, `expected the 15 installed pairs, got ${names.length}`);
  assert.equal(new Set(names).size, names.length, 'duplicate unit names in inventory');
});

test('AC1: every check script maps to a unit, or is the shared alert helper', () => {
  const mapped = {
    'liveness.sh': 'macf-sup-liveness',
    'token_health.sh': 'macf-sup-token-health',
    'task69_watch.py': 'macf-sup-task69-watch',
    'directive_watch.py': 'macf-sup-directive-watch',
    'resilience_watch.py': 'macf-sup-resilience-watch',
    'backup.py': 'macf-sup-nightly-backup',
  };
  for (const f of checkFiles) {
    if (f === 'slack_alert.py') continue;
    assert.ok(mapped[f], `${f}: no unit mapping declared — new check or stale file?`);
    assert.ok(unitsTxt.includes(mapped[f]), `${f}: unit ${mapped[f]} missing from UNITS.txt`);
  }
  // slack_alert.py is a helper: at least two other checks must use it.
  const users = checkFiles.filter(f => f !== 'slack_alert.py' && read(path.join('checks', f)).includes('slack_alert'));
  assert.ok(users.length >= 2, `slack_alert helper used by ${users.length} checks`);
});

test('AC2: run.sh stamps atomically, logs with timestamps, propagates the exit code', () => {
  assert.match(runSh, /> "\$STAMP\.tmp" && mv "\$STAMP\.tmp" "\$STAMP"/, 'stamp must be tmp + mv (atomic)');
  assert.match(runSh, /printf '%s %s\\n' "\$\(date \+%s\)" "\$RC"/, 'stamp format is "<epoch> <exit code>"');
  assert.match(runSh, />> "\$LOG" 2>&1/, 'output appends to the named log');
  assert.match(runSh, /exit \$RC/, 'run.sh exits with the command\'s exit code');
  assert.match(runSh, /HOME=\/home\/ubuntu\/workspace\/macf\/engine-home/, 'runs the command with the engine HOME');
});

test('AC3: liveness requires services + API + gateway liveliness + fresh engine log', () => {
  for (const svc of ['macf-engine', 'macf-vikunja', 'macf-gateway', 'macf-n8n']) {
    assert.ok(livenessSh.includes(svc), `liveness must check ${svc}`);
  }
  assert.match(livenessSh, /127\.0\.0\.1:3456\/api\/v1\/info/, 'Vikunja API probe');
  assert.match(livenessSh, /127\.0\.0\.1:4000\/health\/liveliness/, 'gateway probe must be the liveliness endpoint');
  assert.doesNotMatch(livenessSh, /127\.0\.0\.1:4000\/health[^/]/, 'bare /health is the deep-check trap — never probe it');
  assert.match(livenessSh, /\[ "\$AGE" -lt 600 \]/, 'engine log must be fresh within 600s');
});

test('AC4: liveness alerts only on transition, writes state atomically, exits non-zero when down', () => {
  assert.match(livenessSh, /\[ "\$CUR" != "\$PREV" \]/, 'alert block is gated on a state transition');
  assert.match(livenessSh, /> "\$STATE\.tmp" && mv "\$STATE\.tmp" "\$STATE"/, 'state file is tmp + mv (atomic)');
  assert.match(livenessSh, /\[ "\$CUR" = "ok" \]\s*$/, 'final exit status is the health verdict');
});

test('AC5: token_health runs the connectivity proof first; the metadata exit code is the result', () => {
  const jestAt = tokenHealthSh.indexOf('npx jest engine/tests/mcp');
  const metaAt = tokenHealthSh.indexOf('node engine/token-health.js');
  assert.ok(jestAt !== -1 && metaAt !== -1 && jestAt < metaAt, 'connectivity suite runs before the metadata check');
  assert.match(tokenHealthSh, /node engine\/token-health\.js\nexit \$\?/, 'script exits with the metadata check\'s code');
});

test('AC6: no unanchored pkill and no bare nohup launch anywhere in the layer', () => {
  for (const { rel, body } of allScripts) {
    for (const line of body.split('\n')) {
      if (/^\s*#/.test(line)) continue; // comments explain history; they are not launches
      assert.doesNotMatch(line, /\bpkill\b(?!.*\^)/, `${rel}: pkill without an anchor: ${line.trim()}`);
      assert.doesNotMatch(line, /\bnohup\b/, `${rel}: bare nohup launch: ${line.trim()}`);
    }
  }
});
