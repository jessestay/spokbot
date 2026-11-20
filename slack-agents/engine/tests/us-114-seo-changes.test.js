'use strict';
/**
 * US-114 — SEO recommendations turned into changed pages.
 *
 * Story: As Jesse, I want SEO recommendations turned into changed
 * pages on staynalive.com, so that SEO counts as action, not just
 * knowledge.
 * AC1: Given an approved SEO change, When the runner executes it,
 * Then the page content differs at its URL, the change verifies on
 * re-audit, and the change is recorded on its ticket with the URL.
 *
 * The framework component is engine/seoRunner.js. Its deterministic
 * core is what this suite proves:
 *   - analyzePage() is the audit AND the re-audit: the same checks
 *     that flag a defect must pass on the changed page, or the fix
 *     loop records no resolution.
 *   - classifyDefect() routes availability vs content defects.
 *   - recordChange() is the ONLY path that records a shipped change
 *     (seo/changes.jsonl, the ledger the outcome audit counts); it
 *     refuses off-property URLs and undescribed changes, so an
 *     unapproved or unverifiable "change" can never be recorded.
 * The live fetch + Vikunja fix-task loop around this core is
 * covered by the pre-existing engine/tests/seo-runner.test.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyzePage, classifyDefect, recordChange, changeDescription } = require('../seoRunner');

const URL_ = 'https://staynalive.com/canvabook';

const BROKEN = '<html><head><title>Canva For Dummies — the book by Jesse Stay</title></head>'
  + '<body><h1>One</h1><h1>Two</h1><p>no meta description, no canonical, no og, no viewport</p></body></html>';

const FIXED = '<html><head>'
  + '<title>Canva For Dummies — the book by Jesse Stay</title>'
  + '<meta name="description" content="The official companion hub for Canva For Dummies by Jesse Stay: chapter updates, templates, and course links.">'
  + '<link rel="canonical" href="https://staynalive.com/canvabook">'
  + '<meta property="og:title" content="Canva For Dummies">'
  + '<meta property="og:description" content="Chapter updates and templates for Canva For Dummies.">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1">'
  + '</head><body><h1>Canva For Dummies</h1><p>content</p></body></html>';

function defectsOf(checks) { return checks.filter(c => !c.ok); }

describe('US-114 SEO changes — audit and re-audit are the same checks', () => {
  test('the audit flags the broken page: multiple H1s and a missing meta description are defects', () => {
    const defects = defectsOf(analyzePage(URL_, 200, BROKEN));
    expect(defects.map(d => d.key)).toEqual(
      expect.arrayContaining(['single-h1', 'meta-description', 'canonical', 'og-tags', 'viewport']));
    for (const d of defects) expect(d.page).toBe(URL_);
  });

  test('after the approved change ships, the re-audit passes every check on the changed page', () => {
    expect(defectsOf(analyzePage(URL_, 200, FIXED))).toEqual([]);
  });

  test('a page that stops answering is an availability defect, not a content fix', () => {
    const checks = analyzePage(URL_, 503, '');
    expect(defectsOf(checks).map(d => d.key)).toEqual(['http-200']);
    expect(classifyDefect({ key: 'http-200' })).toBe('availability');
    expect(classifyDefect({ key: 'single-h1' })).toBe('content');
    expect(changeDescription('single-h1')).toMatch(/verified by SEO runner re-audit/);
  });
});

describe('US-114 SEO changes — the changes ledger is the only record that counts', () => {
  let sandbox;
  beforeEach(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'macf-us114-')); });

  test('an approved change is recorded with its URL, description, and approver', () => {
    const entry = recordChange(sandbox, {
      url: URL_, description: 'Added the missing meta description', approvedBy: 'Jesse',
    });
    expect(entry).toMatchObject({ url: URL_, description: 'Added the missing meta description', approvedBy: 'Jesse' });
    const lines = fs.readFileSync(path.join(sandbox, 'seo', 'changes.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ url: URL_, approvedBy: 'Jesse' });
  });

  test('an off-property URL is rejected and records nothing', () => {
    expect(() => recordChange(sandbox, { url: 'https://example.com/x', description: 'nope' }))
      .toThrow(/must be a staynalive\.com or jessestay\.com page URL/);
    expect(fs.existsSync(path.join(sandbox, 'seo', 'changes.jsonl'))).toBe(false);
  });

  test('a change with no description is rejected and records nothing', () => {
    expect(() => recordChange(sandbox, { url: URL_, description: '  ' }))
      .toThrow(/description of the shipped change is required/);
    expect(fs.existsSync(path.join(sandbox, 'seo', 'changes.jsonl'))).toBe(false);
  });
});
