#!/usr/bin/env node
/**
 * Spokbot story-registry lint (US-FW-003) — the F12 evidence of record.
 *
 * Parses engine/.user-stories.json with a real JSON parser and reports,
 * per story: field types, acceptance-criteria count, BDD/TDD reference
 * counts, dangling references, and status. Deterministic: the same
 * registry always produces the same report, so F12 verdicts can be
 * diffed run to run instead of re-derived from prose readings.
 *
 * Why this exists: the registry's list fields (acceptance_criteria,
 * bdd_tests, tdd_tests) are proper JSON arrays, but readings taken
 * through text renderings twice misreported them — once as "stored as
 * stringified lists" (Phase 1 Step 1 inventory) and once as "all
 * empty" for a range that was only mostly empty (early verification
 * runs). A stringified field, when it is ever real, is reported here
 * as an explicit `stringified-field` error — never silently counted.
 *
 * Errors (exit 1): stringified-field, dangling-reference,
 * missing-criteria, criterion-format, invalid-points, title-format,
 * missing-field, invalid-type, unreadable-registry.
 * Warnings (exit stays 0): no-tests / no-bdd / no-tdd coverage gaps,
 * and stale-in-progress lifecycle debt (US-FW-006): an in-progress
 * story whose BDD+TDD evidence is complete and resolving.
 *
 * References resolve relative to the directory that contains the
 * registry's engine/ directory (i.e. the slack-agents/ root), unless
 * opts.resolveRoot overrides it.
 *
 * CLI: node storyLint.js <path-to-.user-stories.json>
 *      Prints the JSON report; exit 0 = no errors, 1 = errors found.
 */

const fs = require('fs');
const path = require('path');

const LIST_FIELDS = ['acceptance_criteria', 'bdd_tests', 'tdd_tests'];
const FIBONACCI = [1, 2, 3, 5, 8, 13, 21];
const TITLE_RE = /^As (a|an|the|Jesse)\b/;
const CRITERION_PARTS = ['Given', 'When', 'Then'];

function fieldType(v) {
  if (Array.isArray(v)) return 'array';
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  return typeof v;
}

function lintStory(story, resolveRoot) {
  const errors = [];
  const warnings = [];
  const fieldTypes = {};
  const counts = { acceptance_criteria: 0, bdd_tests: 0, tdd_tests: 0 };

  for (const field of LIST_FIELDS) {
    const v = story[field];
    fieldTypes[field] = fieldType(v);
    if (typeof v === 'string') {
      errors.push({
        kind: 'stringified-field',
        field,
        message: `${story.id}: ${field} is a string, not a JSON array (stringified list)`,
      });
    } else if (Array.isArray(v)) {
      counts[field] = v.length;
      for (const el of v) {
        if (typeof el !== 'string') {
          errors.push({
            kind: 'invalid-type',
            field,
            message: `${story.id}: ${field} contains a non-string element`,
          });
        }
      }
    } else if (v !== undefined) {
      errors.push({
        kind: 'invalid-type',
        field,
        message: `${story.id}: ${field} must be an array of strings, got ${fieldTypes[field]}`,
      });
    } else {
      errors.push({
        kind: 'missing-field',
        field,
        message: `${story.id}: ${field} is missing`,
      });
    }
  }

  // Acceptance criteria: present and in Given/When/Then form.
  if (Array.isArray(story.acceptance_criteria)) {
    if (story.acceptance_criteria.length === 0) {
      errors.push({ kind: 'missing-criteria', message: `${story.id}: no acceptance criteria` });
    }
    for (const c of story.acceptance_criteria) {
      if (typeof c === 'string' && !CRITERION_PARTS.every(p => c.includes(p))) {
        errors.push({
          kind: 'criterion-format',
          message: `${story.id}: criterion is not in Given/When/Then form: ${c.slice(0, 80)}`,
        });
      }
    }
  }

  // Difficulty score.
  if (typeof story.story_points !== 'number' || !FIBONACCI.includes(story.story_points)) {
    errors.push({
      kind: 'invalid-points',
      message: `${story.id}: story_points must be a Fibonacci number (${FIBONACCI.join(', ')}), got ${JSON.stringify(story.story_points)}`,
    });
  }

  // Story-format title.
  if (typeof story.title !== 'string' || !TITLE_RE.test(story.title) || !story.title.includes('I want')) {
    errors.push({
      kind: 'title-format',
      message: `${story.id}: title is not in story format ("As a … , I want …"): ${String(story.title).slice(0, 80)}`,
    });
  }

  // Reference existence (only for real arrays of strings).
  for (const field of ['bdd_tests', 'tdd_tests']) {
    if (!Array.isArray(story[field])) continue;
    for (const ref of story[field]) {
      if (typeof ref !== 'string') continue;
      if (!fs.existsSync(path.join(resolveRoot, ref))) {
        errors.push({
          kind: 'dangling-reference',
          field,
          ref,
          message: `${story.id}: ${field} references a missing file: ${ref}`,
        });
      }
    }
  }

  // Coverage warnings (gaps are measured, not errors).
  const hasBdd = counts.bdd_tests > 0;
  const hasTdd = counts.tdd_tests > 0;
  if (!hasBdd && !hasTdd) warnings.push({ kind: 'no-tests', message: `${story.id}: no BDD or TDD references` });
  else if (!hasBdd) warnings.push({ kind: 'no-bdd', message: `${story.id}: no BDD references` });
  else if (!hasTdd) warnings.push({ kind: 'no-tdd', message: `${story.id}: no TDD references` });

  // Lifecycle warning (US-FW-006, F12 step A.3): a story still at
  // in-progress whose BDD+TDD evidence is complete and resolving has
  // nothing left but the lifecycle decision — a story may move to
  // done only when its referenced suites pass, and this lint cannot
  // run them, so it flags the review debt instead of declaring done.
  // Stories blocked on coverage or on dangling references already
  // carry that flag and are never double-flagged here.
  const hasDangling = errors.some(e => e.kind === 'dangling-reference');
  if (story.status === 'in-progress' && hasBdd && hasTdd && !hasDangling) {
    warnings.push({
      kind: 'stale-in-progress',
      message: `${story.id}: in-progress with complete BDD+TDD evidence — lifecycle review debt (advance to done when its suites pass, per the status rule)`,
    });
  }

  return {
    id: story.id,
    status: story.status ?? null,
    points: typeof story.story_points === 'number' ? story.story_points : null,
    ac_count: counts.acceptance_criteria,
    bdd_count: counts.bdd_tests,
    tdd_count: counts.tdd_tests,
    field_types: fieldTypes,
    errors,
    warnings,
  };
}

function lintStories(stories, resolveRoot) {
  const perStory = stories.map(s => lintStory(s, resolveRoot));
  const summary = {
    total: perStory.length,
    with_both: perStory.filter(s => s.bdd_count > 0 && s.tdd_count > 0).length,
    tdd_only: perStory.filter(s => s.bdd_count === 0 && s.tdd_count > 0).length,
    bdd_only: perStory.filter(s => s.bdd_count > 0 && s.tdd_count === 0).length,
    neither: perStory.filter(s => s.bdd_count === 0 && s.tdd_count === 0).length,
    dangling_references: perStory.reduce((n, s) => n + s.errors.filter(e => e.kind === 'dangling-reference').length, 0),
    stringified_fields: perStory.reduce((n, s) => n + s.errors.filter(e => e.kind === 'stringified-field').length, 0),
    by_status: perStory.reduce((acc, s) => { const k = s.status ?? 'missing'; acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
    stale_in_progress: perStory.filter(s => s.warnings.some(w => w.kind === 'stale-in-progress')).length,
  };
  const errors = perStory.flatMap(s => s.errors);
  const warnings = perStory.flatMap(s => s.warnings);
  return { stories: perStory, summary, errors, warnings };
}

function lintRegistry(registryPath, opts = {}) {
  // References like "engine/tests/x.test.js" are relative to the
  // slack-agents root = the parent of the registry's engine/ directory.
  const resolveRoot = opts.resolveRoot || path.dirname(path.dirname(path.resolve(registryPath)));
  let data;
  try {
    data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (e) {
    return {
      registry: registryPath,
      resolve_root: resolveRoot,
      stories: [],
      summary: { total: 0, with_both: 0, tdd_only: 0, bdd_only: 0, neither: 0, dangling_references: 0, stringified_fields: 0, by_status: {}, stale_in_progress: 0 },
      errors: [{ kind: 'unreadable-registry', message: `cannot parse ${registryPath}: ${e.message}` }],
      warnings: [],
    };
  }
  const stories = Array.isArray(data) ? data : (data.stories || []);
  const report = lintStories(stories, resolveRoot);
  return { registry: registryPath, resolve_root: resolveRoot, ...report };
}

if (require.main === module) {
  const registryPath = process.argv[2];
  if (!registryPath) {
    console.error('Usage: node storyLint.js <path-to-.user-stories.json>');
    process.exit(2);
  }
  const report = lintRegistry(registryPath);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.errors.length > 0 ? 1 : 0);
}

module.exports = { lintRegistry, lintStories, lintStory };
