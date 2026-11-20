#!/usr/bin/env node
/**
 * Spokbot linkage lint (US-FW-007) — F12 step C traceability.
 *
 * Cross-checks the story registry's BDD/TDD references against the
 * test and feature files actually present in the tree, and fails on
 * any file nothing references — so the step-C backlog (suites with
 * no story, feature files with no story) is measured exactly and
 * cannot regrow silently after the backfill.
 *
 * A test file counts as linked when any of these name it:
 *   - a registry story's bdd_tests / tdd_tests (`registry:<id>`)
 *   - a feature file's "(Acceptance suite: …)" line (`feature:<path>`)
 *   - a framework story document, stories/*.md (`story-doc:<file>`)
 * A feature file counts as linked when a registry story references
 * it. Registry/feature references to files that do not exist are
 * `dangling-reference` errors. Test files under slack-agents that
 * live outside jest's testMatch (**\/tests/**\/*.test.js) — the two
 * engine-root suites — are classified `test-outside-testmatch`
 * warnings so the runner gap stays visible without conflating it
 * with linkage.
 *
 * The scan universe: every *.test.js under the slack-agents root,
 * every *.test.mjs under the framework root's tests/, and every
 * *.feature under the slack-agents root. Paths in the report are
 * relative to their own root (slack-agents refs already are).
 *
 * CLI: node linkageLint.js <registry.json> <slack-agents-dir> [framework-root]
 *      Prints the JSON report; exit 0 = no errors, 1 = errors found.
 */

const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

function lintLinkage({ registryPath, scanRoot, frameworkRoot }) {
  scanRoot = path.resolve(scanRoot);
  frameworkRoot = frameworkRoot ? path.resolve(frameworkRoot) : null;
  const errors = [];
  const warnings = [];

  // ── collect the files present ──────────────────────────────────
  const saFiles = walk(scanRoot);
  const testFiles = []; // { abs, path, in_testmatch|null }
  const featureFiles = []; // { abs, path }
  for (const abs of saFiles) {
    if (abs.endsWith('.test.js')) {
      const r = rel(scanRoot, abs);
      testFiles.push({ abs, path: r, in_testmatch: r.split('/').includes('tests') });
    } else if (abs.endsWith('.feature')) {
      featureFiles.push({ abs, path: rel(scanRoot, abs) });
    }
  }
  if (frameworkRoot) {
    for (const abs of walk(path.join(frameworkRoot, 'tests'))) {
      if (/\.test\.(mjs|js)$/.test(abs)) {
        testFiles.push({ abs, path: rel(frameworkRoot, abs), in_testmatch: null });
      }
    }
  }

  // ── gather links ───────────────────────────────────────────────
  const links = new Map(); // abs -> Set(source)
  const addLink = (abs, source) => {
    if (!links.has(abs)) links.set(abs, new Set());
    links.get(abs).add(source);
  };

  let stories = [];
  try {
    const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    stories = Array.isArray(data) ? data : (data.stories || []);
  } catch (e) {
    errors.push({ kind: 'unreadable-registry', message: `cannot parse ${registryPath}: ${e.message}` });
  }
  for (const story of stories) {
    for (const field of ['bdd_tests', 'tdd_tests']) {
      if (!Array.isArray(story[field])) continue;
      for (const ref of story[field]) {
        if (typeof ref !== 'string') continue;
        const abs = path.join(scanRoot, ref);
        if (!fs.existsSync(abs)) {
          errors.push({ kind: 'dangling-reference', story: story.id, field, ref, path: ref, message: `${story.id}: ${field} references a missing file: ${ref}` });
        } else addLink(abs, `registry:${story.id}`);
      }
    }
  }

  for (const f of featureFiles) {
    let content = '';
    try { content = fs.readFileSync(f.abs, 'utf8'); } catch { /* unreadable feature links nothing */ }
    const m = content.match(/\(Acceptance suite:\s*([^)]+)\)/);
    if (m) {
      const ref = m[1].trim();
      const abs = path.join(scanRoot, ref);
      if (!fs.existsSync(abs)) {
        errors.push({ kind: 'dangling-reference', story: f.path, field: 'acceptance-suite', ref, path: ref, message: `${f.path}: acceptance suite references a missing file: ${ref}` });
      } else addLink(abs, `feature:${f.path}`);
    }
  }

  if (frameworkRoot) {
    const storiesDir = path.join(frameworkRoot, 'stories');
    for (const abs of walk(storiesDir)) {
      if (!abs.endsWith('.md')) continue;
      let content = '';
      try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      const tokens = content.match(/[\w./-]+\.test\.(?:mjs|js)/g) || [];
      for (const token of tokens) {
        for (const base of [frameworkRoot, scanRoot]) {
          const candidate = path.join(base, token);
          if (fs.existsSync(candidate)) addLink(candidate, `story-doc:${path.basename(abs)}`);
        }
      }
    }
  }

  // ── classify ───────────────────────────────────────────────────
  const linkedBy = (abs) => [...(links.get(abs) || [])].sort();
  const tests = testFiles
    .map(f => ({ path: f.path, in_testmatch: f.in_testmatch, linked_by: linkedBy(f.abs) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const features = featureFiles
    .map(f => ({ path: f.path, linked_by: linkedBy(f.abs) }))
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const t of tests) {
    if (t.linked_by.length === 0) {
      errors.push({ kind: 'unlinked-test-file', path: t.path, message: `${t.path}: no story, feature, or story document references this test file` });
    }
    if (t.in_testmatch === false) {
      warnings.push({ kind: 'test-outside-testmatch', path: t.path, message: `${t.path}: outside jest testMatch (**/tests/**/*.test.js) — the runner never picks it up` });
    }
  }
  for (const f of features) {
    if (f.linked_by.length === 0) {
      errors.push({ kind: 'unlinked-feature-file', path: f.path, message: `${f.path}: no story references this feature file` });
    }
  }

  const summary = {
    test_files: tests.length,
    linked_tests: tests.filter(t => t.linked_by.length > 0).length,
    unlinked_tests: tests.filter(t => t.linked_by.length === 0).length,
    outside_testmatch: tests.filter(t => t.in_testmatch === false).length,
    feature_files: features.length,
    linked_features: features.filter(f => f.linked_by.length > 0).length,
    unlinked_features: features.filter(f => f.linked_by.length === 0).length,
    dangling_references: errors.filter(e => e.kind === 'dangling-reference').length,
  };

  return {
    registry: registryPath,
    scan_root: scanRoot,
    framework_root: frameworkRoot,
    files: { tests, features },
    summary,
    errors,
    warnings,
  };
}

if (require.main === module) {
  const [registryPath, scanRoot, frameworkRoot] = process.argv.slice(2);
  if (!registryPath || !scanRoot) {
    console.error('Usage: node linkageLint.js <registry.json> <slack-agents-dir> [framework-root]');
    process.exit(2);
  }
  const report = lintLinkage({ registryPath, scanRoot, frameworkRoot });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.errors.length > 0 ? 1 : 0);
}

module.exports = { lintLinkage };
