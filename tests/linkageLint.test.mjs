// US-FW-007 — linkage lint (F12 step C): every test/feature file in
// the tree maps to at least one story reference, or the lint fails
// naming it. Link sources: registry bdd/tdd references, feature
// "(Acceptance suite: …)" lines, and framework story documents.
// AC5 runs the real tree: the step-C backlog is measured, not hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { lintLinkage } = require('../slack-agents/engine/linkageLint.js');

const FW_ROOT = path.join(import.meta.dirname, '..');
const SA_ROOT = path.join(FW_ROOT, 'slack-agents');
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'user-stories.fixture.json');

// ── synthetic mini-tree ─────────────────────────────────────────────
function miniTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'macf-usfw007-'));
  const sa = path.join(root, 'slack-agents');
  const fw = path.join(root, 'framework');
  const write = (base, rel, content = '// fixture\n') => {
    fs.mkdirSync(path.join(base, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(base, rel), content);
  };
  write(sa, 'engine/features/f1.feature',
    'Feature: F1\n  (Acceptance suite: engine/tests/linked-by-feature.test.js)\n');
  write(sa, 'engine/features/orphan.feature', 'Feature: nobody references me\n');
  write(sa, 'engine/tests/linked-by-story.test.js');
  write(sa, 'engine/tests/linked-by-feature.test.js');
  write(sa, 'engine/tests/unlinked.test.js');
  write(sa, 'engine/root-suite.test.js');
  write(fw, 'tests/root-linked.test.mjs');
  write(fw, 'stories/US-FW-900-toy.md', '# Toy\n\n**Tests:** `tests/root-linked.test.mjs`\n');
  const registry = path.join(root, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ stories: [{
    id: 'US-900', title: 'As a user, I want a thing, so that it helps',
    story_points: 3, status: 'in-progress',
    acceptance_criteria: ['Given a start, When it runs, Then it works'],
    bdd_tests: ['engine/features/f1.feature'],
    tdd_tests: ['engine/tests/linked-by-story.test.js', 'engine/tests/ghost.test.js'],
  }] }));
  return { registry, sa, fw };
}

test('AC1+AC4: registry refs, feature acceptance lines, and story docs all link files', () => {
  const { registry, sa, fw } = miniTree();
  const r = lintLinkage({ registryPath: registry, scanRoot: sa, frameworkRoot: fw });
  const byPath = Object.fromEntries(r.files.tests.map(f => [f.path, f]));
  assert.ok(byPath['engine/tests/linked-by-story.test.js'].linked_by.some(s => s.startsWith('registry:')));
  assert.ok(byPath['engine/tests/linked-by-feature.test.js'].linked_by.some(s => s.startsWith('feature:')));
  assert.ok(byPath['tests/root-linked.test.mjs'].linked_by.some(s => s.startsWith('story-doc:')));
  const feat = Object.fromEntries(r.files.features.map(f => [f.path, f]));
  assert.ok(feat['engine/features/f1.feature'].linked_by.length > 0);
});

test('AC2+AC3: unlinked files and dangling references are errors naming the file', () => {
  const { registry, sa, fw } = miniTree();
  const r = lintLinkage({ registryPath: registry, scanRoot: sa, frameworkRoot: fw });
  const kinds = r.errors.map(e => `${e.kind}:${e.path || e.ref}`);
  assert.ok(kinds.some(k => k === 'unlinked-feature-file:engine/features/orphan.feature'), kinds.join(' | '));
  assert.ok(kinds.some(k => k === 'unlinked-test-file:engine/tests/unlinked.test.js'), kinds.join(' | '));
  assert.ok(kinds.some(k => k.startsWith('dangling-reference:') && k.includes('ghost.test.js')), kinds.join(' | '));
  assert.equal(r.summary.linked_tests + r.summary.unlinked_tests, r.summary.test_files);
});

test('engine-root test files are classified outside jest testMatch (warning, distinct from linkage)', () => {
  const { registry, sa, fw } = miniTree();
  const r = lintLinkage({ registryPath: registry, scanRoot: sa, frameworkRoot: fw });
  const root = r.files.tests.find(f => f.path === 'engine/root-suite.test.js');
  assert.equal(root.in_testmatch, false);
  assert.ok(r.warnings.some(w => w.kind === 'test-outside-testmatch' && w.path === 'engine/root-suite.test.js'));
  assert.equal(r.summary.outside_testmatch, 1);
});

// ── the real tree (AC5) ─────────────────────────────────────────────
test('AC5: real tree — step C complete: zero unlinked features, zero unlinked tests (amended 2026-11-18)', () => {
  const r = lintLinkage({ registryPath: FIXTURE, scanRoot: SA_ROOT, frameworkRoot: FW_ROOT });
  const unlinkedFeatures = r.files.features.filter(f => f.linked_by.length === 0).map(f => f.path).sort();
  assert.deepEqual(unlinkedFeatures, []);
  const unlinkedTests = new Set(r.files.tests.filter(f => f.linked_by.length === 0).map(f => f.path));
  for (const p of [
    'engine/tests/us-110-content-batch.test.js', 'engine/tests/us-113-social-publishing.test.js',
    'engine/tests/us-114-seo-changes.test.js', 'engine/tests/us-116-capability-audit.test.js',
    'engine/tests/us-117-dead-letter.test.js', 'engine/tests/us-119-finance-snapshot.test.js',
    'engine/tests/us-122-demo-relay.test.js', 'engine/tests/us-123-watchdog-liveness.test.js',
    'engine/tests/outcome-audit.test.js', 'engine/tests/job-submission-acceptance.test.js',
    'tests/storyLint.test.mjs', 'tests/userStoriesRegistry.test.mjs', 'tests/dockerInstall.test.mjs',
  ]) assert.ok(!unlinkedTests.has(p), `${p} should be linked`);
  assert.equal(r.summary.outside_testmatch, 2); // engine/mcpClient.test.js + engine/publisher.test.js
  // Step C complete (2026-11-18): every test file in the tree is
  // story-linked. Any new unlinked file fails this test loudly —
  // that is the anti-regrowth property the lint exists for.
  assert.equal(r.summary.unlinked_tests, 0, `backlog measured, got ${r.summary.unlinked_tests}`);
  assert.equal(r.summary.linked_tests + r.summary.unlinked_tests, r.summary.test_files);
  assert.equal(r.summary.dangling_references, 0);
});
