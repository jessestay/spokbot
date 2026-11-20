/**
 * Agent Tool Execution Layer (Oct 9, 2026; #724 layer Oct 12, 2026)
 *
 * Root cause of MACF delivery failure: agents are pure LLM text generators.
 * handleDelegation() explicitly reports "no tool execution" — agents cannot
 * build artifacts, check URLs, write files, or produce anything clickable.
 * Jesse's demo standard requires clickable artifacts. This was impossible by design.
 *
 * This module gives agents a safe, bounded set of tools they can invoke
 * during delegation. Every tool call is logged, bounded, and reversible.
 *
 * #724 (docs/code-enforced-tool-use-design.md, Pillars 1 + 4) adds two
 * guarantees at this single choke point:
 *   1. Every execution issues a structured receipt (engine/receipts.js) —
 *      success, tool failure, validation failure, and unknown tool alike.
 *      There are no early returns before the receipt/audit tail.
 *   2. Arguments are validated against a per-tool argsSchema BEFORE the
 *      tool function runs. Violations return a structured, machine-readable
 *      correction { expected, received, missing, unknown } with
 *      errorClass 'invalid_input' — the tool function is never invoked.
 * The tool implementations below are byte-for-byte the pre-#724 behavior;
 * only the registry/dispatch layer changed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Workspace sandbox — agents can only write here. Anchored to the
// running user's home (US-FW-002); no hardcoded operator home.
const SANDBOX = path.join(os.homedir(), 'workspace', 'agent-sandbox');

// Per-tool timeouts (ms)
const TIMEOUTS = {
  urlCheck: 15000,
  fileWrite: 5000,
  fileRead: 5000,
  slackPost: 30000,
};

/**
 * Check if a URL is reachable and return status.
 * Used for validating artifact links before demoing them.
 */
function urlCheck(url) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'Invalid URL — must start with http:// or https://' };
  }
  try {
    // Use curl with strict timeout, no redirects beyond 3, fail on HTTP errors
    const out = execFileSync('curl', [
      '-s', '-o', '/dev/null',
      '-w', '%{http_code}:%{time_total}',
      '--max-time', '10',
      '--max-redirs', '3',
      '-L',
      url,
    ], { encoding: 'utf8', timeout: TIMEOUTS.urlCheck }).trim();
    const [code, time] = out.split(':');
    const httpCode = parseInt(code, 10);
    return {
      ok: httpCode >= 200 && httpCode < 400,
      httpCode,
      responseTime: parseFloat(time),
      url,
    };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200), url };
  }
}

/**
 * Write a file to the agent sandbox. Returns the sandbox-relative path.
 * Agents use this to create demo artifacts (drafts, reports, HTML previews).
 */
function fileWrite(relativePath, content) {
  // Security: reject any path traversal attempts outright
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('..')) {
    return { ok: false, error: 'Path traversal blocked' };
  }

  const safe = path.normalize(relativePath);
  const fullPath = path.join(SANDBOX, safe);
  try {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    return {
      ok: true,
      path: fullPath,
      sandboxPath: safe,
      size: Buffer.byteLength(content, 'utf8'),
    };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200) };
  }
}

/**
 * Read a file from the agent sandbox.
 */
function fileRead(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('..')) {
    return { ok: false, error: 'Path traversal blocked' };
  }
  const safe = path.normalize(relativePath);
  const fullPath = path.join(SANDBOX, safe);
  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    return { ok: true, content: content.slice(0, 50000), size: content.length };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200) };
  }
}

/**
 * List files in the agent sandbox.
 */
function fileList(relativePath = '') {
  if (path.isAbsolute(relativePath) || relativePath.includes('..')) {
    return { ok: false, error: 'Path traversal blocked' };
  }
  const safe = path.normalize(relativePath || '.');
  const fullPath = path.join(SANDBOX, safe);
  try {
    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    return {
      ok: true,
      entries: entries.map(e => ({
        name: e.name,
        isDirectory: e.isDirectory(),
      })),
    };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200) };
  }
}

/**
 * Desktop channel (Oct 12, 2026 — Jesse's order: "Extend the CTO's grants
 * to the desktop channels", Vikunja #738). Runs PowerShell on Jesse's
 * desktop (DESKTOP-4U63DES) through the desktop agent client — the same
 * channel the CEO uses (~/workspace/desktop-agent/bin/desktop-run). The
 * client talks to the agent at 100.92.127.117:8099 via the tunnel proxy
 * and authenticates with DESKTOP_AGENT_TOKEN (slack-agents/.env, loaded
 * by dotenv at engine boot). Role-gated at the executeTool choke point:
 * only the roles listed on the registry entries below may call these.
 *
 * Commands must stay SMALL and BOUNDED (the desktop agent is
 * single-threaded; one long command blocks all others): cap the output,
 * cap the scope, never run unbounded recursive scans.
 */
// US-FW-002: explicit DESKTOP_RUN_CLIENT env wins; otherwise the
// client lives in the operator's home workspace (same anchor the
// desktop hands server uses — hands/servers/desktop/paths.js).
const DESKTOP_RUN_CLIENT = process.env.DESKTOP_RUN_CLIENT ||
  path.join(os.homedir(), 'workspace', 'desktop-agent', 'bin', 'desktop-run');

function desktopCall(argv, timeoutMs) {
  try {
    const out = execFileSync('python3', [DESKTOP_RUN_CLIENT, ...argv], {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, DESKTOP_RUN_TOKEN: process.env.DESKTOP_AGENT_TOKEN || '' },
    });
    return { ok: true, output: String(out).slice(0, 8000) };
  } catch (e) {
    const stdout = e.stdout ? String(e.stdout).slice(0, 2000) : '';
    const stderr = e.stderr ? String(e.stderr).slice(0, 500) : '';
    return { ok: false, error: (stderr || e.message).slice(0, 500), output: stdout };
  }
}

function desktopHealth() {
  return desktopCall(['health'], 30000);
}

function desktopRun(command, timeoutSec = 120) {
  const t = Math.max(5, Math.min(parseInt(timeoutSec, 10) || 120, 300));
  const r = desktopCall([command, String(t)], (t + 30) * 1000);
  if (!r.ok) return r;
  return { ok: true, output: r.output, timeoutSec: t };
}

/**
 * Slack channel post — #925 round 5 (Nov 2, 2026). Round 4 proved the
 * CCO can produce the weekly batch and the finalize gate can verify it
 * (file_exists + json_array_min satisfied in the outcomes ledger), but
 * the batch could not LAND: no agent tool could post to a Slack
 * channel. agentTools defined no Slack-post local tool, the baseline
 * slack MCP is read-only by design (and broken, #911 class), and a
 * directive run's only Slack write path was the poller posting the
 * agent's final text into the directive thread — so the verified batch
 * landed in #management, never in #content, and the CCO (correctly)
 * escalated "no #content channel tool exists in my toolset."
 *
 * slackPost closes that hole the way wpUpdate / vikunjaComment closed
 * theirs: the bot token the engine already holds (SLACK_BOT_TOKEN,
 * resolved server-side via engine/slackToken) is used inside this
 * layer only — it never appears in args, results, or error strings
 * (transport failures are reported without the curl command line,
 * which carries the Authorization header). Role-gated at the
 * executeTool choke point: cco + ceo only. Every call is receipted by
 * finishExecution, so a directive contract can require
 * receipt_count(slackPost, ok) >= 1 as ground truth that a post
 * actually happened.
 *
 * Media rides two ways: mediaUrl is appended to the post text (Slack
 * unfurls it — how Canva design URLs and credited free-stock page URLs
 * are carried), and filePath optionally attaches ONE file from the
 * agent sandbox via Slack's external upload flow
 * (files.getUploadURLExternal -> PUT -> files.completeUploadExternal),
 * shared into the same channel/thread with the text as its caption.
 */
const SLACK_API_BASE = 'https://slack.com/api';

function slackApi(method, params, formEncoded) {
  let token = '';
  try { token = require('../engine/slackToken').resolveSlackToken() || ''; } catch { token = ''; }
  if (!token) {
    return { ok: false, error: 'Slack is not configured (SLACK_BOT_TOKEN missing) — the credential must be provisioned before this tool can act', errorClass: 'missing_credential' };
  }
  const args = ['-s', '--max-time', '25', '-X', 'POST', '-H', `Authorization: Bearer ${token}`];
  if (formEncoded) {
    for (const [k, v] of Object.entries(params)) args.push('--data-urlencode', `${k}=${v}`);
  } else {
    args.push('-H', 'Content-Type: application/json; charset=utf-8', '--data', JSON.stringify(params));
  }
  args.push(`${SLACK_API_BASE}/${method}`);
  let out;
  try {
    out = execFileSync('curl', args, { encoding: 'utf8', timeout: TIMEOUTS.slackPost });
  } catch (e) {
    // Never surface e.message: execFileSync error text can embed the
    // curl command line, including the Authorization header.
    return { ok: false, error: `Slack request failed (${method}): transport error${e.status ? ` (curl exit ${e.status})` : ''}` };
  }
  let parsed = null;
  try { parsed = JSON.parse(out); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: `Slack API ${method}: unparseable response` };
  }
  if (!parsed.ok) {
    return { ok: false, error: `Slack API ${method}: ${parsed.error || 'unknown_error'}`, slackError: parsed.error || null };
  }
  return { ok: true, data: parsed };
}

function slackPostFile({ channel, text, threadTs, filePath }) {
  // Same sandbox discipline as fileRead: relative paths only, no
  // traversal — the attachment must already live in the agent sandbox.
  if (path.isAbsolute(filePath) || filePath.includes('..')) {
    return { ok: false, error: 'filePath must be sandbox-relative (no absolute paths, no traversal)' };
  }
  const fullPath = path.join(SANDBOX, path.normalize(filePath));
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch (e) {
    return { ok: false, error: `Attachment not readable in the sandbox: ${e.message.slice(0, 150)}` };
  }
  if (!stat.isFile()) return { ok: false, error: 'filePath is not a file' };
  if (stat.size === 0) return { ok: false, error: 'Attachment file is empty' };
  if (stat.size > 25 * 1024 * 1024) return { ok: false, error: `Attachment too large (${stat.size} bytes; cap 25MB)` };
  const filename = path.basename(fullPath);

  const urlRes = slackApi('files.getUploadURLExternal', { filename, length: stat.size }, true);
  if (!urlRes.ok) return urlRes;
  const uploadUrl = urlRes.data.upload_url;
  const fileId = urlRes.data.file_id;
  if (!uploadUrl || !fileId) {
    return { ok: false, error: 'Slack files.getUploadURLExternal returned no upload_url/file_id' };
  }
  try {
    execFileSync('curl', ['-s', '--max-time', '60', '-X', 'PUT', '--data-binary', `@${fullPath}`, uploadUrl], {
      encoding: 'utf8', timeout: 70000, maxBuffer: 1024 * 1024,
    });
  } catch (e) {
    // The upload URL is a one-time signed URL, not a credential for
    // Jesse's accounts; still keep the report free of command lines.
    return { ok: false, error: `Slack file upload failed: transport error${e.status ? ` (curl exit ${e.status})` : ''}` };
  }
  const completeParams = {
    files: JSON.stringify([{ id: fileId, title: filename }]),
    channel_id: channel,
    initial_comment: text,
  };
  if (threadTs) completeParams.thread_ts = threadTs;
  const done = slackApi('files.completeUploadExternal', completeParams, true);
  if (!done.ok) return done;
  const f = (Array.isArray(done.data.files) && done.data.files[0]) || {};
  return { ok: true, channel, fileId: f.id || fileId, via: 'file_upload' };
}

function slackPost(args) {
  const channel = typeof args.channel === 'string' ? args.channel.trim() : '';
  if (!/^[CG][A-Z0-9]{8,}$/.test(channel)) {
    return { ok: false, error: `Invalid channel '${channel}' — pass a Slack channel ID (e.g. C0ASA532BGD for #content), not a channel name`, errorClass: 'invalid_input' };
  }
  let text = typeof args.text === 'string' ? args.text : '';
  const mediaUrl = typeof args.mediaUrl === 'string' && args.mediaUrl.trim() ? args.mediaUrl.trim() : null;
  if (mediaUrl) {
    if (!/^https?:\/\//i.test(mediaUrl)) {
      return { ok: false, error: 'mediaUrl must be an http(s) URL', errorClass: 'invalid_input' };
    }
    if (!text.includes(mediaUrl)) text = text ? `${text}\n${mediaUrl}` : mediaUrl;
  }
  if (!text.trim()) {
    return { ok: false, error: 'Nothing to post — provide text (optionally with mediaUrl or filePath)' };
  }
  if (text.length > 20000) {
    return { ok: false, error: `Text too long (${text.length} chars; cap 20000) — split into a lead post plus threaded replies`, errorClass: 'invalid_input' };
  }
  const threadTs = typeof args.thread_ts === 'string' && args.thread_ts ? args.thread_ts : null;

  if (args.filePath) {
    return slackPostFile({ channel, text, threadTs, filePath: args.filePath });
  }
  const params = { channel, text };
  if (threadTs) params.thread_ts = threadTs;
  const r = slackApi('chat.postMessage', params, false);
  if (!r.ok) return r;
  return { ok: true, channel: r.data.channel || channel, ts: r.data.ts || null };
}

/**
 * codeRead — #807 Phase 2 (US-P2.1, sandbox read alignment). The CTO's
 * #745 assessment claimed "workspace permissions block access" to the very
 * code and state the agents own, because fileRead only reaches the agent
 * sandbox. This tool gives leadership roles read access to the MACF tree
 * (source + state), read-only, with secret-bearing files denied by
 * construction. Paths are relative to the MACF repo root.
 */
const MACF_ROOT = path.resolve(__dirname, '..', '..');
const CODEREAD_DENY = /(^|\/)\.env($|\.)|(^|\/)credentials($|\.)|secret|\.pem$|\.key$|(^|\/)id_[a-z0-9]+$/i;
const CODEREAD_BINARY = /\.(png|jpe?g|gif|webp|pdf|zip|gz|db|sqlite|mp[34]|mov)$/i;

function codeRead(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    return { ok: false, error: 'Path must be relative to the MACF root' };
  }
  const fullPath = path.resolve(MACF_ROOT, relativePath);
  if (fullPath !== MACF_ROOT && !fullPath.startsWith(MACF_ROOT + path.sep)) {
    return { ok: false, error: 'Path escapes the MACF tree — refused' };
  }
  const rel = path.relative(MACF_ROOT, fullPath);
  if (CODEREAD_DENY.test(rel)) {
    return { ok: false, error: 'Secret-bearing files are not readable through codeRead', errorClass: 'permission' };
  }
  if (CODEREAD_BINARY.test(rel)) {
    return { ok: false, error: 'Binary file — use a purpose-built reader (pdfRead for PDFs)' };
  }
  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    return { ok: true, content: content.slice(0, 50000), size: content.length, path: rel };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200) };
  }
}

/**
 * pdfRead — #807 Phase 2 (US-P2.2). Text extraction from PDFs in the
 * agent sandbox via pdftotext (the #658 product-PDF class of work:
 * verdicts were claimed for PDFs the agents could not actually read).
 */
function pdfRead(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('..')) {
    return { ok: false, error: 'Path traversal blocked' };
  }
  if (!/\.pdf$/i.test(relativePath)) {
    return { ok: false, error: 'pdfRead only reads .pdf files' };
  }
  const fullPath = path.join(SANDBOX, path.normalize(relativePath));
  try {
    const out = execFileSync('pdftotext', ['-layout', fullPath, '-'], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 5 * 1024 * 1024,
    });
    return { ok: true, text: out.slice(0, 50000), chars: out.length };
  } catch (e) {
    // FALLBACK (Oct 28, 2026): poppler-utils is not installed on every host
    // (missing on the Oracle server), which made pdfRead fail closed for a
    // missing binary rather than an unreadable file. Extract text from
    // uncompressed content streams directly — enough for the simple,
    // text-bearing PDFs this tool is aimed at; compressed/object-stream
    // PDFs still need pdftotext and report honestly below.
    if (e.code === 'ENOENT') {
      try {
        const raw = fs.readFileSync(fullPath, 'latin1');
        if (!raw.startsWith('%PDF')) return { ok: false, error: 'Not a PDF file' };
        const chunks = [];
        const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
        let m;
        while ((m = streamRe.exec(raw)) !== null) {
          const textRe = /\(((?:\\.|[^\\,)])*)\)\s*(?:Tj|')/g;
          let t;
          while ((t = textRe.exec(m[1])) !== null) {
            chunks.push(t[1].replace(/\\([()\\])/g, '$1'));
          }
        }
        const text = chunks.join(' ');
        if (text.trim()) return { ok: true, text: text.slice(0, 50000), chars: text.length, extractor: 'builtin-fallback' };
      } catch (_) { /* fall through to the honest error */ }
      return { ok: false, error: 'pdftotext not available on this host and no extractable text streams found' };
    }
    return { ok: false, error: (e.stderr ? String(e.stderr) : e.message).slice(0, 200) };
  }
}

/**
 * WordPress REST — #807 Phase 2 (US-P2.3). The CMO failed the workshop
 * page three times because no write path to WordPress existed anywhere
 * in the registry (the audit found zero wordpress references in source).
 * wpRead/wpUpdate give granted roles the real actuator: app-password
 * Basic auth from env (WP_BASE_URL / WP_USER / WP_APP_PASSWORD), every
 * call receipted by the executeTool choke point.
 */
function wpConfig() {
  const user = process.env.WP_USER || '';
  const pass = process.env.WP_APP_PASSWORD || '';
  if (!user || !pass) return null;
  return { base: (process.env.WP_BASE_URL || 'https://staynalive.com').replace(/\/+$/, ''), user, pass };
}

function wpCurl(method, pathQ, jsonBody) {
  const cfg = wpConfig();
  if (!cfg) {
    return { ok: false, error: 'WordPress is not configured (WP_USER / WP_APP_PASSWORD missing) — the credential must be provisioned before this tool can act', errorClass: 'missing_credential' };
  }
  const auth = Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64');
  const args = ['-s', '--max-time', '20', '-X', method, '-H', `Authorization: Basic ${auth}`, '-H', 'Content-Type: application/json'];
  if (/localhost|127\.0\.0\.1/.test(cfg.base)) args.push('--noproxy', '*');
  if (jsonBody) args.push('--data', JSON.stringify(jsonBody));
  args.push('-w', '\n%{http_code}', `${cfg.base}${pathQ}`);
  try {
    const out = execFileSync('curl', args, { encoding: 'utf8', timeout: 25000 });
    const nl = out.lastIndexOf('\n');
    const code = parseInt(out.slice(nl + 1), 10);
    const parsed = JSON.parse(out.slice(0, nl) || '{}');
    if (code < 200 || code >= 300) {
      return { ok: false, error: `WordPress API ${code}: ${parsed.message || parsed.code || 'error'}`, httpCode: code };
    }
    return { ok: true, data: parsed };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200) };
  }
}

function wpShape(p) {
  return {
    ok: true,
    id: p.id,
    slug: p.slug,
    status: p.status,
    modified: p.modified,
    title: p.title && p.title.rendered,
    contentRendered: p.content && typeof p.content.rendered === 'string' ? p.content.rendered.slice(0, 50000) : '',
  };
}

function wpRead(args) {
  if (args.id) {
    const r = wpCurl('GET', `/wp-json/wp/v2/pages/${parseInt(args.id, 10)}`);
    return r.ok ? wpShape(r.data) : r;
  }
  const r = wpCurl('GET', `/wp-json/wp/v2/pages?slug=${encodeURIComponent(args.slug)}&status=any`);
  if (!r.ok) return r;
  if (!Array.isArray(r.data) || !r.data.length) return { ok: false, error: `No page found with slug '${args.slug}'` };
  return wpShape(r.data[0]);
}

function wpUpdate(args) {
  const body = {};
  if (typeof args.content === 'string') body.content = args.content;
  if (typeof args.title === 'string') body.title = args.title;
  if (typeof args.status === 'string') body.status = args.status;
  if (!Object.keys(body).length) return { ok: false, error: 'Nothing to update — provide content, title, or status' };
  const r = wpCurl('POST', `/wp-json/wp/v2/pages/${parseInt(args.id, 10)}`, body);
  return r.ok ? wpShape(r.data) : r;
}

/**
 * Vikunja task board — (Oct 21, 2026, CEO mechanism repair under Jesse's
 * Oct 20 standing tool rule). The overnight burn-down stalled on a hole
 * this layer owns: utils/vikunja.js is an engine-internal async client
 * that was never exposed to agents, and webFetch cannot send
 * Authorization headers — so execPM's board calls returned 401 and it
 * could not read #834, triage the projects, or attach evidence. These
 * tools close the hole the way wpRead/wpUpdate did for WordPress: the
 * API token (VIKUNJA_TOKEN from the engine env) is used SERVER-SIDE
 * only; agents pass task ids and fields, never a credential. The token
 * never appears in args, results, or error strings — transport failures
 * are reported without the curl command line, which carries the
 * Authorization header.
 *
 * vikunjaAttachEvidence posts the evidence as a task comment: native
 * Vikunja file attachments need a multipart upload flow that does not
 * fit this sync curl layer, and a comment is the evidence surface the
 * completion verifier already reads.
 *
 * Deliberately NOT here: marking tasks done. Closure runs through the
 * completion verifier (engine/completion.js); no tool in this registry
 * may write `done` (the #724 rule that removed the old agent-side
 * completeTask wrapper applies to agent tools too).
 */
const VIKUNJA_ROLES = ['execPM', 'execpm', 'ceo', 'cto', 'cmo', 'cco', 'cfo', 'cro', 'cuxo', 'lawyer', 'jobcoach', 'hr', 'facebook'];

function vikunjaConfig() {
  const token = process.env.VIKUNJA_TOKEN || '';
  if (!token) return null;
  return { base: (process.env.VIKUNJA_URL || 'http://127.0.0.1:3456').replace(/\/+$/, ''), token };
}

function vikunjaCurl(method, pathQ, jsonBody) {
  const cfg = vikunjaConfig();
  if (!cfg) {
    return { ok: false, error: 'Vikunja is not configured (VIKUNJA_TOKEN missing) — the credential must be provisioned before this tool can act', errorClass: 'missing_credential' };
  }
  const args = ['-s', '--max-time', '20', '-X', method, '-H', `Authorization: Bearer ${cfg.token}`, '-H', 'Content-Type: application/json'];
  if (/localhost|127\.0\.0\.1/.test(cfg.base)) args.push('--noproxy', '*');
  if (jsonBody) args.push('--data', JSON.stringify(jsonBody));
  args.push('-w', '\n%{http_code}', `${cfg.base}/api/v1${pathQ}`);
  try {
    const out = execFileSync('curl', args, { encoding: 'utf8', timeout: 25000 });
    const nl = out.lastIndexOf('\n');
    const code = parseInt(out.slice(nl + 1), 10);
    let parsed = null;
    try { parsed = JSON.parse(out.slice(0, nl) || 'null'); } catch { parsed = null; }
    if (code < 200 || code >= 300) {
      const msg = (parsed && (parsed.message || parsed.code)) || 'error';
      return { ok: false, error: `Vikunja API ${code}: ${msg}`, httpCode: code };
    }
    return { ok: true, data: parsed };
  } catch (e) {
    // Never surface e.message: execFileSync error text embeds the curl
    // command line, including the Authorization header.
    return { ok: false, error: `Vikunja request failed (${method} ${pathQ}): transport error${e.status ? ` (curl exit ${e.status})` : ''}` };
  }
}

function vikunjaShapeTask(t) {
  return {
    id: t.id,
    title: t.title,
    done: !!t.done,
    priority: t.priority,
    dueDate: t.due_date || null,
    projectId: t.project_id,
    assignees: Array.isArray(t.assignees) ? t.assignees.map(a => ({ id: a.id, username: a.username })) : [],
    created: t.created,
    updated: t.updated,
  };
}

function vikunjaListTasks(args) {
  const projectId = parseInt(args.projectId, 10);
  const limit = Math.max(1, Math.min(parseInt(args.limit, 10) || 50, 100));
  let q = `?per_page=${limit}`;
  if (typeof args.done === 'boolean') q += `&filter=${encodeURIComponent(`done = ${args.done}`)}`;
  const r = vikunjaCurl('GET', `/projects/${projectId}/tasks${q}`);
  if (!r.ok) return r;
  const tasks = Array.isArray(r.data) ? r.data : [];
  return { ok: true, projectId, count: tasks.length, tasks: tasks.map(vikunjaShapeTask) };
}

function vikunjaGetTask(args) {
  const taskId = parseInt(args.taskId, 10);
  const r = vikunjaCurl('GET', `/tasks/${taskId}`);
  if (!r.ok) return r;
  const t = r.data || {};
  const shaped = {
    ok: true,
    ...vikunjaShapeTask(t),
    description: typeof t.description === 'string' ? t.description.slice(0, 20000) : '',
  };
  const cr = vikunjaCurl('GET', `/tasks/${taskId}/comments`);
  if (cr.ok && Array.isArray(cr.data)) {
    shaped.commentCount = cr.data.length;
    shaped.comments = cr.data.slice(-20).map(c => ({
      id: c.id,
      author: c.author && c.author.username,
      created: c.created,
      comment: typeof c.comment === 'string' ? c.comment.slice(0, 1000) : '',
    }));
  }
  return shaped;
}

function vikunjaComment(args) {
  const taskId = parseInt(args.taskId, 10);
  const r = vikunjaCurl('PUT', `/tasks/${taskId}/comments`, { comment: args.comment });
  if (!r.ok) return r;
  return { ok: true, taskId, commentId: r.data && r.data.id, created: r.data && r.data.created };
}

function vikunjaAttachEvidence(args) {
  const taskId = parseInt(args.taskId, 10);
  const label = typeof args.label === 'string' && args.label ? ` — ${args.label}` : '';
  const r = vikunjaCurl('PUT', `/tasks/${taskId}/comments`, { comment: `EVIDENCE${label}\n\n${args.evidence}` });
  if (!r.ok) return r;
  return { ok: true, taskId, evidence: true, commentId: r.data && r.data.id, created: r.data && r.data.created };
}

function vikunjaUpdateTask(args) {
  const taskId = parseInt(args.taskId, 10);
  const fields = {};
  if (typeof args.title === 'string') fields.title = args.title;
  if (typeof args.description === 'string') fields.description = args.description;
  if (typeof args.priority === 'number') fields.priority = args.priority;
  if (typeof args.dueDate === 'string') fields.due_date = args.dueDate;
  if (!Object.keys(fields).length) {
    return { ok: false, error: 'Nothing to update — provide title, description, priority, or dueDate' };
  }
  // POST /tasks/{id} REPLACES the whole task (see utils/vikunja.js,
  // incident 2026-09-25): GET the current task, keep its writable fields
  // (assignees included), merge ours over the top. Retry the
  // read-modify-write on 5xx — Vikunja 500s under concurrent SQLite
  // writers ("database is locked"); a failed write never commits.
  const KEEP = ['title', 'description', 'done', 'due_date', 'priority', 'start_date', 'end_date', 'hex_color', 'is_favorite', 'bucket_id', 'repeat_after', 'repeat_mode'];
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = vikunjaCurl('GET', `/tasks/${taskId}`);
    if (!cur.ok) return cur;
    const keep = {};
    for (const k of KEEP) {
      if (cur.data[k] !== undefined && cur.data[k] !== null) keep[k] = cur.data[k];
    }
    if (Array.isArray(cur.data.assignees)) keep.assignees = cur.data.assignees.map(a => ({ id: a.id }));
    const r = vikunjaCurl('POST', `/tasks/${taskId}`, { ...keep, ...fields });
    if (r.ok) {
      return { ok: true, ...vikunjaShapeTask(r.data || {}), description: typeof (r.data && r.data.description) === 'string' ? r.data.description.slice(0, 20000) : '' };
    }
    last = r;
    if (!r.httpCode || r.httpCode < 500) return r;
    if (attempt < 2) { try { execFileSync('sleep', [String(0.4 * (attempt + 1))]); } catch { /* retry anyway */ } }
  }
  return last || { ok: false, error: 'Vikunja update failed' };
}

/**
 * webFetch — #807 Phase 2 (US-P2.6). urlCheck only returns a status code,
 * so agents "verified" pages they never actually read (the audit-page
 * and workshop-page failures both passed through status-only checks).
 * webFetch returns the page's readable text: scripts/styles stripped,
 * tags removed, entities decoded, capped.
 */
function webFetch(url) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'Invalid URL — must start with http:// or https://' };
  }
  try {
    const args = ['-s', '-L', '--max-redirs', '3', '--max-time', '20', '-A', 'Mozilla/5.0 (MACF agent webFetch)', '-w', '\n%{http_code}'];
    if (/localhost|127\.0\.0\.1/.test(url)) args.push('--noproxy', '*');
    args.push(url);
    const out = execFileSync('curl', args, { encoding: 'utf8', timeout: 25000, maxBuffer: 5 * 1024 * 1024 });
    const nl = out.lastIndexOf('\n');
    const code = parseInt(out.slice(nl + 1), 10);
    const html = out.slice(0, nl);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
    return { ok: code >= 200 && code < 400, httpCode: code, url, text: text.slice(0, 20000), chars: text.length };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200), url };
  }
}

// Tool registry — what agents are allowed to call. `fn` takes the args
// object (generic dispatch); `argsSchema` is the validation contract.
// An entry may carry `roles: [...]` — executeTool then refuses the call
// (errorClass 'permission', still receipted) unless ctx.agentId is listed.
const TOOLS = {
  urlCheck: {
    fn: (args) => urlCheck(args.url),
    description: 'Check if a URL is reachable. Input: {url}. Returns HTTP status and response time.',
    argsSchema: {
      type: 'object',
      properties: { url: { type: 'string', format: 'url' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  fileWrite: {
    fn: (args) => fileWrite(args.path, args.content),
    description: 'Write a file to the agent sandbox. Input: {path, content}. Path must be RELATIVE (e.g. "reports/status.txt", NOT "/abs/path/..."). Returns sandbox path.',
    argsSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  fileRead: {
    fn: (args) => fileRead(args.path),
    description: 'Read a file from the agent sandbox. Input: {path}. Path must be RELATIVE (e.g. "reports/status.txt"). Returns content.',
    argsSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  fileList: {
    fn: (args) => fileList(args.path),
    description: 'List files in the agent sandbox. Input: {path?}. Path must be RELATIVE or empty for root. Returns entries.',
    argsSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: [],
      additionalProperties: false,
    },
  },
  webFetch: {
    fn: (args) => webFetch(args.url),
    description: 'Fetch a web page and return its readable TEXT (scripts/styles stripped). Input: {url}. Use this to actually READ a page you are verifying — urlCheck only gives a status code. Returns httpCode and text.',
    argsSchema: {
      type: 'object',
      properties: { url: { type: 'string', format: 'url' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  codeRead: {
    fn: (args) => codeRead(args.path),
    roles: ['cto', 'ceo', 'execpm'],
    description: 'Read a file from the MACF tree you own (source code, engine, .state summaries). Input: {path} RELATIVE to the MACF root (e.g. "slack-agents/utils/litellm.js", "slack-agents/.state/circuit-breaker.json"). Read-only. Secret files (.env, credentials, keys) are denied. CTO/CEO/ExecPM only.',
    argsSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  pdfRead: {
    fn: (args) => pdfRead(args.path),
    description: 'Extract text from a PDF in the agent sandbox. Input: {path} RELATIVE to the sandbox (e.g. "research/product.pdf"). Returns the extracted text.',
    argsSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  wpRead: {
    fn: (args) => wpRead(args),
    roles: ['cmo', 'cto', 'ceo'],
    description: 'Read a staynalive.com WordPress page via the REST API. Input: {slug} or {id}. Returns id, slug, status, title, and the rendered content. CMO/CTO/CEO only.',
    argsSchema: {
      type: 'object',
      properties: { slug: { type: 'string' }, id: { type: 'number' } },
      required: [],
      additionalProperties: false,
    },
  },
  wpUpdate: {
    fn: (args) => wpUpdate(args),
    roles: ['cmo', 'cto', 'ceo'],
    description: 'Update a staynalive.com WordPress page via the REST API. Input: {id, content?, title?, status?}. Writes are receipted; use only with an approved change. CMO/CTO/CEO only.',
    argsSchema: {
      type: 'object',
      properties: { id: { type: 'number' }, content: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  vikunjaListTasks: {
    fn: (args) => vikunjaListTasks(args),
    roles: VIKUNJA_ROLES,
    description: 'List tasks on the Vikunja board for a project. Input: {projectId, done?, limit?} — done=false lists open tasks only, done=true completed only, omit for both. Returns id, title, done, priority, due date, assignees per task. The board credential is held server-side; never ask for or handle a token.',
    argsSchema: {
      type: 'object',
      properties: { projectId: { type: 'number' }, done: { type: 'boolean' }, limit: { type: 'number' } },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  vikunjaGetTask: {
    fn: (args) => vikunjaGetTask(args),
    roles: VIKUNJA_ROLES,
    description: 'Read one Vikunja task in full. Input: {taskId}. Returns title, description, done, priority, due date, assignees, and recent comments.',
    argsSchema: {
      type: 'object',
      properties: { taskId: { type: 'number' } },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  vikunjaComment: {
    fn: (args) => vikunjaComment(args),
    roles: VIKUNJA_ROLES,
    description: 'Post a comment on a Vikunja task. Input: {taskId, comment}. Use for triage notes, status, blockers, and handoffs — the task is the record, not chat.',
    argsSchema: {
      type: 'object',
      properties: { taskId: { type: 'number' }, comment: { type: 'string' } },
      required: ['taskId', 'comment'],
      additionalProperties: false,
    },
  },
  vikunjaUpdateTask: {
    fn: (args) => vikunjaUpdateTask(args),
    roles: VIKUNJA_ROLES,
    description: 'Update a Vikunja task. Input: {taskId, title?, description?, priority? (0-5, 5 = most urgent), dueDate? (ISO 8601)}. Only the fields you pass change; everything else, including assignees, is preserved. This tool cannot mark a task done — closure goes through the completion verifier.',
    argsSchema: {
      type: 'object',
      properties: { taskId: { type: 'number' }, title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'number' }, dueDate: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  vikunjaAttachEvidence: {
    fn: (args) => vikunjaAttachEvidence(args),
    roles: VIKUNJA_ROLES,
    description: 'Attach delivery evidence to a Vikunja task (posted as an EVIDENCE comment the completion verifier reads). Input: {taskId, evidence, label?}. Evidence must be concrete — a URL, a sandbox file path, a post id, or a measured result — not a claim that work was done.',
    argsSchema: {
      type: 'object',
      properties: { taskId: { type: 'number' }, evidence: { type: 'string' }, label: { type: 'string' } },
      required: ['taskId', 'evidence'],
      additionalProperties: false,
    },
  },
  desktopHealth: {
    fn: () => desktopHealth(),
    roles: ['cto', 'ceo'],
    description: 'Check the health of Jesse\'s desktop agent (DESKTOP-4U63DES). No input. Returns the agent health JSON. CTO/CEO only.',
    argsSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  desktopRun: {
    fn: (args) => desktopRun(args.command, args.timeoutSec),
    roles: ['cto', 'ceo'],
    description: 'Run a PowerShell command on Jesse\'s desktop (DESKTOP-4U63DES) via the desktop agent. Input: {command, timeoutSec? (5-300, default 120)}. Keep commands SMALL and BOUNDED — the desktop agent is single-threaded; never run unbounded recursive scans. Returns the command output. CTO/CEO only.',
    argsSchema: {
      type: 'object',
      properties: { command: { type: 'string' }, timeoutSec: { type: 'number' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
  slackPost: {
    fn: (args) => slackPost(args),
    roles: ['cco', 'ceo'],
    description: 'Post a message to a Slack channel as the team bot. Input: {channel (channel ID, e.g. "C0ASA532BGD" for #content — an ID, not a name), text, thread_ts? (post as a reply in that thread; a slackPost result\'s ts), mediaUrl? (http(s) URL appended to the text — use it for a Canva design URL or a credited free-stock page URL), filePath? (attach ONE file from the agent sandbox instead, sandbox-relative path; the text becomes its caption)}. Returns {ok, channel, ts} — pass the ts as thread_ts on follow-up posts to thread them. CCO/CEO only.',
    argsSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        text: { type: 'string' },
        thread_ts: { type: 'string' },
        mediaUrl: { type: 'string' },
        filePath: { type: 'string' },
      },
      required: ['channel', 'text'],
      additionalProperties: false,
    },
  },
};

// ─── Argument-schema validation (Pillar 4) ──────────────────────────────────
//
// Returns null when args are valid, or { error, correction } where the
// correction is the machine-readable object the generateWithTools loop
// branches on: { expected: {arg: 'type'}, received: [keys], missing: [keys],
// unknown: [keys], invalid?: [{key, expected, received}] }.

function validateArgs(toolName, args) {
  const tool = TOOLS[toolName];
  if (!tool || !tool.argsSchema) return null;
  const schema = tool.argsSchema;
  const props = schema.properties || {};
  const input = args && typeof args === 'object' ? args : {};
  const received = Object.keys(input);
  const missing = (schema.required || []).filter(k => input[k] === undefined);
  const unknown = schema.additionalProperties === false
    ? received.filter(k => !(k in props)) : [];
  const invalid = [];
  let formatError = null;
  for (const [key, spec] of Object.entries(props)) {
    const v = input[key];
    if (v === undefined) continue;
    if (spec.type === 'string' && typeof v !== 'string') invalid.push({ key, expected: 'string', received: typeof v });
    else if (spec.type === 'number' && typeof v !== 'number') invalid.push({ key, expected: 'number', received: typeof v });
    else if (spec.type === 'boolean' && typeof v !== 'boolean') invalid.push({ key, expected: 'boolean', received: typeof v });
    else if (spec.type === 'object' && (typeof v !== 'object' || v === null)) invalid.push({ key, expected: 'object', received: typeof v });
    if (spec.format === 'url' && typeof v === 'string' && !/^https?:\/\//i.test(v)) {
      formatError = { key, value: v };
    }
  }
  if (!missing.length && !unknown.length && !invalid.length && !formatError) return null;

  const expected = {};
  for (const [k, spec] of Object.entries(props)) {
    expected[k] = spec.format ? `${spec.type} (${spec.format})` : spec.type;
  }
  const correction = { expected, received, missing, unknown };
  if (invalid.length) correction.invalid = invalid;

  let error;
  if (formatError) {
    // Preserve the long-standing error contract: the message starts with
    // "Invalid URL" (pinned by pre-existing tests and the auditor's
    // invalid_input classification).
    error = `Invalid URL — ${JSON.stringify(formatError.value)} is not an http(s) URL for ${toolName}; expected {${formatError.key}: string (url)}, received keys: ${JSON.stringify(received)}`;
  } else {
    const parts = [];
    if (missing.length) parts.push(`missing required: ${missing.join(', ')}`);
    if (unknown.length) parts.push(`unknown args: ${unknown.join(', ')}`);
    if (invalid.length) parts.push(`wrong types: ${invalid.map(i => `${i.key} expected ${i.expected}, got ${i.received}`).join('; ')}`);
    error = `Invalid arguments for ${toolName}: ${parts.join('; ')} — expected ${JSON.stringify(expected)}, received keys: ${JSON.stringify(received)}`;
  }
  return { error, correction };
}

// ─── The choke point ────────────────────────────────────────────────────────
//
// executeTool(toolName, args, ctx) — ctx = { agentId, taskId } is optional
// and backward compatible. Dispatch is generic over the registry (no
// per-tool switch). Every exit path flows through finishExecution: log,
// auditor hook on failure, receipt — no exceptions.

function executeTool(toolName, args = {}, ctx = {}) {
  const tool = TOOLS[toolName];
  const start = Date.now();
  let result;
  if (!tool) {
    // NOTE: no early return — this result must flow through the logging +
    // auditor + receipt tail below, or hallucinated tool names would be
    // invisible (caught by tests Oct 12, 2026; #724 makes it structural).
    result = { ok: false, error: `Unknown tool: ${toolName}`, errorClass: 'unknown_tool' };
  } else if (tool.roles && !(ctx && tool.roles.includes(ctx.agentId))) {
    // Role gate (Oct 12, 2026 — #738): restricted tools (desktop channel)
    // fail closed unless the calling agent is on the entry's role list.
    // No early return — flows through the same receipt/audit tail.
    result = { ok: false, error: `Tool ${toolName} is not granted to agent '${(ctx && ctx.agentId) || 'unknown'}'`, errorClass: 'permission' };
  } else {
    const violation = validateArgs(toolName, args || {});
    if (violation) {
      result = { ok: false, error: violation.error, errorClass: 'invalid_input', correction: violation.correction };
    } else try {
      result = tool.fn(args || {});
    } catch (e) {
      result = { ok: false, error: e.message.slice(0, 200) };
    }
  }
  return finishExecution(toolName, args, ctx, result, start);
}

function finishExecution(toolName, args, ctx, result, start) {
  result = result || { ok: false, error: 'Tool returned no result' };
  result.tool = toolName;
  result.durationMs = Date.now() - start;

  // Log every tool call
  console.log(`[agentTools] ${toolName}(${JSON.stringify(args || {}).slice(0, 100)}) → ${result.ok ? 'ok' : 'fail'} (${result.durationMs}ms)`);

  // TOOL AUDITOR (Oct 12, 2026 — Vikunja #722): a failed tool call is
  // recorded, classified, and auto-fixed the second it happens. Lazy require
  // + try/catch: the auditor must never break tool execution.
  if (!result.ok) {
    try {
      require('../engine/toolUsageAuditor').recordToolEvent({
        tool: toolName, args, result,
        agentId: (ctx && ctx.agentId) || null, taskId: (ctx && ctx.taskId) || null,
      });
    } catch { /* fail-open */ }
  }

  // RECEIPT (Oct 12, 2026 — #724, Pillar 1): issued on every path. Fail-open
  // for the tool call; the ledger itself fails closed for readers.
  try {
    require('../engine/receipts').issueReceipt({
      agentId: (ctx && ctx.agentId) || null, taskId: (ctx && ctx.taskId) || null,
      tool: toolName, args: args || {}, result,
    });
  } catch { /* fail-open */ }

  return result;
}

/**
 * executeMcpTool — #807 Phase 2 (US-P2.5). Dispatch for MCP-backed tools
 * (namespaced mcp_<server>_<tool>, built by utils/mcpTools.js from
 * hands/grants.json). Async because MCP invocation is async; everything
 * else about the contract matches executeTool: the grant is re-checked
 * here at the choke point (defense in depth — the defs an agent sees
 * are already grant-filtered, but a hallucinated call must fail too),
 * and the result flows through the same finishExecution tail (log,
 * auditor, receipt).
 */
async function executeMcpTool(toolName, args = {}, ctx = {}, mcpSpec = null) {
  const start = Date.now();
  let result;
  if (!mcpSpec || !mcpSpec.server || !mcpSpec.tool) {
    result = { ok: false, error: `Unknown tool: ${toolName}`, errorClass: 'unknown_tool' };
  } else {
    let granted = false;
    try {
      granted = require('./mcpTools').grantedServers(ctx && ctx.agentId).includes(mcpSpec.server);
    } catch { granted = false; }
    if (!granted) {
      result = { ok: false, error: `MCP server '${mcpSpec.server}' is not granted to agent '${(ctx && ctx.agentId) || 'unknown'}'`, errorClass: 'permission' };
    } else {
      try {
        const mcpClient = require('../engine/mcpClient');
        const raw = await mcpClient.invokeTool(mcpSpec.server, mcpSpec.tool, args || {});
        const parts = (raw && Array.isArray(raw.content)) ? raw.content : [];
        const text = parts.filter(p => p && p.type === 'text').map(p => p.text).join('\n');
        const grants = require('./mcpTools').loadGrants();
        const cap = (grants.defaults && grants.defaults.max_tool_output_chars) || 8000;
        result = {
          ok: !(raw && raw.isError),
          output: (text || JSON.stringify(raw || {})).slice(0, cap),
          mcp: { server: mcpSpec.server, tool: mcpSpec.tool },
        };
        if (!result.ok) result.error = result.output.slice(0, 300) || 'MCP tool returned an error';
      } catch (e) {
        result = { ok: false, error: e.message.slice(0, 300), errorClass: 'mcp_error' };
      }
    }
  }
  return finishExecution(toolName, args, ctx, result, start);
}

/**
 * Get tool descriptions for inclusion in agent prompts.
 */
function getToolDescriptions() {
  return Object.entries(TOOLS)
    .map(([name, t]) => `- ${name}: ${t.description}`)
    .join('\n');
}

module.exports = {
  executeTool,
  executeMcpTool,
  getToolDescriptions,
  validateArgs,
  TOOLS,
  SANDBOX,
  // test hooks
  _DESKTOP_RUN_CLIENT: DESKTOP_RUN_CLIENT,
};
