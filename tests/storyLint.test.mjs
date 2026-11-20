// US-FW-003 acceptance tests — deterministic story-registry lint.
// Dependency-free (node:test). Run: node --test tests/
// The lint is the F12 evidence of record: it parses the registry with a
// real JSON parser and reports field types, AC counts, BDD/TDD reference
// counts, dangling references, and status per story.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lint = require(path.join(ROOT, 'slack-agents', 'engine', 'storyLint.js'));

const CRITERION = 'Given a registry, When it is linted, Then the report is exact';

// Build a tmp tree shaped like slack-agents/: engine/.user-stories.json
// plus the referenced test/feature files. Returns the registry path.
function tmpRegistry(stories, refs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-lint-'));
  fs.mkdirSync(path.join(dir, 'engine'), { recursive: true });
  for (const r of refs) {
    const p = path.join(dir, r);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '// fixture\n');
  }
  const reg = path.join(dir, 'engine', '.user-stories.json');
  fs.writeFileSync(reg, JSON.stringify({ stories, nextId: 999 }, null, 2));
  return reg;
}

function goodStory(overrides = {}) {
  return {
    id: 'US-900',
    title: 'As a Spokbot operator, I want the registry linted, so that F12 verdicts are exact',
    story_points: 5,
    acceptance_criteria: [CRITERION],
    bdd_tests: ['engine/features/us-900.feature'],
    tdd_tests: ['engine/tests/us-900.test.js'],
    status: 'in-progress',
    ...overrides,
  };
}
const GOOD_REFS = ['engine/features/us-900.feature', 'engine/tests/us-900.test.js'];

test('AC1: well-formed registry lints clean, exit-equivalent 0 errors', () => {
  const reg = tmpRegistry([goodStory()], GOOD_REFS);
  const report = lint.lintRegistry(reg);
  assert.equal(report.errors.length, 0);
  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.with_both, 1);
  assert.equal(report.summary.dangling_references, 0);
  const s = report.stories[0];
  assert.equal(s.ac_count, 1);
  assert.equal(s.bdd_count, 1);
  assert.equal(s.tdd_count, 1);
  assert.equal(s.field_types.bdd_tests, 'array');
  assert.equal(s.status, 'in-progress');
});

test('AC2: stringified bdd_tests field is a stringified-field error, not a count', () => {
  const reg = tmpRegistry(
    [goodStory({ bdd_tests: '["engine/features/us-900.feature"]' })],
    GOOD_REFS,
  );
  const report = lint.lintRegistry(reg);
  assert.equal(report.stories[0].field_types.bdd_tests, 'string');
  const errs = report.stories[0].errors.filter(e => e.kind === 'stringified-field');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].field, 'bdd_tests');
  assert.ok(report.errors.length >= 1);
});

test('AC2b: stringified acceptance_criteria and tdd_tests are also caught', () => {
  const reg = tmpRegistry(
    [goodStory({ acceptance_criteria: '["Given x, When y, Then z"]', tdd_tests: '[]' })],
    GOOD_REFS,
  );
  const report = lint.lintRegistry(reg);
  const kinds = report.stories[0].errors.filter(e => e.kind === 'stringified-field').map(e => e.field);
  assert.deepEqual(kinds.sort(), ['acceptance_criteria', 'tdd_tests']);
});

test('AC3: dangling reference is named per story', () => {
  const reg = tmpRegistry([goodStory({ tdd_tests: ['engine/tests/does-not-exist.test.js'] })], GOOD_REFS);
  const report = lint.lintRegistry(reg);
  const errs = report.stories[0].errors.filter(e => e.kind === 'dangling-reference');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].ref, 'engine/tests/does-not-exist.test.js');
  assert.equal(report.summary.dangling_references, 1);
});

test('AC4: missing criteria, non-Given/When/Then criterion, bad points, bad title each error', () => {
  const reg = tmpRegistry([
    goodStory({ id: 'US-901', acceptance_criteria: [] }),
    goodStory({ id: 'US-902', acceptance_criteria: ['The system should lint things'] }),
    goodStory({ id: 'US-903', story_points: 4 }),
    goodStory({ id: 'US-904', story_points: undefined }),
    goodStory({ id: 'US-905', title: 'Lint the registry please' }),
  ], GOOD_REFS);
  const report = lint.lintRegistry(reg);
  const byId = Object.fromEntries(report.stories.map(s => [s.id, s]));
  assert.ok(byId['US-901'].errors.some(e => e.kind === 'missing-criteria'));
  assert.ok(byId['US-902'].errors.some(e => e.kind === 'criterion-format'));
  assert.ok(byId['US-903'].errors.some(e => e.kind === 'invalid-points'));
  assert.ok(byId['US-904'].errors.some(e => e.kind === 'invalid-points'));
  assert.ok(byId['US-905'].errors.some(e => e.kind === 'title-format'));
});

test('AC5: zero-test stories are coverage warnings with exact summary buckets', () => {
  const reg = tmpRegistry([
    goodStory({ id: 'US-910' }),
    goodStory({ id: 'US-911', bdd_tests: [], tdd_tests: ['engine/tests/us-900.test.js'] }),
    goodStory({ id: 'US-912', bdd_tests: ['engine/features/us-900.feature'], tdd_tests: [] }),
    goodStory({ id: 'US-913', bdd_tests: [], tdd_tests: [] }),
  ], GOOD_REFS);
  const report = lint.lintRegistry(reg);
  assert.equal(report.errors.length, 0);
  assert.equal(report.summary.with_both, 1);
  assert.equal(report.summary.tdd_only, 1);
  assert.equal(report.summary.bdd_only, 1);
  assert.equal(report.summary.neither, 1);
  const s913 = report.stories.find(s => s.id === 'US-913');
  assert.ok(s913.warnings.some(w => w.kind === 'no-tests'));
});

test('AC6: production baseline registry matches the verified hand count', (t) => {
  const baseline = path.resolve(ROOT, '..', 'baseline-server', 'slack-agents', 'engine', '.user-stories.json');
  if (!fs.existsSync(baseline)) { t.skip('baseline snapshot not present on this host'); return; }
  const report = lint.lintRegistry(baseline);
  // Exactly two known format deviations exist in the production
  // registry: US-112 and US-113 each have one criterion in compressed
  // "Given …, Then …" form with no explicit "When" clause. Everything
  // else is clean. If the registry is ever fixed, this assertion is
  // the tripwire that notices.
  assert.equal(report.errors.length, 2, JSON.stringify(report.errors, null, 2));
  assert.ok(report.errors.every(e => e.kind === 'criterion-format'));
  assert.ok(report.errors[0].message.startsWith('US-112'));
  assert.ok(report.errors[1].message.startsWith('US-113'));
  assert.equal(report.summary.stringified_fields, 0);
  assert.equal(report.summary.total, 23);
  assert.equal(report.summary.with_both, 12);
  assert.equal(report.summary.tdd_only, 1);
  assert.equal(report.summary.bdd_only, 0);
  assert.equal(report.summary.neither, 10);
  assert.equal(report.summary.dangling_references, 0);
  assert.equal(report.stories.find(s => s.id === 'US-115').tdd_count >= 1, true);
  assert.equal(report.stories.find(s => s.id === 'US-115').bdd_count, 0);
});

test('CLI: prints JSON report and exits 1 on a defective registry, 0 on a clean one', () => {
  const tool = path.join(ROOT, 'slack-agents', 'engine', 'storyLint.js');
  const bad = tmpRegistry([goodStory({ bdd_tests: '["x"]' })], GOOD_REFS);
  let code = 0; let out = '';
  try { out = execFileSync('node', [tool, bad], { encoding: 'utf8' }); }
  catch (e) { code = e.status; out = e.stdout; }
  assert.equal(code, 1);
  assert.equal(JSON.parse(out).summary.total, 1);
  const good = tmpRegistry([goodStory()], GOOD_REFS);
  out = execFileSync('node', [tool, good], { encoding: 'utf8' });
  assert.equal(JSON.parse(out).errors.length, 0);
});
