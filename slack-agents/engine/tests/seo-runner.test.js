'use strict';
/* Tests for engine/seoRunner.js (CEO Build S3; fix loop Build S4).
 * End-to-end run() is exercised with an injected fetch AND an injected
 * Vikunja client — helper-only tests missed the outcome-audit assembly
 * bug, so the full path is pinned here. The fake vik keeps every test
 * hermetic: no test may create real board tasks. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../seoRunner');

const HEALTHY = `<html><head>
<title>Stay N Alive — Social Media Consulting</title>
<meta name="description" content="Social media consulting and AI strategy for growing brands, from a Facebook platform pioneer and author of thirteen books on audience building.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="https://staynalive.com/">
<meta property="og:title" content="Stay N Alive">
<meta property="og:description" content="Consulting">
</head><body><h1>Welcome</h1><p>x</p></body></html>`;

const BROKEN = `<html><head><title>Short</title></head>
<body><h1>One</h1><h1>Two</h1></body></html>`;

const NO_CHANGE_LANG = /\b(changed|updated|published|deployed|edited|modified|applied|fixed|went live|now live|is live|rolled out)\b/i;

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'seo-')); }

function fixtureFetch(map) {
  return async (url) => map[url] || { status: 404, body: '' };
}
function fullMap(overrides = {}) {
  const m = {};
  for (const p of S.PAGES) m[p] = { status: 200, body: HEALTHY };
  m['https://staynalive.com/robots.txt'] = { status: 200, body: 'User-agent: *' };
  m['https://staynalive.com/sitemap.xml'] = { status: 200, body: '<urlset/>' };
  m['https://jessestay.com/robots.txt'] = { status: 200, body: 'User-agent: *' };
  m['https://jessestay.com/sitemap.xml'] = { status: 200, body: '<urlset/>' };
  return Object.assign(m, overrides);
}

/* In-memory Vikunja stand-in: tasks, comments, updates all inspectable. */
function fakeVik() {
  const tasks = new Map();
  let nextId = 1000;
  const comments = [];
  const updates = [];
  tasks.set(S.SEO_TICKET_ID, { id: S.SEO_TICKET_ID, project_id: 2, done: false, title: 'findings' });
  return {
    tasks, comments, updates,
    async getTask(id) { const t = tasks.get(id); if (!t) throw new Error(`no task ${id}`); return { ...t }; },
    async createTask(projectId, body) { const t = { id: ++nextId, project_id: projectId, done: false, ...body }; tasks.set(t.id, t); return { ...t }; },
    async updateTask(id, patch) { updates.push({ id, patch }); const t = tasks.get(id); if (t) Object.assign(t, patch); return t ? { ...t } : null; },
    async comment(id, text) { comments.push({ id, text }); return { id: comments.length }; },
  };
}
function readState(st) { return JSON.parse(fs.readFileSync(path.join(st, 'seo-runner.json'), 'utf8')); }
function readChanges(sb) {
  const f = path.join(sb, 'seo', 'changes.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('analyzePage', () => {
  test('healthy page passes every check', () => {
    const checks = S.analyzePage('https://staynalive.com/', 200, HEALTHY);
    expect(checks.every(c => c.ok)).toBe(true);
  });
  test('broken page flags title, description, h1, canonical, og, viewport', () => {
    const bad = S.analyzePage('https://jessestay.com/', 200, BROKEN).filter(c => !c.ok).map(c => c.key);
    expect(bad).toEqual(expect.arrayContaining(['title', 'meta-description', 'single-h1', 'canonical', 'og-tags', 'viewport']));
  });
  test('non-200 short-circuits to the status defect only', () => {
    const checks = S.analyzePage('https://staynalive.com/', 500, '');
    expect(checks.length).toBe(1);
    expect(checks[0].ok).toBe(false);
  });
});

describe('run (end-to-end, injected fetch)', () => {
  test('writes evidence, posts findings once, stays silent while the defect set is unchanged', async () => {
    const sb = tmpDir(), st = tmpDir();
    const posts = [];
    const fetchFn = fixtureFetch(fullMap({ 'https://jessestay.com/canvabook': { status: 200, body: BROKEN } }));
    const postFn = async (t) => { posts.push(t); return {}; };
    const r1 = await S.run({ sandbox: sb, state: st, fetchFn, postFn, vik: fakeVik() });
    expect(r1.defectCount).toBeGreaterThan(0);
    expect(r1.commented).toBe(true);
    expect(posts.length).toBe(1);
    // findings text must never use change language (audit integrity)
    expect(posts[0]).not.toMatch(NO_CHANGE_LANG);
    expect(fs.existsSync(path.join(sb, 'seo', 'latest-audit.json'))).toBe(true);
    const r2 = await S.run({ sandbox: sb, state: st, fetchFn, postFn, vik: fakeVik() });
    expect(r2.commented).toBe(false);
    expect(posts.length).toBe(1);
  });
  test('all-healthy run reports zero defects', async () => {
    const sb = tmpDir(), st = tmpDir();
    const r = await S.run({ sandbox: sb, state: st, fetchFn: fixtureFetch(fullMap()), postFn: async () => ({}), vik: fakeVik() });
    expect(r.defectCount).toBe(0);
  });
});

describe('postFindingsComment — Vikunja verb', () => {
  test('creates the comment with PUT (POST is a 405 on this API)', async () => {
    const calls = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => ({ id: 1 }) }; };
    try {
      await S.postFindingsComment('findings text', 'tok');
    } finally { global.fetch = realFetch; }
    expect(calls.length).toBe(1);
    expect(calls[0].opts.method).toBe('PUT');
    expect(calls[0].url).toContain('/tasks/846/comments');
  });
});

describe('recordChange — the shipped-change ledger', () => {
  test('refuses non-property URLs and empty descriptions', () => {
    const sb = tmpDir();
    expect(() => S.recordChange(sb, { url: 'https://example.com/x', description: 'did a thing' })).toThrow(/staynalive\.com or jessestay\.com/);
    expect(() => S.recordChange(sb, { url: 'https://staynalive.com/x', description: ' ' })).toThrow(/description/);
  });
  test('records a valid change', () => {
    const sb = tmpDir();
    const e = S.recordChange(sb, { url: 'https://staynalive.com/', description: 'Meta description rewritten', approvedBy: 'Jesse' });
    expect(e.url).toBe('https://staynalive.com/');
    const lines = fs.readFileSync(path.join(sb, 'seo', 'changes.jsonl'), 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
  });
});

/* ---------------- Build S4: the fix loop ---------------- */

describe('classifyDefect (S4)', () => {
  test('http-200 and site-file 200 failures are availability; everything else is content', () => {
    expect(S.classifyDefect({ page: 'https://staynalive.com/', key: 'http-200' })).toBe('availability');
    expect(S.classifyDefect({ page: 'https://staynalive.com/robots.txt', key: 'robots.txt-200' })).toBe('availability');
    expect(S.classifyDefect({ page: 'https://staynalive.com/sitemap.xml', key: 'sitemap.xml-200' })).toBe('availability');
    expect(S.classifyDefect({ page: 'https://staynalive.com/', key: 'single-h1' })).toBe('content');
    expect(S.classifyDefect({ page: 'https://jessestay.com/canvabook', key: 'meta-description' })).toBe('content');
    expect(S.classifyDefect({ page: 'https://jessestay.com/', key: 'canonical' })).toBe('content');
  });
});

describe('fix-task routing (S4)', () => {
  test('content defects create exactly one [SEO FIX] task for the CTO, tracked in state, never duplicated on re-run', async () => {
    const sb = tmpDir(), st = tmpDir();
    const vik = fakeVik();
    const fetchFn = fixtureFetch(fullMap({ 'https://jessestay.com/canvabook': { status: 200, body: BROKEN } }));
    const postFn = async () => ({});
    const r1 = await S.run({ sandbox: sb, state: st, fetchFn, postFn, vik });
    expect(r1.fixErrors).toEqual([]);
    expect(r1.fixTasksCreated.length).toBe(1);
    const created = r1.fixTasksCreated[0];
    expect(created.class).toBe('content');
    expect(created.title).toMatch(/^\[SEO FIX\] 6 content defects — https:\/\/jessestay\.com$/);
    const task = vik.tasks.get(created.taskId);
    expect(task.project_id).toBe(2);
    expect(task.description).toMatch(/Acceptance criterion: a re-audit shows each listed defect resolved/);
    expect(task.description).toMatch(/single-h1/);
    // assigned to the CTO (user 9) via a task update
    const assign = vik.updates.find(u => u.id === created.taskId && u.patch.assignees);
    expect(assign.patch.assignees).toEqual([{ id: S.CTO_USER_ID }]);
    expect(S.CTO_USER_ID).toBe(9);
    // tracked in state with the covered defect keys
    const state = readState(st);
    expect(state.fixTasks.content.length).toBe(1);
    expect(state.fixTasks.content[0].taskId).toBe(created.taskId);
    expect(state.fixTasks.content[0].defectKeys.length).toBe(6);
    // re-run with the same defects: no duplicate task
    const r2 = await S.run({ sandbox: sb, state: st, fetchFn, postFn, vik });
    expect(r2.fixTasksCreated.length).toBe(0);
    expect([...vik.tasks.values()].filter(t => t.title && t.title.startsWith('[SEO FIX]')).length).toBe(1);
  });

  test('all-404 state routes exactly one availability task, no content task, no ledger entries', async () => {
    const sb = tmpDir(), st = tmpDir();
    const vik = fakeVik();
    const r = await S.run({ sandbox: sb, state: st, fetchFn: fixtureFetch({}), postFn: async () => ({}), vik });
    expect(r.fixErrors).toEqual([]);
    expect(r.fixTasksCreated.length).toBe(1);
    expect(r.fixTasksCreated[0].class).toBe('availability');
    expect(r.fixTasksCreated[0].title).toMatch(/^\[SEO AVAILABILITY\] sites unreachable — /);
    const task = vik.tasks.get(r.fixTasksCreated[0].taskId);
    expect(task.description).toMatch(/HTTP status 404/);
    expect(task.description).toMatch(/hosting\/billing-class/);
    expect(task.description).toMatch(/Do NOT pay anything/);
    expect(readChanges(sb)).toEqual([]);
  });

  test('a tracked task closed externally while defects persist routes a fresh task', async () => {
    const sb = tmpDir(), st = tmpDir();
    const vik = fakeVik();
    const fetchFn = fixtureFetch(fullMap({ 'https://jessestay.com/canvabook': { status: 200, body: BROKEN } }));
    const postFn = async () => ({});
    const r1 = await S.run({ sandbox: sb, state: st, fetchFn, postFn, vik });
    const firstId = r1.fixTasksCreated[0].taskId;
    vik.tasks.get(firstId).done = true; // someone closed it by hand
    const r2 = await S.run({ sandbox: sb, state: st, fetchFn, postFn, vik });
    expect(r2.fixTasksCreated.length).toBe(1);
    expect(r2.fixTasksCreated[0].taskId).not.toBe(firstId);
    expect(readState(st).fixTasks.content[0].taskId).toBe(r2.fixTasksCreated[0].taskId);
  });
});

describe('resolution verification (S4)', () => {
  test('resolved content defects are recorded in changes.jsonl, commented on the fix task, and close it', async () => {
    const sb = tmpDir(), st = tmpDir();
    const vik = fakeVik();
    const posts = [];
    const postFn = async (t) => { posts.push(t); return {}; };
    const brokenFetch = fixtureFetch(fullMap({ 'https://jessestay.com/canvabook': { status: 200, body: BROKEN } }));
    const r1 = await S.run({ sandbox: sb, state: st, fetchFn: brokenFetch, postFn, vik });
    const fixId = r1.fixTasksCreated[0].taskId;
    const r2 = await S.run({ sandbox: sb, state: st, fetchFn: fixtureFetch(fullMap()), postFn, vik });
    expect(r2.fixErrors).toEqual([]);
    expect(r2.defectCount).toBe(0);
    expect(r2.resolutionsRecorded).toBe(6);
    const changes = readChanges(sb);
    expect(changes.length).toBe(6);
    expect(changes.every(c => c.url === 'https://jessestay.com/canvabook')).toBe(true);
    expect(changes.map(c => c.description).join(' ')).toMatch(/H1 element present after fix/);
    // resolution comment landed on the FIX task, not on #846
    const rc = vik.comments.find(c => c.id === fixId);
    expect(rc).toBeTruthy();
    expect(rc.text).toMatch(/resolution verified/);
    expect(vik.comments.some(c => c.id === S.SEO_TICKET_ID)).toBe(false);
    // fix task closed and untracked
    expect(vik.tasks.get(fixId).done).toBe(true);
    expect(r2.fixTasksClosed).toContain(fixId);
    expect(readState(st).fixTasks.content).toEqual([]);
    // every #846 findings post across both runs stays free of change language
    for (const p of posts) expect(p).not.toMatch(NO_CHANGE_LANG);
  });

  test('availability resolution closes the task but writes nothing to changes.jsonl', async () => {
    const sb = tmpDir(), st = tmpDir();
    const vik = fakeVik();
    const postFn = async () => ({});
    const r1 = await S.run({ sandbox: sb, state: st, fetchFn: fixtureFetch({}), postFn, vik });
    const availId = r1.fixTasksCreated[0].taskId;
    const r2 = await S.run({ sandbox: sb, state: st, fetchFn: fixtureFetch(fullMap()), postFn, vik });
    expect(r2.fixErrors).toEqual([]);
    expect(r2.fixTasksClosed).toContain(availId);
    expect(vik.tasks.get(availId).done).toBe(true);
    expect(vik.comments.some(c => c.id === availId && /answering again on re-audit/.test(c.text))).toBe(true);
    expect(r2.resolutionsRecorded).toBe(0);
    expect(readChanges(sb)).toEqual([]);
  });

  test('a page going dark does not fake content resolutions', async () => {
    const sb = tmpDir(), st = tmpDir();
    const vik = fakeVik();
    const postFn = async () => ({});
    const brokenFetch = fixtureFetch(fullMap({ 'https://jessestay.com/canvabook': { status: 200, body: BROKEN } }));
    const r1 = await S.run({ sandbox: sb, state: st, fetchFn: brokenFetch, postFn, vik });
    const fixId = r1.fixTasksCreated[0].taskId;
    // canvabook now 404s: its content defects vanish without ever passing
    const darkFetch = fixtureFetch(fullMap({ 'https://jessestay.com/canvabook': { status: 404, body: '' } }));
    const r2 = await S.run({ sandbox: sb, state: st, fetchFn: darkFetch, postFn, vik });
    expect(r2.resolutionsRecorded).toBe(0);
    expect(readChanges(sb)).toEqual([]);
    expect(vik.tasks.get(fixId).done).toBe(false);
    expect(readState(st).fixTasks.content[0].defectKeys.length).toBe(6);
  });
});

/* ---------------- Build S5: description survival + directive routing ---------------- */

describe('makeVikClient against Vikunja POST-replace semantics (S5 regression)', () => {
  /* Minimal Vikunja stand-in with the API's REAL update semantics, proven
   * against the live API on 2026-11-11: POST /tasks/{id} resets writable
   * fields absent from the body — an assignees-only POST turned a fresh
   * task's description into "". The pre-S5 fake vik merged patches
   * (Object.assign), which is exactly why the suite passed while #921 sat
   * in production with an empty description. */
  function fakeVikunjaFetch() {
    const tasks = new Map();
    let nextId = 5000;
    const api = async (url, opts = {}) => {
      const respond = (status, obj) => ({ ok: status < 300, status, text: async () => (obj ? JSON.stringify(obj) : '') });
      const m = String(url);
      const body = opts.body ? JSON.parse(opts.body) : {};
      if (opts.method === 'PUT' && /\/projects\/\d+\/tasks$/.test(m)) {
        const t = { id: ++nextId, project_id: 2, done: false, ...body };
        tasks.set(t.id, t);
        return respond(201, { ...t });
      }
      const tm = m.match(/\/tasks\/(\d+)$/);
      if (tm && opts.method === 'GET') {
        const t = tasks.get(+tm[1]);
        return t ? respond(200, { ...t }) : respond(404, { message: 'not found' });
      }
      if (tm && opts.method === 'POST') {
        const t = tasks.get(+tm[1]);
        if (!t) return respond(404, { message: 'not found' });
        const updated = { ...t, ...body };
        if (!('description' in body)) updated.description = ''; // the observed wipe
        tasks.set(t.id, updated);
        return respond(200, { ...updated });
      }
      return respond(404, { message: 'unrouted' });
    };
    api.tasks = tasks;
    return api;
  }

  test('createTask stores the description, and neither the assign nor the close update wipes it', async () => {
    const realFetch = global.fetch;
    global.fetch = fakeVikunjaFetch();
    try {
      const vik = S.makeVikClient('tok');
      const body = S.fixTaskBody('content', [{ page: 'https://jessestay.com/canvabook', key: 'single-h1', detail: '0 <h1> element(s)' }], '2026-11-11');
      const task = await vik.createTask(2, body);
      expect(task.description).toMatch(/single-h1/);
      await vik.updateTask(task.id, { assignees: [{ id: S.CTO_USER_ID }] });
      let live = await vik.getTask(task.id);
      expect(live.description).toMatch(/single-h1/);
      expect(live.assignees).toEqual([{ id: S.CTO_USER_ID }]);
      await vik.updateTask(task.id, { done: true });
      live = await vik.getTask(task.id);
      expect(live.done).toBe(true);
      expect(live.description).toMatch(/single-h1/);
    } finally { global.fetch = realFetch; }
  });
});

describe('fixTaskBody evidence (S5)', () => {
  test('content body carries the verbatim defect lines and the audit evidence files', () => {
    const b = S.fixTaskBody('content', [{ page: 'https://jessestay.com/canvabook', key: 'canonical', detail: 'no canonical link' }], '2026-11-11');
    expect(b.description).toContain('- https://jessestay.com/canvabook — canonical: no canonical link');
    expect(b.description).toMatch(/seo\/latest-audit\.json/);
    expect(b.description).toMatch(/seo\/audit-2026-11-11\.md/);
  });
});

describe('directive routing (S5)', () => {
  test('a new fix task fires exactly one CEO directive to the CTO; a covered re-run fires none', async () => {
    const sb = tmpDir(), st = tmpDir();
    const vik = fakeVik();
    const directives = [];
    const directiveFn = async (t) => { directives.push(t); return {}; };
    const fetchFn = fixtureFetch(fullMap({ 'https://jessestay.com/canvabook': { status: 200, body: BROKEN } }));
    const postFn = async () => ({});
    const r1 = await S.run({ sandbox: sb, state: st, fetchFn, postFn, vik, directiveFn });
    expect(r1.fixErrors).toEqual([]);
    expect(r1.fixTasksCreated.length).toBe(1);
    expect(directives.length).toBe(1);
    const id = r1.fixTasksCreated[0].taskId;
    expect(directives[0]).toMatch(new RegExp(`^\\[from: CEO → CTO\\] SEO FIX task #${id} `));
    expect(directives[0]).toContain('single-h1');
    expect(directives[0].length).toBeLessThan(3900);
    expect(r1.fixDirectivesPosted).toEqual([{ taskId: id, class: 'content' }]);
    const r2 = await S.run({ sandbox: sb, state: st, fetchFn, postFn, vik, directiveFn });
    expect(r2.fixTasksCreated.length).toBe(0);
    expect(directives.length).toBe(1);
    expect(r2.fixDirectivesPosted).toEqual([]);
  });

  test('an injected-vik run with no directiveFn posts nothing (hermetic by default)', async () => {
    const sb = tmpDir(), st = tmpDir();
    const vik = fakeVik();
    const fetchFn = fixtureFetch(fullMap({ 'https://jessestay.com/canvabook': { status: 200, body: BROKEN } }));
    const r = await S.run({ sandbox: sb, state: st, fetchFn, postFn: async () => ({}), vik });
    expect(r.fixTasksCreated.length).toBe(1);
    expect(r.fixDirectivesPosted).toEqual([]);
    expect(r.fixErrors).toEqual([]);
  });

  test('a failing directive post is recorded as a fix error but the task stays created and tracked', async () => {
    const sb = tmpDir(), st = tmpDir();
    const vik = fakeVik();
    const directiveFn = async () => { throw new Error('slack down'); };
    const fetchFn = fixtureFetch(fullMap({ 'https://jessestay.com/canvabook': { status: 200, body: BROKEN } }));
    const r = await S.run({ sandbox: sb, state: st, fetchFn, postFn: async () => ({}), vik, directiveFn });
    expect(r.fixTasksCreated.length).toBe(1);
    expect(r.fixErrors.join(' ')).toMatch(/directive for task/);
    expect(readState(st).fixTasks.content.length).toBe(1);
  });

  test('buildFixDirective truncates long defect lists under the directive cap', () => {
    const defects = Array.from({ length: 80 }, (_, i) => ({ page: 'https://jessestay.com/canvabook', key: `check-${i}`, detail: 'x'.repeat(60) }));
    const text = S.buildFixDirective({ taskId: 42, cls: 'content', defects, day: '2026-11-11' });
    expect(text.length).toBeLessThan(3900);
    expect(text).toMatch(/more defect\(s\)/);
    expect(text).toContain('#42');
    expect(text.startsWith('[from: CEO → CTO]')).toBe(true);
  });
});
