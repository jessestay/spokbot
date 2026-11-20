// Framework fixture registry (F12 step B/C fixture) — generated from
// the pristine production baseline by tests/fixtures/build-fixture.mjs.
// Pins the backfill transformations the fixture exists to carry:
// the step-B references (21 of the 23 baseline stories now BDD+TDD;
// US-120/US-121 stay empty per the absence findings), the US-112/
// US-113 criterion repairs (compressed Given/Then criteria gain
// their missing When), and the step-C feature stories (US-FW-018,
// US-FW-025, US-FW-031 adopt the 3 orphaned feature files). US-FW-031
// was BDD-only at step C (the PM-breakdown component had no suite,
// recorded not invented); step D (2026-11-19) authored the suite
// (engine/tests/pm-breakdown.test.js) and the fixture now carries
// its TDD reference too. The production registry itself is
// untouched; it receives the same changes at its first
// post-cutover edit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { lintRegistry } = require('../slack-agents/engine/storyLint.js');

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'user-stories.fixture.json');
const RESOLVE_ROOT = path.join(import.meta.dirname, '..', 'slack-agents');
const report = lintRegistry(FIXTURE, { resolveRoot: RESOLVE_ROOT });

test('fixture registry lints with zero errors — both criterion repairs hold, no dangling refs', () => {
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors, null, 2));
  assert.equal(report.summary.dangling_references, 0);
  assert.equal(report.summary.stringified_fields, 0);
});

test('step-B references + step-C stories + step-D closure: 24 stories carry BDD+TDD; only US-120 and US-121 remain untested', () => {
  assert.equal(report.summary.total, 26);
  assert.equal(report.summary.with_both, 24);
  assert.equal(report.summary.bdd_only, 0); // US-FW-031 gained its TDD suite in step D
  assert.equal(report.summary.neither, 2);
  const neither = report.stories.filter(s => s.bdd_count === 0 && s.tdd_count === 0).map(s => s.id);
  assert.deepEqual(neither.sort(), ['US-120', 'US-121']);
  const bddOnly = report.stories.filter(s => s.bdd_count > 0 && s.tdd_count === 0).map(s => s.id);
  assert.deepEqual(bddOnly, []);
});

test('lifecycle state mirrors production truth: all 26 in-progress, 24 now stale-flagged', () => {
  assert.deepEqual(report.summary.by_status, { 'in-progress': 26 });
  assert.equal(report.summary.stale_in_progress, 24);
});
