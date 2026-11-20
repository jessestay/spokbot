'use strict';
/*
 * seoRunner.js — deterministic SEO/AIO Repeat core (CEO Build S3, Oct 26, 2026;
 * fix loop added as Build S4, Oct 28, 2026).
 *
 * Story #899 (SEO/AIO Repeat, Neil Patel lens) was launch-gated with zero
 * output: nothing ever looked at the sites. This runner is the Repeat's
 * deterministic core, in the financeCheck/jobPipeline pattern:
 *
 *   - Fetches the public pages of Jesse's two SEO properties
 *     (staynalive.com, jessestay.com incl. the /canvabook hub) plus each
 *     origin's robots.txt and sitemap.xml, and runs checkable on-page tests:
 *     HTTP 200, title presence/length, meta description presence/length,
 *     exactly one H1, canonical link, Open Graph tags, viewport meta.
 *   - Writes evidence to the sandbox: seo/latest-audit.json and a dated
 *     seo/audit-<day>.md. Defects are keyed per page+check and deduplicated
 *     against .state/seo-runner.json: a findings comment lands on Vikunja
 *     task #846 ONLY when the defect set changes, so the board gets signal,
 *     not a daily repeat.
 *   - The findings comment NEVER uses change language. It is an audit, not a
 *     change: engine/outcomeAudit.js counts an SEO change only from a ticket
 *     comment carrying a site URL plus change language, or (for the scenario
 *     suite) an entry in seo/changes.jsonl written by recordChange() when an
 *     approved fix actually ships. Jesse's rule stands: no live-site change
 *     without his approval, so this runner observes and proposes only.
 *
 * Build S4 — the fix loop (Jesse, Oct 28, 2026: "I don't just want
 * knowledge. I want action."): findings now route to the CTO as tracked
 * work instead of sitting in a comment.
 *   - Defects are classified AVAILABILITY (http-200 / robots.txt-200 /
 *     sitemap.xml-200: the page or file did not answer 200) vs CONTENT
 *     (everything else: the page answered but its on-page SEO is off).
 *   - When defects exist that no open fix task covers, the runner creates
 *     ONE Vikunja fix task per class per run in #846's project, assigned to
 *     the CTO. Content tasks list the defects and the acceptance rule (a
 *     re-audit shows each resolved). Availability tasks describe a
 *     hosting/billing-class problem to diagnose and escalate to the CEO
 *     with the specific unblock needed — they never instruct payment.
 *     Created task ids + covered defect keys live in .state/seo-runner.json
 *     so re-runs never duplicate a task for the same defects. If a tracked
 *     task is found closed while its defects persist, its defects count as
 *     uncovered again and route into a fresh task.
 *   - Resolution verification: a defect from the previous audit that is
 *     absent now is RESOLVED — for content defects only when the check
 *     actually ran and passed this run (a page going dark must not fake a
 *     content resolution). Each resolved content defect is recorded via
 *     recordChange() into seo/changes.jsonl. Resolutions are commented on
 *     the covering FIX TASK (never on #846, whose findings text stays free
 *     of change language), and a fix task closes when every defect it
 *     covers is resolved. Availability resolutions are commented + closed
 *     the same way but are NEVER written to changes.jsonl — a site coming
 *     back is not an SEO change.
 *
 * Build S5 — dead-end routing fix (Nov 11, 2026; the 31-day F3 stall,
 * Vikunja #921): two breaks kept created fix tasks from ever being worked.
 *   - EMPTY DESCRIPTIONS: Vikunja's POST /tasks/{id} REPLACES the task —
 *     a writable field absent from the body is reset to its zero value.
 *     createTask's PUT stored the description, then the runner's very next
 *     call (an assignees-only POST) wiped it back to "". #921 sat for 31
 *     days as a bare title for this reason. updateTask below now merges
 *     the patch over the task's current writable state before POSTing,
 *     the same pattern utils/vikunja.js already used.
 *   - NO DIRECTIVE: a Vikunja assignment alone never reaches an agent —
 *     MACF agents execute Slack directives ([from: CEO → Agent] in a
 *     scanned channel). When (and only when) this loop creates a NEW fix
 *     task, it now also posts a directive to the task's owning seat (the
 *     CTO, the runner's assignee) via the ticket-triage mechanism, so the
 *     work actually lands in the agent's queue.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const PAGES = [
  'https://staynalive.com/',
  'https://jessestay.com/',
  'https://jessestay.com/canvabook',
];
const SEO_TICKET_ID = 846;
const CTO_USER_ID = 9;
const DIRECTIVE_CHANNEL = 'C0ASH4TF604'; // #management — one of directiveScan's DEFAULT_CHANNELS
const FIX_DIRECTIVE_AGENT = 'CTO'; // header name resolving to agent 'cto', the fix tasks' assignee seat
const MAX_DIRECTIVE_CHARS = 3900; // directive intake cap (MAX_DIRECTIVE_CHARS)
const FALLBACK_PROJECT_ID = 2; // verified Oct 28, 2026: task #846 lives in project 2
const AVAILABILITY_KEYS = new Set(['http-200', 'robots.txt-200', 'sitemap.xml-200']);

function sandboxDir() {
  if (process.env.MACF_SANDBOX_DIR) return process.env.MACF_SANDBOX_DIR;
  return path.join(__dirname, '..', '..', 'engine-home', 'workspace', 'agent-sandbox');
}
function stateDir() {
  if (process.env.MACF_STATE_DIR) return process.env.MACF_STATE_DIR;
  return path.join(__dirname, '..', '.state');
}
function readEnvToken(name, envPath = path.join(__dirname, '..', '.env')) {
  const txt = fs.readFileSync(envPath, 'utf8');
  const m = txt.match(new RegExp(`^${name}=(.+)$`, 'm'));
  if (!m) throw new Error(`${name} not found in slack-agents/.env`);
  return m[1].trim();
}
function denverDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(d);
}
function defectKeyOf(d) { return `${d.page}|${d.key}`; }

/* ---------- defect classification (Build S4) ---------- */
function classifyDefect(d) {
  return AVAILABILITY_KEYS.has(d.key) ? 'availability' : 'content';
}
const KEY_DESCRIPTIONS = {
  'title': 'Title tag present and within length guidance',
  'meta-description': 'Meta description present and within length guidance',
  'single-h1': 'Exactly one H1 element present',
  'canonical': 'Canonical link present',
  'og-tags': 'Open Graph title and description tags present',
  'viewport': 'Viewport meta present',
};
function changeDescription(key) {
  const what = KEY_DESCRIPTIONS[key] || `${key} check passing`;
  return `${what} after fix (verified by SEO runner re-audit)`;
}

/* ---------- pure page analysis (fixture-tested) ---------- */
function getMeta(html, name, attr = 'name') {
  const re = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*>`, 'i');
  const tag = html.match(re);
  if (!tag) return null;
  const c = tag[0].match(/content=["']([^"']*)["']/i);
  return c ? c[1] : null;
}
function analyzePage(pageUrl, status, html) {
  const checks = [];
  const add = (key, ok, detail) => checks.push({ page: pageUrl, key, ok, detail });
  add('http-200', status === 200, `HTTP status ${status}`);
  if (status !== 200 || !html) return checks;
  const titleM = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleM ? titleM[1].trim() : '';
  add('title', !!title && title.length >= 10 && title.length <= 70,
    title ? `title ${title.length} chars: "${title.slice(0, 80)}"` : 'no <title> found');
  const desc = getMeta(html, 'description');
  add('meta-description', !!desc && desc.length >= 50 && desc.length <= 170,
    desc ? `description ${desc.length} chars` : 'no meta description found');
  const h1s = (html.match(/<h1[\s>]/gi) || []).length;
  add('single-h1', h1s === 1, `${h1s} <h1> element(s)`);
  const canon = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i);
  add('canonical', !!canon, canon ? 'canonical link present' : 'no canonical link');
  const ogT = getMeta(html, 'og:title', 'property');
  const ogD = getMeta(html, 'og:description', 'property');
  add('og-tags', !!ogT && !!ogD, `og:title ${ogT ? 'present' : 'missing'}, og:description ${ogD ? 'present' : 'missing'}`);
  add('viewport', !!getMeta(html, 'viewport'), getMeta(html, 'viewport') ? 'viewport meta present' : 'no viewport meta');
  return checks;
}
function analyzeSiteFile(origin, kind, status) {
  return [{ page: `${origin}/${kind}`, key: `${kind}-200`, ok: status === 200, detail: `${kind} HTTP status ${status}` }];
}

/* ---------- fetching ---------- */
function fetchUrl(url, redirects = 5) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    // family: 4 is load-bearing: macf-server's IPv6 path returns Flywheel 404s
    // for these hosts while IPv4 returns the real sites (root-caused Oct 28,
    // 2026 — curl -4 = 200, curl -6 = dead, default node fetch = 404). Without
    // it the runner audits a phantom outage and can never verify a fix.
    const req = lib.get(url, { headers: { 'User-Agent': 'MACF-SEORunner/1.0 (+staynalive.com)' }, timeout: 15000, family: 4 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, url).href, redirects - 1));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
  });
}

/* ---------- Vikunja client (findings comment + fix loop) ---------- */
const VIK_BASE = 'http://127.0.0.1:3456/api/v1';
async function vikRequest(token, method, p, body) {
  const res = await fetch(`${VIK_BASE}${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Vikunja ${method} ${p} failed: ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
// Vikunja's POST /tasks/{id} REPLACES the task: a writable field absent
// from the body is reset to its zero value (proven against the live API
// 2026-11-11: an assignees-only POST turned a fresh task's description
// into ""). updateTask therefore merges the patch over the task's current
// writable state before POSTing — the same pattern utils/vikunja.js uses.
const TASK_WRITABLE_FIELDS = ['title', 'description', 'done', 'due_date', 'priority', 'start_date', 'end_date', 'hex_color', 'is_favorite', 'bucket_id', 'repeat_after', 'repeat_mode', 'percent_done'];
function makeVikClient(token) {
  return {
    getTask: (id) => vikRequest(token, 'GET', `/tasks/${id}`),
    // Vikunja creates tasks and comments with PUT (POST returns 405)
    createTask: (projectId, body) => vikRequest(token, 'PUT', `/projects/${projectId}/tasks`, body),
    updateTask: async (id, patch) => {
      const current = await vikRequest(token, 'GET', `/tasks/${id}`);
      const merged = {};
      for (const k of TASK_WRITABLE_FIELDS) {
        if (current && current[k] !== undefined && current[k] !== null) merged[k] = current[k];
      }
      if (current && Array.isArray(current.assignees) && current.assignees.length) {
        merged.assignees = current.assignees.map(a => ({ id: a.id }));
      }
      return vikRequest(token, 'POST', `/tasks/${id}`, { ...merged, ...patch });
    },
    comment: (id, text) => vikRequest(token, 'PUT', `/tasks/${id}/comments`, { comment: text }),
  };
}
async function postFindingsComment(text, token) {
  const res = await fetch(`http://127.0.0.1:3456/api/v1/tasks/${SEO_TICKET_ID}/comments`, {
    method: 'PUT', // Vikunja creates comments with PUT (utils/vikunja.js:196); POST returns 405
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment: text }),
  });
  if (!res.ok) throw new Error(`Vikunja comment POST failed: ${res.status}`);
  return res.json();
}

/* ---------- changes ledger (the ONLY path that records a shipped change) ---------- */
function recordChange(sandbox, rec) {
  if (!rec || !/^https?:\/\/(www\.)?(staynalive\.com|jessestay\.com)/i.test(rec.url || '')) {
    throw new Error('recordChange: url must be a staynalive.com or jessestay.com page URL');
  }
  if (!rec.description || !String(rec.description).trim()) {
    throw new Error('recordChange: a description of the shipped change is required');
  }
  const entry = { ts: new Date().toISOString(), url: rec.url, description: String(rec.description), approvedBy: rec.approvedBy || null };
  const file = path.join(sandbox, 'seo', 'changes.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

/* ---------- fix loop (Build S4) ---------- */
function fixTaskBody(cls, defects, day) {
  const lines = defects.map(d => `- ${d.page} — ${d.key}: ${d.detail}`);
  if (cls === 'content') {
    return {
      title: `[SEO FIX] ${defects.length} content defects — ${[...new Set(defects.map(d => new URL(d.page).origin))].sort().join(', ')}`,
      description: [
        `Routed by the SEO runner (audit ${day}) from findings ticket #${SEO_TICKET_ID}. The pages below answer HTTP 200 but fail on-page SEO checks:`,
        ...lines,
        '',
        `Evidence files: agent sandbox seo/latest-audit.json and seo/audit-${day}.md on macf-server.`,
        'Acceptance criterion: a re-audit shows each listed defect resolved.',
        'Instructions: ship the fixes through the site stack (Flywheel/WordPress). Do NOT write to seo/changes.jsonl yourself — the runner verifies each fix on its next audit and records the change in the ledger. If a fix needs Jesse\'s approval or a spend, escalate to the CEO instead of guessing.',
      ].join('\n'),
    };
  }
  return {
    title: `[SEO AVAILABILITY] sites unreachable — ${[...new Set(defects.map(d => new URL(d.page).origin))].sort().join(', ')}`,
    description: [
      `Routed by the SEO runner (audit ${day}) from findings ticket #${SEO_TICKET_ID}. The following pages/files did not answer HTTP 200:`,
      ...lines,
      '',
      `Evidence files: agent sandbox seo/latest-audit.json and seo/audit-${day}.md on macf-server.`,
      'This is a hosting/billing-class problem, not an on-page SEO problem. Diagnose why the sites are unreachable (hosting account status, suspension, DNS) and escalate to the CEO with the specific unblock needed (for example, the exact amount and account if a payment is what restores service). Do NOT pay anything yourself.',
      'Acceptance criterion: a re-audit shows each listed page/file answering HTTP 200 again. The runner comments the restoration here and closes this task; restorations are not recorded as SEO changes.',
    ].join('\n'),
  };
}

/* ---------- fix-task directive routing (Build S5) ---------- */
function buildFixDirective({ taskId, cls, defects, day }) {
  const head = `[from: CEO → ${FIX_DIRECTIVE_AGENT}] SEO ${cls === 'availability' ? 'AVAILABILITY' : 'FIX'} task #${taskId} routed by the SEO runner (audit ${day}): ${defects.length} ${cls} defect(s) need attention.`;
  const tail = [
    `Full defect list, fix instructions, and acceptance criteria: Vikunja task #${taskId}.`,
    'Acceptance: a runner re-audit shows each defect resolved; the runner records verified fixes in seo/changes.jsonl itself — do not write the ledger.',
    'If a fix needs Jesse\'s approval or a spend, escalate to the CEO instead of guessing.',
  ].join('\n');
  const all = defects.map(d => `- ${d.page} — ${d.key}: ${d.detail}`);
  for (let n = all.length; n >= 0; n--) {
    const parts = [head, ...all.slice(0, n)];
    if (defects.length - n > 0) parts.push(`- ...and ${defects.length - n} more defect(s) — full list in Vikunja task #${taskId}.`);
    parts.push(tail);
    const text = parts.join('\n');
    if (text.length < MAX_DIRECTIVE_CHARS) return text;
  }
  return head.slice(0, MAX_DIRECTIVE_CHARS - 1); // unreachable for real defect sets
}

async function postFixDirective(text) {
  // The mechanism ticket-triage.js established for bridging Vikunja work
  // into Slack (Oct 11, 2026): WebClient + the custom.slack surrogate
  // token, posted to #management, a channel directiveScan watches. Lazy
  // requires keep Slack deps off the audit path unless a task was created.
  const { WebClient } = require('@slack/web-api');
  const { execFileSync } = require('child_process');
  const fetchToken = `import sys\nimport os as _os\nfor _p in ('/opt/hatch/skills/skill-creator/bin', '/opt/muse/skills/custom-connector-setup/bin', '/opt/hatch/workflow-skills/custom-connector-setup/bin'):\n    if _os.path.exists(_p + '/dynamic_credentials.py'):\n        sys.path.insert(0, _p)\n        break\nfrom dynamic_credentials import dynamic_credential_entry\nentry = dynamic_credential_entry('custom.slack')\nsys.stdout.write(entry['surrogate'])`;
  const token = execFileSync('python3', ['-c', fetchToken], { timeout: 15000 }).toString().trim();
  const client = new WebClient(token);
  return client.chat.postMessage({ channel: DIRECTIVE_CHANNEL, text });
}

/*
 * Runs the fix loop against Vikunja. `tracked` is the state's fixTasks map:
 * { content: [{taskId, defectKeys}], availability: [...] } listing OPEN tasks.
 * Returns { tracked, created, closed, resolutions, errors } and never throws:
 * a Vikunja hiccup must not kill the audit evidence path.
 */
async function runFixLoop({ vik, sandbox, day, defects, allChecks, prevDefectKeys, tracked, directiveFn = null }) {
  const out = { tracked: { content: [], availability: [] }, created: [], closed: [], resolutions: [], errors: [], directives: [] };
  const currentKeys = new Set(defects.map(defectKeyOf));
  const passingKeys = new Set(allChecks.filter(c => c.ok).map(defectKeyOf));
  // A previous defect is resolved when it is gone now — and, for content
  // defects, when its check actually ran and passed (a dark page must not
  // fake a content resolution).
  const isResolved = (keyStr) => {
    if (currentKeys.has(keyStr)) return false;
    const key = keyStr.slice(keyStr.lastIndexOf('|') + 1);
    if (AVAILABILITY_KEYS.has(key)) return true;
    return passingKeys.has(keyStr);
  };
  const resolvedKeys = (prevDefectKeys || []).filter(isResolved);

  // 1) Record resolved CONTENT defects in the changes ledger.
  for (const keyStr of resolvedKeys) {
    const key = keyStr.slice(keyStr.lastIndexOf('|') + 1);
    if (AVAILABILITY_KEYS.has(key)) continue;
    const page = keyStr.slice(0, keyStr.lastIndexOf('|'));
    try {
      const entry = recordChange(sandbox, { url: page, description: changeDescription(key) });
      out.resolutions.push({ keyStr, recorded: entry });
    } catch (e) { out.errors.push(`recordChange ${keyStr}: ${e.message}`); }
  }

  // 2) Refresh tracked tasks: drop ones Vikunja says are closed (their
  //    defects, if any persist, become uncovered and route fresh below).
  const stillOpen = { content: [], availability: [] };
  for (const cls of ['content', 'availability']) {
    for (const t of (tracked && tracked[cls]) || []) {
      try {
        const live = await vik.getTask(t.taskId);
        if (live && live.done) continue;
        stillOpen[cls].push({ taskId: t.taskId, defectKeys: [...t.defectKeys] });
      } catch (e) { out.errors.push(`getTask ${t.taskId}: ${e.message}`); stillOpen[cls].push({ taskId: t.taskId, defectKeys: [...t.defectKeys] }); }
    }
  }

  // 3) Resolution comments + closure on covering fix tasks.
  for (const cls of ['content', 'availability']) {
    const keep = [];
    for (const t of stillOpen[cls]) {
      const hit = t.defectKeys.filter(k => resolvedKeys.includes(k));
      const remaining = t.defectKeys.filter(k => !resolvedKeys.includes(k));
      if (hit.length) {
        const text = [
          `SEO runner re-audit (${day}) — resolution verified for ${hit.length} of ${t.defectKeys.length} tracked item(s) on this task:`,
          ...hit.map(k => {
            const page = k.slice(0, k.lastIndexOf('|'));
            const key = k.slice(k.lastIndexOf('|') + 1);
            return cls === 'content'
              ? `- ${page} — ${key}: ${changeDescription(key)}; recorded in seo/changes.jsonl.`
              : `- ${page} — ${key}: answering again on re-audit; restoration noted here only, not recorded as an SEO change.`;
          }),
          ...(remaining.length ? [`Still open on this task: ${remaining.length} item(s).`] : ['All tracked items on this task are resolved; closing.']),
        ].join('\n');
        try { await vik.comment(t.taskId, text); } catch (e) { out.errors.push(`comment task ${t.taskId}: ${e.message}`); }
      }
      if (!remaining.length) {
        // Fully resolved: close. On a close failure keep the task tracked
        // with an empty key list so the close is retried next run without
        // re-commenting or re-recording anything.
        try { await vik.updateTask(t.taskId, { done: true }); out.closed.push(t.taskId); continue; }
        catch (e) { out.errors.push(`close task ${t.taskId}: ${e.message}`); keep.push({ taskId: t.taskId, defectKeys: [] }); continue; }
      }
      keep.push({ taskId: t.taskId, defectKeys: remaining });
    }
    out.tracked[cls] = keep;
  }

  // 4) Route uncovered defects: one new task per class per run.
  let projectId = null;
  for (const cls of ['content', 'availability']) {
    const covered = new Set(out.tracked[cls].flatMap(t => t.defectKeys));
    const uncovered = defects.filter(d => classifyDefect(d) === cls && !covered.has(defectKeyOf(d)));
    if (!uncovered.length) continue;
    try {
      if (projectId === null) {
        projectId = FALLBACK_PROJECT_ID;
        try { const seo = await vik.getTask(SEO_TICKET_ID); if (seo && seo.project_id) projectId = seo.project_id; } catch { /* fallback stands */ }
      }
      const body = fixTaskBody(cls, uncovered, day);
      const task = await vik.createTask(projectId, body);
      if (!task || !task.id) throw new Error('createTask returned no task id');
      await vik.updateTask(task.id, { assignees: [{ id: CTO_USER_ID }] });
      out.tracked[cls].push({ taskId: task.id, defectKeys: uncovered.map(defectKeyOf) });
      out.created.push({ taskId: task.id, class: cls, title: body.title });
      // Route the work to the owning agent as a Slack directive — a bare
      // Vikunja assignment never reaches an agent (Build S5). This fires
      // ONLY here, on genuine task creation: a re-run whose defects are
      // all covered creates nothing and posts nothing.
      if (directiveFn) {
        try {
          await directiveFn(buildFixDirective({ taskId: task.id, cls, defects: uncovered, day }));
          out.directives.push({ taskId: task.id, class: cls });
        } catch (e) { out.errors.push(`directive for task ${task.id}: ${e.message}`); }
      }
    } catch (e) { out.errors.push(`create ${cls} fix task: ${e.message}`); }
  }
  return out;
}

/* ---------- run ---------- */
async function run({ sandbox = sandboxDir(), state = stateDir(), fetchFn = fetchUrl, postFn = null, vik = null, token = null, directiveFn = null } = {}) {
  const allChecks = [];
  for (const page of PAGES) {
    const { status, body } = await fetchFn(page);
    allChecks.push(...analyzePage(page, status, body));
  }
  const origins = [...new Set(PAGES.map(p => new URL(p).origin))];
  for (const origin of origins) {
    for (const kind of ['robots.txt', 'sitemap.xml']) {
      const { status } = await fetchFn(`${origin}/${kind}`);
      allChecks.push(...analyzeSiteFile(origin, kind, status));
    }
  }
  const defects = allChecks.filter(c => !c.ok);
  const defectKeys = defects.map(defectKeyOf).sort();
  const day = denverDay();
  const audit = { day, ranAt: new Date().toISOString(), pagesChecked: PAGES.length, checks: allChecks.length, defects };

  const seoDir = path.join(sandbox, 'seo');
  fs.mkdirSync(seoDir, { recursive: true });
  fs.writeFileSync(path.join(seoDir, 'latest-audit.json'), JSON.stringify(audit, null, 2) + '\n');
  const md = [
    `# SEO audit — ${day}`, '',
    `Pages checked: ${PAGES.length} · Checks run: ${allChecks.length} · Defects found: ${defects.length}`, '',
    ...(defects.length
      ? defects.map(d => `- ${d.page} — ${d.key}: ${d.detail}`)
      : ['No defects found on the checked pages.']),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(seoDir, `audit-${day}.md`), md);

  const stateFile = path.join(state, 'seo-runner.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
  const hashNow = defectKeys.join(';');
  const changed = !prev || prev.defectHash !== hashNow;
  let commented = false;
  if (changed) {
    const text = [
      `SEO runner audit (${day}) — findings only; no site edits were made by the runner.`,
      `Pages observed: ${PAGES.join(', ')}`,
      `Defects found: ${defects.length} of ${allChecks.length} checks.`,
      ...defects.map(d => `- ${d.page} — ${d.key}: ${d.detail}`),
      ...(defects.length === 0 ? ['- All checks pass on the observed pages.'] : []),
      'Evidence files: sandbox seo/latest-audit.json. A change counts only when an approved fix ships and is recorded in seo/changes.jsonl.',
    ].join('\n');
    const poster = postFn || (async (t) => postFindingsComment(t, token || readEnvToken('VIKUNJA_TOKEN')));
    await poster(text);
    commented = true;
  }

  // Build S4 fix loop: route defects to the CTO as tracked work and verify
  // resolutions. Runs every audit (routing is gated by coverage, not by the
  // findings-comment dedupe, so a steady defect set still gets its task).
  // The client is built lazily so tests that inject postFn/fetchFn but no
  // vik never touch the real API; if the token is unreadable the loop is
  // skipped with the failure recorded, never silently.
  let fix = {
    tracked: prev ? (prev.fixTasks || { content: [], availability: [] }) : { content: [], availability: [] },
    created: [], closed: [], resolutions: [], errors: [], directives: [],
  };
  let vikClient = vik;
  if (!vikClient) {
    try { vikClient = makeVikClient(token || readEnvToken('VIKUNJA_TOKEN')); }
    catch (e) { fix.errors.push(`vikunja client unavailable: ${e.message}`); }
  }
  // Directive posting defaults to the real Slack poster ONLY on the
  // production path (no Vikunja client injected). Callers that inject a
  // client (tests, dry runs) stay hermetic unless they also inject a
  // directiveFn of their own.
  let effectiveDirectiveFn = directiveFn;
  if (!effectiveDirectiveFn && !vik && vikClient) {
    effectiveDirectiveFn = async (text) => postFixDirective(text);
  }
  if (vikClient) {
    fix = await runFixLoop({
      vik: vikClient, sandbox, day, defects, allChecks,
      prevDefectKeys: prev ? (prev.defectKeys || []) : [],
      tracked: prev ? (prev.fixTasks || {}) : {},
      directiveFn: effectiveDirectiveFn,
    });
  }
  for (const e of fix.errors) console.error('[seoRunner] fix loop:', e);

  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    defectHash: hashNow, defectKeys, lastRun: audit.ranAt, commented, fixTasks: fix.tracked,
  }, null, 2) + '\n');
  return {
    ...audit, commented, defectCount: defects.length,
    fixTasksCreated: fix.created, fixTasksClosed: fix.closed,
    fixDirectivesPosted: fix.directives,
    resolutionsRecorded: fix.resolutions.length, fixErrors: fix.errors,
  };
}

/* ---------- dry run: the full routing path with zero production writes ---------- */
async function dryRunMain() {
  const os = require('os');
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-dry-sandbox-'));
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-dry-state-'));
  const created = [];
  const posted = [];
  const fakeVik = {
    async getTask(id) {
      if (id === SEO_TICKET_ID) return { id, project_id: FALLBACK_PROJECT_ID, done: false };
      throw new Error(`dry-run: no task ${id}`);
    },
    async createTask(projectId, body) {
      const t = { id: 900000 + created.length, project_id: projectId, done: false, ...body };
      created.push(t);
      return { ...t };
    },
    async updateTask(id, patch) { return { id, ...patch }; },
    async comment() { return {}; },
  };
  const r = await run({
    sandbox: sb, state: st, vik: fakeVik,
    postFn: async (t) => { posted.push(['findings comment', t]); return {}; },
    directiveFn: async (t) => { posted.push(['Slack directive', t]); return {}; },
  });
  console.log(`DRY RUN — audit ${r.day}: ${r.defectCount} defect(s) across ${r.checks} checks; sandbox/state in tmp dirs; NO production writes.`);
  for (const t of created) {
    console.log(`\n--- would-be Vikunja task (project ${t.project_id}) ---\nTITLE: ${t.title}\nDESCRIPTION:\n${t.description}`);
  }
  for (const [kind, text] of posted) console.log(`\n--- would-be ${kind} ---\n${text}`);
  if (r.fixErrors.length) console.log(`\nFix loop errors: ${r.fixErrors.join('; ')}`);
}

if (require.main === module) {
  if (process.argv.includes('--dry-run')) {
    dryRunMain().catch(e => { console.error('[seoRunner] DRY RUN FATAL:', e.message); process.exit(2); });
  } else {
    run().then(r => {
      console.log(`SEO audit ${r.day}: ${r.defectCount} defect(s) across ${r.checks} checks; findings comment posted: ${r.commented}`);
      for (const d of r.defects) console.log(`- ${d.page} — ${d.key}: ${d.detail}`);
      for (const c of r.fixTasksCreated) console.log(`Fix task created: #${c.taskId} [${c.class}] ${c.title}`);
      for (const dv of r.fixDirectivesPosted) console.log(`Fix directive posted: task #${dv.taskId} [${dv.class}] → ${FIX_DIRECTIVE_AGENT}`);
      for (const id of r.fixTasksClosed) console.log(`Fix task closed: #${id}`);
      if (r.resolutionsRecorded) console.log(`Resolutions recorded to seo/changes.jsonl: ${r.resolutionsRecorded}`);
      if (r.fixErrors.length) { console.error(`Fix loop errors: ${r.fixErrors.join('; ')}`); process.exit(2); }
    }).catch(e => { console.error('[seoRunner] FATAL:', e.message); process.exit(2); });
  }
}

module.exports = {
  analyzePage, analyzeSiteFile, run, recordChange, postFindingsComment, PAGES, SEO_TICKET_ID,
  classifyDefect, changeDescription, fixTaskBody, runFixLoop, CTO_USER_ID,
  makeVikClient, buildFixDirective, postFixDirective, DIRECTIVE_CHANNEL, FIX_DIRECTIVE_AGENT,
};
