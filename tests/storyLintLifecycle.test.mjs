// US-FW-006 — status-lifecycle rule in the registry lint (F12 step A.3).
// A story at in-progress with complete, resolving BDD+TDD evidence is
// lifecycle review debt: flagged `stale-in-progress` (warning, never
// an error). Coverage-blocked or reference-broken stories are not
// double-flagged; other statuses are never flagged. The summary gains
// by_status + stale_in_progress with all prior fields unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { lintStories, lintRegistry } = require('../slack-agents/engine/storyLint.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'macf-usfw006-'));
for (const f of ['engine/features/x.feature', 'engine/tests/x.test.js']) {
  fs.mkdirSync(path.join(ROOT, path.dirname(f)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, f), '// fixture\n');
}

function story(overrides = {}) {
  return {
    id: 'US-900',
    title: 'As a user, I want a thing, so that it helps',
    story_points: 3,
    acceptance_criteria: ['Given a start, When it runs, Then it works'],
    bdd_tests: ['engine/features/x.feature'],
    tdd_tests: ['engine/tests/x.test.js'],
    status: 'in-progress',
    ...overrides,
  };
}
const warningsOf = (report, id) => report.stories.find(s => s.id === id).warnings.map(w => w.kind);

test('AC1: in-progress with complete resolving evidence is flagged stale-in-progress', () => {
  const report = lintStories([story()], ROOT);
  assert.deepEqual(warningsOf(report, 'US-900'), ['stale-in-progress']);
  assert.equal(report.summary.stale_in_progress, 1);
  assert.equal(report.errors.length, 0); // a warning — exit behavior unchanged
});

test('AC2: coverage-blocked or reference-broken in-progress stories are not double-flagged', () => {
  const noTests = story({ id: 'US-901', bdd_tests: [], tdd_tests: [] });
  const tddOnly = story({ id: 'US-902', bdd_tests: [] });
  const dangling = story({ id: 'US-903', tdd_tests: ['engine/tests/missing.test.js'] });
  const report = lintStories([noTests, tddOnly, dangling], ROOT);
  assert.ok(!warningsOf(report, 'US-901').includes('stale-in-progress'));
  assert.ok(!warningsOf(report, 'US-902').includes('stale-in-progress'));
  assert.ok(!warningsOf(report, 'US-903').includes('stale-in-progress'));
  assert.equal(report.summary.stale_in_progress, 0);
});

test('AC3: a done story with complete evidence is never flagged', () => {
  const report = lintStories([story({ status: 'done' })], ROOT);
  assert.deepEqual(warningsOf(report, 'US-900'), []);
  assert.equal(report.summary.stale_in_progress, 0);
});

test('AC4: summary reports by_status alongside every pre-existing field', () => {
  const report = lintStories([
    story({ id: 'US-900' }),
    story({ id: 'US-901', status: 'done' }),
    story({ id: 'US-902', status: 'done' }),
  ], ROOT);
  assert.deepEqual(report.summary.by_status, { 'in-progress': 1, done: 2 });
  for (const k of ['total', 'with_both', 'tdd_only', 'bdd_only', 'neither', 'dangling_references', 'stringified_fields']) {
    assert.equal(typeof report.summary[k], 'number', `summary.${k} still present`);
  }
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.with_both, 3);
});

test('AC5: the production baseline registry measures exactly 12 stale of 23 in-progress', () => {
  const baseline = path.resolve(ROOT, '..', '..', 'spokbot-build', 'baseline-server',
    'slack-agents', 'engine', '.user-stories.json');
  const registryPath = fs.existsSync(baseline) ? baseline
    : path.join(process.env.HOME, 'workspace/spokbot-build/baseline-server/slack-agents/engine/.user-stories.json');
  const resolveRoot = path.join(process.env.HOME, 'workspace/spokbot-build/framework/slack-agents');
  const report = lintRegistry(registryPath, { resolveRoot });
  assert.deepEqual(report.summary.by_status, { 'in-progress': 23 });
  assert.equal(report.summary.stale_in_progress, 12);
  const staleIds = report.stories.filter(s => s.warnings.some(w => w.kind === 'stale-in-progress')).map(s => s.id);
  assert.ok(!staleIds.includes('US-115')); // TDD-only: coverage-blocked, not lifecycle debt
});
