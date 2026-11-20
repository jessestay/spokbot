// US-FW-035 — public status dashboard generator tests.
//
// The dashboard (site/status.html) is a static page generated from
// the repo's own state: the story-registry fixture plus the
// storyLint and linkageLint reports. No server, no hand-maintained
// numbers — if the registry or the tree changes, regenerating the
// page changes the page. These tests pin that contract: the
// generator's output must carry exactly the counts the lints
// compute independently here, and every registered story must
// appear on the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SA_ROOT = path.join(ROOT, 'slack-agents');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'user-stories.fixture.json');

const { lintRegistry } = require(path.join(SA_ROOT, 'engine', 'storyLint.js'));
const { lintLinkage } = require(path.join(SA_ROOT, 'engine', 'linkageLint.js'));
const { buildStatusHtml } = await import(path.join(ROOT, 'site', 'build-status.mjs'));

function generate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-status-'));
  const out = path.join(dir, 'status.html');
  buildStatusHtml({ root: ROOT, outPath: out });
  return fs.readFileSync(out, 'utf8');
}

test('the page carries the lint-computed story counts, not hand-written numbers', () => {
  const html = generate();
  const { summary } = lintRegistry(FIXTURE, { resolveRoot: SA_ROOT });
  assert.ok(html.includes(`data-metric="stories-total">${summary.total}<`),
    'stories total on the page must equal the storyLint summary');
  assert.ok(html.includes(`data-metric="with-both">${summary.with_both}<`));
  assert.ok(html.includes(`data-metric="bdd-only">${summary.bdd_only}<`));
  assert.ok(html.includes(`data-metric="neither">${summary.neither}<`));
  assert.ok(html.includes(`data-metric="dangling">${summary.dangling_references}<`));
});

test('the page carries the linkage counts', () => {
  const html = generate();
  const { summary } = lintLinkage({ registryPath: FIXTURE, scanRoot: SA_ROOT, frameworkRoot: ROOT });
  assert.ok(html.includes(`data-metric="tests-linked">${summary.linked_tests}/${summary.test_files}<`));
  assert.ok(html.includes(`data-metric="features-linked">${summary.linked_features}/${summary.feature_files}<`));
});

test('every registered story appears on the page by id', () => {
  const html = generate();
  const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (const s of data.stories) {
    assert.ok(html.includes(`>${s.id}<`), `story ${s.id} missing from the dashboard`);
  }
});

test('the page is self-contained: no external assets, and it names its data source', () => {
  const html = generate();
  assert.ok(!/src="https?:/i.test(html), 'no external script/img sources');
  assert.ok(!/href="https?:/i.test(html), 'no external links');
  assert.ok(html.includes('user-stories.fixture.json'), 'page must name the registry it renders');
  assert.ok(html.includes('Generated'), 'page must carry a generation timestamp');
});

test('story titles are HTML-escaped (a title cannot break the page)', () => {
  const html = generate();
  assert.ok(!html.includes('<script'), 'no script markup may appear, injected or otherwise');
});
