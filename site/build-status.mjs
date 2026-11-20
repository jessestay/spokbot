#!/usr/bin/env node
// US-FW-035 — public status dashboard generator.
//
// Renders site/status.html from the repo's own state and nothing
// else: the story-registry fixture (tests/fixtures/
// user-stories.fixture.json) scored by the repo's own lints
// (slack-agents/engine/storyLint.js + linkageLint.js — the same
// modules the test suites pin). No server, no network, no
// hand-maintained numbers: regenerate after any registry or tree
// change and the page is current.
//
//   node site/build-status.mjs            → writes site/status.html
//   node site/build-status.mjs <outPath>  → writes <outPath>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function buildStatusHtml({ root, outPath } = {}) {
  const ROOT = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const SA_ROOT = path.join(ROOT, 'slack-agents');
  const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'user-stories.fixture.json');

  const { lintRegistry } = require(path.join(SA_ROOT, 'engine', 'storyLint.js'));
  const { lintLinkage } = require(path.join(SA_ROOT, 'engine', 'linkageLint.js'));

  const registry = lintRegistry(FIXTURE, { resolveRoot: SA_ROOT });
  const linkage = lintLinkage({ registryPath: FIXTURE, scanRoot: SA_ROOT, frameworkRoot: ROOT });
  const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const titles = new Map((raw.stories || []).map((s) => [s.id, s.title]));

  const s = registry.summary;
  const l = linkage.summary;
  const generated = new Date().toISOString();

  const coverage = (row) => {
    if (row.bdd_count > 0 && row.tdd_count > 0) return 'BDD + TDD';
    if (row.bdd_count > 0) return 'BDD only';
    if (row.tdd_count > 0) return 'TDD only';
    return 'No tests linked';
  };

  const rows = registry.stories.map((row) => [
    `    <tr><td>${esc(row.id)}</td><td>${esc(titles.get(row.id) || '')}</td>`,
    `<td>${row.points ?? '—'}</td><td>${esc(row.status || '—')}</td>`,
    `<td>${row.ac_count}</td><td>${coverage(row)}</td></tr>`,
  ].join('')).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spokbot — Build Status</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.15rem; margin-top: 2rem; }
  .cards { display: flex; flex-wrap: wrap; gap: 1rem; }
  .card { border: 1px solid #ccc; border-radius: 0.5rem; padding: 1rem 1.25rem; min-width: 9rem; }
  .card .n { font-size: 1.8rem; font-weight: 700; }
  .card .k { color: #555; font-size: 0.85rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  th, td { border-bottom: 1px solid #ddd; padding: 0.4rem 0.5rem; text-align: left; vertical-align: top; }
  th { border-bottom: 2px solid #999; }
  footer { color: #555; font-size: 0.85rem; margin-top: 2rem; }
</style>
</head>
<body>
<h1>Spokbot — Build Status</h1>
<p>Every unit of work in Spokbot is a user story with acceptance
criteria, built BDD-first, then TDD. This page is generated from
the repository's own story registry
(<code>tests/fixtures/user-stories.fixture.json</code>) scored by
the repository's own lints (storyLint + linkageLint) — the same
checks the automated suites enforce. Nothing here is typed by
hand; regenerate with <code>node site/build-status.mjs</code>.</p>

<div class="cards">
  <div class="card"><div class="n" data-metric="stories-total">${s.total}</div><div class="k">stories in the registry</div></div>
  <div class="card"><div class="n" data-metric="with-both">${s.with_both}</div><div class="k">with BDD + TDD evidence</div></div>
  <div class="card"><div class="n" data-metric="bdd-only">${s.bdd_only}</div><div class="k">BDD only</div></div>
  <div class="card"><div class="n" data-metric="neither">${s.neither}</div><div class="k">no tests linked</div></div>
  <div class="card"><div class="n" data-metric="dangling">${s.dangling_references}</div><div class="k">dangling references</div></div>
  <div class="card"><div class="n" data-metric="tests-linked">${l.linked_tests}/${l.test_files}</div><div class="k">test files linked to stories</div></div>
  <div class="card"><div class="n" data-metric="features-linked">${l.linked_features}/${l.feature_files}</div><div class="k">feature files linked to stories</div></div>
  <div class="card"><div class="n" data-metric="lint-errors">${registry.errors.length + linkage.errors.length}</div><div class="k">lint errors</div></div>
</div>

<h2>Stories</h2>
<table>
  <thead><tr><th>ID</th><th>Story</th><th>Points</th><th>Status</th><th>Acceptance criteria</th><th>Test evidence</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>

<footer>Generated ${generated} by <code>site/build-status.mjs</code>
from the registry and lint reports in this repository. Story
lifecycle states mirror the registry as committed; a story marked
in-progress with complete evidence is lifecycle review debt, and
the registry lint flags it as such.</footer>
</body>
</html>
`;

  if (outPath) fs.writeFileSync(outPath, html);
  return html;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'status.html');
  buildStatusHtml({ outPath: out });
  console.log(`wrote ${out}`);
}
