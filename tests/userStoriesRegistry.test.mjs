// US-FW-004 acceptance tests — registry read path / writer guard.
// Dependency-free (node:test). Run: node --test tests/
//
// The hazard, demonstrated: a story stored with a stringified list
// field ("[\"engine/tests/receipts.test.js\"]") is read by two
// reasonable checks in two contradictory ways — .length counts the
// string's characters (looks covered) while Array.isArray says not an
// array (looks empty). That disagreement is the miniature of the
// historical F12 misreadings. The fix: normalize on read (parse
// stringified JSON arrays back), reject on write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const us = require(path.join(ROOT, 'slack-agents', 'engine', 'userStories.js'));
const ENGINE_DIR = path.join(ROOT, 'slack-agents', 'engine');
const REGISTRY_IN_TREE = path.join(ENGINE_DIR, '.user-stories.json');

test('hazard: a stringified field makes length and Array.isArray disagree', () => {
  const stored = JSON.parse(JSON.stringify({
    id: 'US-X',
    bdd_tests: '["engine/tests/receipts.test.js"]',
  }));
  // Exactly what loadStories() returned before the fix: the raw value.
  assert.equal(Array.isArray(stored.bdd_tests), false);
  assert.ok(stored.bdd_tests.length > 1, 'length counts characters, not references');
});

test('AC1: stringified JSON-array fields are repaired to arrays on read', () => {
  const out = us.normalizeStoryFields({
    id: 'US-X',
    acceptance_criteria: '["Given a, When b, Then c"]',
    bdd_tests: '["engine/tests/receipts.test.js"]',
    tdd_tests: '["engine/tests/a.test.js", "engine/tests/b.test.js"]',
  });
  assert.deepEqual(out.bdd_tests, ['engine/tests/receipts.test.js']);
  assert.equal(Array.isArray(out.bdd_tests), true);
  assert.equal(out.bdd_tests.length, 1);
  assert.deepEqual(out.tdd_tests, ['engine/tests/a.test.js', 'engine/tests/b.test.js']);
  assert.deepEqual(out.acceptance_criteria, ['Given a, When b, Then c']);
});

test('AC2: real arrays pass through unchanged (idempotent)', () => {
  const story = {
    id: 'US-X',
    acceptance_criteria: ['Given a, When b, Then c'],
    bdd_tests: ['engine/features/x.feature'],
    tdd_tests: [],
  };
  const once = us.normalizeStoryFields(story);
  const twice = us.normalizeStoryFields(once);
  assert.deepEqual(once, story);
  assert.deepEqual(twice, story);
});

test('AC3: non-JSON-array strings are left exactly as stored', () => {
  const out = us.normalizeStoryFields({
    id: 'US-X',
    bdd_tests: 'engine/tests/receipts.test.js',
    tdd_tests: 'not json',
    acceptance_criteria: '["unclosed"',
  });
  assert.equal(out.bdd_tests, 'engine/tests/receipts.test.js');
  assert.equal(out.tdd_tests, 'not json');
  assert.equal(out.acceptance_criteria, '["unclosed"');
});

test('AC4: createStory rejects string-typed list fields and writes nothing', () => {
  assert.equal(fs.existsSync(REGISTRY_IN_TREE), false, 'precondition: framework tree carries no registry');
  for (const field of ['bdd_tests', 'tdd_tests', 'acceptance_criteria']) {
    const input = {
      title: 'As a Spokbot operator, I want a guard, so that writes are typed',
      story_points: 5,
      acceptance_criteria: ['Given a, When b, Then c'],
      bdd_tests: ['engine/features/x.feature'],
      tdd_tests: ['engine/tests/x.test.js'],
      [field]: '["stringified"]',
    };
    assert.throws(() => us.createStory(input), (e) => e instanceof TypeError && e.message.includes(field));
  }
  assert.equal(fs.existsSync(REGISTRY_IN_TREE), false, 'rejected calls must not create a registry');
});

test('AC5: saveStories rejects string-typed list fields before writing', () => {
  assert.equal(fs.existsSync(REGISTRY_IN_TREE), false, 'precondition: framework tree carries no registry');
  assert.throws(
    () => us.saveStories({ stories: [{ id: 'US-X', bdd_tests: '["x"]' }], nextId: 2 }),
    (e) => e instanceof TypeError && e.message.includes('bdd_tests'),
  );
  assert.equal(fs.existsSync(REGISTRY_IN_TREE), false, 'rejected save must not write a registry');
});

test('AC6: baseline registry distribution is unchanged by normalization', (t) => {
  const baseline = path.resolve(ROOT, '..', 'baseline-server', 'slack-agents', 'engine', '.user-stories.json');
  if (!fs.existsSync(baseline)) { t.skip('baseline snapshot not present on this host'); return; }
  const data = JSON.parse(fs.readFileSync(baseline, 'utf8'));
  const normalized = data.stories.map(s => us.normalizeStoryFields(s));
  for (const s of normalized) {
    assert.ok(Array.isArray(s.acceptance_criteria), s.id);
    assert.ok(Array.isArray(s.bdd_tests), s.id);
    assert.ok(Array.isArray(s.tdd_tests), s.id);
  }
  const both = normalized.filter(s => s.bdd_tests.length && s.tdd_tests.length).length;
  const tddOnly = normalized.filter(s => !s.bdd_tests.length && s.tdd_tests.length).length;
  const neither = normalized.filter(s => !s.bdd_tests.length && !s.tdd_tests.length).length;
  assert.equal(both, 12);
  assert.equal(tddOnly, 1);
  assert.equal(neither, 10);
  assert.deepEqual(normalized, data.stories, 'normalization must be lossless on healthy data');
});
