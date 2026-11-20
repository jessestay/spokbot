// Stub Vikunja server for kernel-p3-vikunja-tool.test.js — runs as a CHILD
// process (the tool under test calls curl via execFileSync, which blocks
// the parent event loop; an in-process stub would deadlock). Prints
// PORT=<n>; every request overwrites the VIK_STUB_LAST file with JSON
// { method, url, auth, body } so the parent test can assert on them.
// Enforces the bearer token the test configures: wrong/absent auth -> 401.
const http = require('http');
const fs = require('fs');

const lastFile = process.env.VIK_STUB_LAST;
const EXPECTED_AUTH = 'Bearer test-token-123';

const TASK_834 = {
  id: 834,
  title: '[execPM] OVERNIGHT: 24/7 backlog burn-down',
  description: 'Full brief here',
  done: false,
  priority: 5,
  due_date: null,
  project_id: 2,
  assignees: [{ id: 2, username: 'execpm' }],
  created: '2026-10-21T06:44:27Z',
  updated: '2026-10-21T06:44:27Z',
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (lastFile) fs.writeFileSync(lastFile, JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization || null, body }));
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== EXPECTED_AUTH) {
      res.statusCode = 401;
      res.end(JSON.stringify({ message: 'invalid token' }));
      return;
    }
    const url = req.url;
    if (req.method === 'GET' && /^\/api\/v1\/projects\/2\/tasks/.test(url)) {
      res.end(JSON.stringify([TASK_834, { id: 835, title: 'Retro item', done: true, priority: 3, due_date: null, project_id: 2, assignees: [], created: '2026-10-21T10:21:02Z', updated: '2026-10-21T10:21:02Z' }]));
    } else if (req.method === 'GET' && url === '/api/v1/tasks/834') {
      res.end(JSON.stringify(TASK_834));
    } else if (req.method === 'GET' && url === '/api/v1/tasks/834/comments') {
      res.end(JSON.stringify([{ id: 55, author: { username: 'ceo' }, created: '2026-10-21T06:50:00Z', comment: 'earlier note' }]));
    } else if (req.method === 'PUT' && url === '/api/v1/tasks/834/comments') {
      const parsed = JSON.parse(body || '{}');
      res.end(JSON.stringify({ id: 999, created: '2026-10-21T14:00:00Z', comment: parsed.comment }));
    } else if (req.method === 'POST' && url === '/api/v1/tasks/834') {
      const parsed = JSON.parse(body || '{}');
      res.end(JSON.stringify({ ...parsed, id: 834, project_id: 2, created: TASK_834.created, updated: '2026-10-21T14:05:00Z' }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: 'not found' }));
    }
  });
});
server.listen(0, '127.0.0.1', () => { console.log(`PORT=${server.address().port}`); });
