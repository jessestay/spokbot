// Step 5 attempt-4 fix — rename-proof atomic saves (runbook F11 / P6 §G).
// Dependency-free (node:test). Run: node --test tests/
//
// Attempt 3 (2026-11-18) rolled back at W7(d): directiveState.savePollState
// saved via tmp+rename, and a rename over the F11 symlink at
// engine/.directive-poll-state.json replaced the symlink itself with a
// regular file, forking the staged engine's poll state from production's.
// The fix resolves the target's realpath before creating the tmp file, so
// the rename lands on the real target and any symlink at the configured
// path survives. These tests pin that behavior:
//   (a) a save through a symlinked path leaves the symlink intact
//   (b) the saved content lands on the link target
//   (c) a save to a non-symlinked path behaves exactly as before
//   (d) a save when the target does not exist yet still works
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { savePollState, loadPollState, STATE_FILE_MODE } = require(
  path.join(ROOT, 'slack-agents', 'engine', 'directiveState.js')
);

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'spokbot-rename-')); }

test('(a) save through a symlinked path leaves the symlink intact', () => {
  const dir = tmpDir();
  const realDir = path.join(dir, 'real');
  const linkDir = path.join(dir, 'link');
  fs.mkdirSync(realDir);
  fs.mkdirSync(linkDir);
  const realFile = path.join(realDir, '.directive-poll-state.json');
  fs.writeFileSync(realFile, JSON.stringify({ v: 1 }), 'utf8');
  const linkPath = path.join(linkDir, '.directive-poll-state.json');
  fs.symlinkSync(realFile, linkPath);

  savePollState({ v: 2 }, linkPath);

  const st = fs.lstatSync(linkPath);
  assert.ok(st.isSymbolicLink(), 'configured path must still be a symlink after save');
  assert.equal(fs.readlinkSync(linkPath), realFile, 'symlink target must be unchanged');
  assert.equal(fs.realpathSync(linkPath), realFile);
});

test('(b) saved content lands on the link target', () => {
  const dir = tmpDir();
  const realFile = path.join(dir, 'prod.json');
  fs.writeFileSync(realFile, JSON.stringify({ v: 1 }), 'utf8');
  const linkPath = path.join(dir, 'staged.json');
  fs.symlinkSync(realFile, linkPath);

  savePollState({ v: 2, marker: 'through-the-link' }, linkPath);

  const onTarget = JSON.parse(fs.readFileSync(realFile, 'utf8'));
  assert.deepEqual(onTarget, { v: 2, marker: 'through-the-link' });
  assert.deepEqual(loadPollState(linkPath), { v: 2, marker: 'through-the-link' });
  // No tmp litter beside either path.
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
});

test('(c) save to a non-symlinked path behaves exactly as before', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'plain.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1 }), 'utf8');
  const inoBefore = fs.statSync(file).ino;

  const out = savePollState({ v: 3 }, file);

  assert.deepEqual(out, { v: 3 }, 'savePollState returns the state');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 3 });
  assert.ok(!fs.lstatSync(file).isSymbolicLink());
  // Atomic replace still swaps the inode (tmp+rename semantics preserved).
  assert.notEqual(fs.statSync(file).ino, inoBefore);
  // The two-user handoff mode contract is preserved.
  assert.equal(fs.statSync(file).mode & 0o777, STATE_FILE_MODE & 0o777);
});

test('(d) save when the target does not exist yet still works', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'fresh.json');
  assert.ok(!fs.existsSync(file));

  savePollState({ created: true }, file);

  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { created: true });
  assert.deepEqual(loadPollState(file), { created: true });
});

test('(d2) save through a dangling symlink creates the target and keeps the link', () => {
  const dir = tmpDir();
  const realFile = path.join(dir, 'not-yet.json');
  const linkPath = path.join(dir, 'dangling.json');
  fs.symlinkSync(realFile, linkPath);
  assert.ok(!fs.existsSync(realFile));

  savePollState({ born: 1 }, linkPath);

  assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), 'link must survive first save');
  assert.deepEqual(JSON.parse(fs.readFileSync(realFile, 'utf8')), { born: 1 });
});
