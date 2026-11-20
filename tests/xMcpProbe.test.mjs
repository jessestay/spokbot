// US-FW-016 / F12 Step D — x-mcp probe + tool-shape tests.
//
// x-mcp/ is the first-party X (Twitter) MCP server the grants file
// spawns as `node $SPOKBOT_ROOT/x-mcp/dist/index.js`. It had no
// tests. These probes spawn the REAL built server (dist/, the
// artifact grants actually runs) and drive it over stdio
// JSON-RPC, pinning only behavior read from src/index.ts:
//
//   - fail-closed startup: the five required env vars are demanded
//     in construction order (X_API_KEY, X_API_SECRET,
//     X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET, X_BEARER_TOKEN); the
//     first missing one aborts startup, exit 1, naming the var;
//   - with (dummy) credentials present it serves as "x-mcp" 1.0.0
//     and lists exactly the 19 tools src/index.ts registers, in
//     registration order (the same count US-FW-033 measured live
//     on staging during the Step 5 cutover);
//   - two purely local tool validations that never reach the X
//     API: get_user with neither identifier, and get_tweet with an
//     unparseable ID (parseTweetId).
//
// No probe calls the X API: dummy credentials would fail auth at
// the network leg, and live calls are the connectivity suites'
// job (US-FW-016), not a shape probe's.
//
// Prerequisite: x-mcp/node_modules must be installed (npm install
// in x-mcp/, per its package.json) — a bare checkout cannot start
// the server at all; the first test names that plainly if absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const XMCP_DIR = path.join(ROOT, 'x-mcp');
const ENTRY = path.join(XMCP_DIR, 'dist', 'index.js');

const DUMMY_ENV = {
  X_API_KEY: 'probe', X_API_SECRET: 'probe', X_ACCESS_TOKEN: 'probe',
  X_ACCESS_TOKEN_SECRET: 'probe', X_BEARER_TOKEN: 'probe',
};

function startServer(extraEnv) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv };
  const child = spawn('node', [ENTRY], { cwd: XMCP_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let buf = '';
  const pending = new Map();
  const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out; stderr: ${stderr.slice(-300)}`)), 8000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  return {
    request,
    exitPromise,
    stderr: () => stderr,
    stop: () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } },
    async initialize() {
      const res = await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'x-mcp-probe', version: '0.1.0' },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return res;
    },
  };
}

test('prerequisite: the built server and its dependencies are present', () => {
  assert.ok(fs.existsSync(ENTRY), 'x-mcp/dist/index.js missing — run the x-mcp build (tsc)');
  assert.ok(fs.existsSync(path.join(XMCP_DIR, 'node_modules', '@modelcontextprotocol', 'sdk')),
    'x-mcp/node_modules missing — run npm install in x-mcp/ (its package.json declares the deps)');
});

test('startup refuses without credentials, naming the first missing var (X_API_KEY)', async () => {
  const s = startServer({});
  const code = await s.exitPromise;
  assert.equal(code, 1);
  assert.match(s.stderr(), /Missing required environment variable: X_API_KEY/);
});

test('startup demands the vars in order: with only X_API_KEY set, X_API_SECRET is named', async () => {
  const s = startServer({ X_API_KEY: 'probe' });
  const code = await s.exitPromise;
  assert.equal(code, 1);
  assert.match(s.stderr(), /Missing required environment variable: X_API_SECRET/);
});

test('serves as x-mcp 1.0.0 and lists exactly the 19 registered tools in order', async () => {
  const s = startServer(DUMMY_ENV);
  try {
    const init = await s.initialize();
    assert.deepEqual(init.result.serverInfo, { name: 'x-mcp', version: '1.0.0' });
    const list = await s.request('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name), [
      'post_tweet', 'reply_to_tweet', 'quote_tweet', 'delete_tweet', 'get_tweet',
      'search_tweets', 'get_user', 'get_timeline', 'get_mentions', 'get_followers',
      'get_following', 'like_tweet', 'retweet', 'setup_oauth2', 'get_bookmarks',
      'bookmark_tweet', 'unbookmark_tweet', 'upload_media', 'get_metrics',
    ]);
    const post = list.result.tools.find((t) => t.name === 'post_tweet');
    assert.ok(post.inputSchema.required.includes('text'));
    const get = list.result.tools.find((t) => t.name === 'get_tweet');
    assert.ok(get.inputSchema.required.includes('tweet_id'));
  } finally {
    s.stop();
  }
});

test('get_user with neither username nor user_id is a local error (no API call)', async () => {
  const s = startServer(DUMMY_ENV);
  try {
    await s.initialize();
    const res = await s.request('tools/call', { name: 'get_user', arguments: {} });
    assert.equal(res.result.isError, true);
    assert.equal(res.result.content[0].text, 'Error: Provide either username or user_id');
  } finally {
    s.stop();
  }
});

test('get_tweet with an unparseable ID is a local parse error (no API call)', async () => {
  const s = startServer(DUMMY_ENV);
  try {
    await s.initialize();
    const res = await s.request('tools/call', { name: 'get_tweet', arguments: { tweet_id: 'not-a-tweet' } });
    assert.equal(res.result.isError, true);
    assert.equal(res.result.content[0].text, 'Error: Invalid tweet ID or URL: not-a-tweet');
  } finally {
    s.stop();
  }
});
