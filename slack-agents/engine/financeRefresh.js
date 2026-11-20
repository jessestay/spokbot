'use strict';

// FINANCE REFRESH — cadence step for the Finance Repeat (CEO-built
// Nov 11, 2026, ticket #986 follow-up / verification function F5).
//
// Why this exists: plaid-balances.json is re-dropped daily by the
// finance-snapshot-publisher with a fresh asOf, so balances never go
// stale. obligations.json and income-ledger.jsonl had NO cadence:
// they are written only when an agent happens to record a new fact
// through the finance-files MCP write tools, so financeCheck's 36h
// mtime staleness flag tripped 36h after the last manual recording
// (the Nov 9, 2026 backfill) and could never clear on its own.
//
// This script is the obligations/income counterpart of the daily
// balance drop. It runs as ExecStartPre of macf-finance-check.service
// (systemd drop-in refresh.conf), i.e. before every check run (the
// twice-daily timer plus the balances path hook). It VALIDATES the
// recorded inputs and, only if they pass, attests the exact bytes
// validated:
//   - obligations.json: top-level "asOf" set to now (atomic rewrite,
//     all recorded content preserved).
//   - income-ledger.jsonl: append-only, never rewritten; a sidecar
//     income-asof.json records {asOf, sha256, entries} for the exact
//     ledger bytes validated.
// financeCheck credits an input as fresh when either its mtime or its
// attestation is within 36h (for income, the sidecar counts only
// while its sha256 still matches the ledger on disk). If validation
// fails, this script exits 1, stamps nothing, and the stale flags
// stand — an attestation can never certify bytes that failed
// validation, and if this cadence itself stops running, the
// attestations age out and the STALE flags return.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIN_DIR = process.env.FINANCE_DIR
  ? path.resolve(process.env.FINANCE_DIR)
  : path.join(__dirname, '..', '..', 'engine-home', 'workspace', 'agent-sandbox', 'finance');

function writeAtomic(p, content) {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}

function fail(msg) {
  console.error(`[financeRefresh] INVALID: ${msg}`);
  try {
    fs.writeFileSync(path.join(FIN_DIR, 'finance-refresh-state.json'),
      JSON.stringify({ lastResult: 'invalid', error: msg, at: new Date().toISOString() }, null, 2) + '\n');
  } catch { /* the state file is best-effort; the exit code is the signal */ }
  return 1;
}

function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
}

function validateObligations(data) {
  if (!data || !Array.isArray(data.obligations)) return 'obligations.json: no obligations array';
  for (const o of data.obligations) {
    if (!o || typeof o.name !== 'string' || !o.name.trim()) return 'obligations.json: an entry is missing its name';
    if (typeof o.amount !== 'number' || !Number.isFinite(o.amount)) return `obligations.json: "${o.name}" amount is not a finite number`;
    if (!validDate(o.due)) return `obligations.json: "${o.name}" due is not a valid YYYY-MM-DD date`;
  }
  return null;
}

function main() {
  const asOf = new Date().toISOString();

  let obligationsRaw;
  try { obligationsRaw = fs.readFileSync(path.join(FIN_DIR, 'obligations.json'), 'utf8'); }
  catch (e) { return fail(`obligations.json unreadable: ${e.message}`); }
  let obligations;
  try { obligations = JSON.parse(obligationsRaw); }
  catch (e) { return fail(`obligations.json does not parse: ${e.message}`); }
  const obErr = validateObligations(obligations);
  if (obErr) return fail(obErr);

  let incomeRaw;
  try { incomeRaw = fs.readFileSync(path.join(FIN_DIR, 'income-ledger.jsonl'), 'utf8'); }
  catch (e) { return fail(`income-ledger.jsonl unreadable: ${e.message}`); }
  const incomeLines = incomeRaw.split('\n').filter(l => l.trim());
  for (const line of incomeLines) {
    let entry;
    try { entry = JSON.parse(line); } catch { return fail('income-ledger.jsonl: a line does not parse as JSON'); }
    if (!validDate(entry.date)) return fail('income-ledger.jsonl: an entry has an invalid date');
    if (typeof entry.source !== 'string' || !entry.source.trim()) return fail('income-ledger.jsonl: an entry is missing its source');
    if (typeof entry.amount !== 'number' || !Number.isFinite(entry.amount)) return fail('income-ledger.jsonl: an entry amount is not a finite number');
    if (typeof entry.status !== 'string' || !entry.status.trim()) return fail('income-ledger.jsonl: an entry is missing its status');
  }

  // Validation passed — attest the exact bytes validated.
  obligations.asOf = asOf;
  writeAtomic(path.join(FIN_DIR, 'obligations.json'), JSON.stringify(obligations, null, 2) + '\n');
  const incomeSha = crypto.createHash('sha256').update(incomeRaw).digest('hex');
  writeAtomic(path.join(FIN_DIR, 'income-asof.json'),
    JSON.stringify({ asOf, sha256: incomeSha, entries: incomeLines.length }, null, 2) + '\n');
  fs.writeFileSync(path.join(FIN_DIR, 'finance-refresh-state.json'),
    JSON.stringify({ lastResult: 'ok', at: asOf, obligations: obligations.obligations.length, incomeEntries: incomeLines.length }, null, 2) + '\n');
  console.log(`[financeRefresh] ${asOf}: validated + attested obligations (${obligations.obligations.length}) and income ledger (${incomeLines.length} entries, sha256 ${incomeSha.slice(0, 12)})`);
  return 0;
}

if (require.main === module) {
  try { process.exit(main()); } catch (e) { console.error('[financeRefresh] fatal:', e.message); process.exit(1); }
}

module.exports = { validateObligations };
