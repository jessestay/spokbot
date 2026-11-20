'use strict';
/**
 * US-122 — Agent demos relayed to Jesse (F9).
 *
 * Story: As Jesse, I want every agent to produce visible demos that
 * are relayed to me after the agent demos to the CEO, so that silence
 * from any agent is treated as breakage, not as a quiet week.
 * AC1: Given an agent completes demonstrable work, When the hourly
 * demo check runs, Then a qualifying demo (label, link, task
 * reference) is relayed to me, and an agent with no qualifying demo
 * in the window is flagged by name.
 *
 * Qualification is receipt-based (demoRelay.demoForTask): a demo
 * exists iff the receipts ledger holds, within the window, an
 * artifact receipt for the task — and a file artifact must still
 * exist with a matching hash at relay time. The relay line is
 * formatted from receipt fields only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

jest.mock('../receipts', () => ({ artifactsForTask: jest.fn() }));
const receipts = require('../receipts');
const { demoForTask, formatRelayLine } = require('../demoRelay');

const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let artifactFile;
beforeAll(() => {
  artifactFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'macf-us122-')), 'demo.md');
  fs.writeFileSync(artifactFile, 'demo body');
});
beforeEach(() => { receipts.artifactsForTask.mockReset(); });

describe('US-122 demo relay — qualification', () => {
  test('a live file artifact receipt in the window qualifies, with label/link/task from the receipt', () => {
    receipts.artifactsForTask.mockReturnValue([
      { kind: 'file', ref: artifactFile, sha256: sha('demo body'), agentId: 'cto', receiptId: 'r-1', ts: now() },
    ]);
    const res = demoForTask(761, { windowHours: 24 });
    expect(res.qualifies).toBe(true);
    expect(res.demo).toMatchObject({
      taskId: 761, agent: 'cto', artifactKind: 'file',
      artifactRef: artifactFile, receiptId: 'r-1', label: '[FYI]',
    });
    const line = formatRelayLine(res.demo);
    expect(line).toContain('[RELAY-DEMO] [FYI] | cto | task #761');
    expect(line).toContain(artifactFile);
    expect(line).toContain('receipt r-1');
  });

  test('a slack_message artifact qualifies without any file check', () => {
    receipts.artifactsForTask.mockReturnValue([
      { kind: 'slack_message', ref: 'C0ASA532BGD:1799000000.000100', agentId: 'cco', receiptId: 'r-2', ts: now() },
    ]);
    const res = demoForTask(925, { windowHours: 24 });
    expect(res.qualifies).toBe(true);
    expect(res.demo.agent).toBe('cco');
  });

  test('no artifact receipt in the window: does not qualify — silence is flagged, not quiet', () => {
    receipts.artifactsForTask.mockReturnValue([
      { kind: 'file', ref: artifactFile, sha256: sha('demo body'), agentId: 'cmo', receiptId: 'r-3', ts: new Date(Date.now() - 48 * 3600e3).toISOString() },
    ]);
    const res = demoForTask(555, { windowHours: 24 });
    expect(res.qualifies).toBe(false);
    expect(res.reason).toMatch(/no artifact receipt/);
  });

  test('an artifact deleted since its receipt fails re-verification and does not qualify', () => {
    receipts.artifactsForTask.mockReturnValue([
      { kind: 'file', ref: path.join(os.tmpdir(), 'macf-us122-gone.md'), agentId: 'cfo', receiptId: 'r-4', ts: now() },
    ]);
    const res = demoForTask(556, { windowHours: 24 });
    expect(res.qualifies).toBe(false);
    expect(res.reason).toMatch(/file missing/);
    expect(res.staleReceipt.receiptId).toBe('r-4');
  });

  test('an artifact changed since its receipt (hash mismatch) does not qualify', () => {
    receipts.artifactsForTask.mockReturnValue([
      { kind: 'file', ref: artifactFile, sha256: sha('original body'), agentId: 'cfo', receiptId: 'r-5', ts: now() },
    ]);
    const res = demoForTask(557, { windowHours: 24 });
    expect(res.qualifies).toBe(false);
    expect(res.reason).toMatch(/hash mismatch/);
  });

  test('non-artifact receipt kinds never qualify a demo', () => {
    receipts.artifactsForTask.mockReturnValue([
      { kind: 'tool_call', ref: 'x', agentId: 'cto', receiptId: 'r-6', ts: now() },
    ]);
    expect(demoForTask(558, { windowHours: 24 }).qualifies).toBe(false);
  });
});
