'use strict';

// FINANCE REPEAT — check script (CEO-built Oct 23, 2026, on Jesse's
// order: "a loop, with a hook that runs a script to check all recorded
// financial sources, income, and expenses").
//
// Deterministic, no LLM. Reads the RECORDED financial sources in the
// agent sandbox finance/ folder:
//   - plaid-balances.json  (dropped by the CEO's daily Plaid publisher;
//                           the systemd .path hook fires this script
//                           the moment a fresh drop lands)
//   - obligations.json     (recorded expenses/bills with due dates)
//   - income-ledger.jsonl  (recorded income: received + in transit)
// Recomputes the position and REWRITES the shared outputs:
//   - finance-snapshot.md  (the CFO's source — now system-generated)
//   - finance-flags.json   (machine flags for the manager standup)
// Loop: systemd timer twice daily. Hook: systemd path unit on
// plaid-balances.json. The CFO consumes; the CEO publishes balances;
// agents record obligations/income as they learn them. Nobody types a
// balance by hand ever again.
//
// Freshness of obligations/income (Nov 11, 2026, #986 follow-up):
// engine/financeRefresh.js runs before every check (ExecStartPre
// drop-in on macf-finance-check.service), validates the recorded
// inputs, and attests the exact bytes it validated (obligations.json
// top-level "asOf"; income-asof.json sidecar carrying the ledger's
// sha256). An input counts as fresh when either its mtime or its
// attestation is within the 36h limit; the income sidecar counts
// only while its sha256 still matches the ledger on disk, so any
// append after an attestation re-arms the mtime clock until the
// next refresh. If the refresh cadence stops, the attestations age
// out and the STALE flags return.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIN_DIR = path.join(__dirname, '..', '..', 'engine-home', 'workspace', 'agent-sandbox', 'finance');

function readJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(FIN_DIR, name), 'utf8')); } catch { return null; }
}

function readJsonl(name) {
  try {
    return fs.readFileSync(path.join(FIN_DIR, name), 'utf8')
      .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  } catch { return []; }
}

function fileAgeHours(name, now) {
  try { return (now.getTime() - fs.statSync(path.join(FIN_DIR, name)).mtimeMs) / 3600000; } catch { return null; }
}

function denverToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function daysUntil(dateStr, todayStr) {
  const a = Date.parse(`${todayStr}T12:00:00Z`);
  const b = Date.parse(`${String(dateStr).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function check({ balances, obligations, income, inputAges = {}, rawAges = {}, now = new Date() }) {
  const today = denverToday();
  const flags = [];
  const accounts = (balances && balances.accounts) || [];
  const net = accounts.reduce((n, a) => n + (typeof a.current === 'number' ? a.current : 0), 0);
  const balAgeH = balances && balances.asOf
    ? (now.getTime() - Date.parse(balances.asOf)) / 3600000 : Infinity;
  if (!balances) flags.push({ kind: 'NO_BALANCE_DATA', detail: 'plaid-balances.json missing' });
  else if (balAgeH > 36) flags.push({ kind: 'STALE_BALANCES', detail: `balances are ${Math.round(balAgeH)}h old (limit 36h)` });
  const staleInputs = [
    ['obligations.json', 'STALE_OBLIGATIONS', inputAges.obligations],
    ['income-ledger.jsonl', 'STALE_INCOME_LEDGER', inputAges.income],
  ];
  for (const [file, kind, ageH] of staleInputs) {
    if (typeof ageH === 'number' && ageH > 36) {
      flags.push({ kind, detail: `${file} is ${Math.round(ageH)}h old (limit 36h)` });
    }
  }
  // Source-data age (#1107): the attestation above certifies that the
  // recorded bytes are VALID, not that the data is CURRENT. An
  // append-only source whose raw mtime passes the 36h limit is flagged
  // on its own age even while its attestation is fresh, so a fresh
  // attestation can no longer launder stale source data.
  const staleSources = [
    ['obligations.json', 'STALE_OBLIGATIONS_SOURCE', rawAges.obligations],
    ['income-ledger.jsonl', 'STALE_INCOME_SOURCE', rawAges.income],
  ];
  for (const [file, kind, ageH] of staleSources) {
    if (typeof ageH === 'number' && ageH > 36) {
      flags.push({ kind, detail: `${file} source data is ${Math.round(ageH)}h old (limit 36h; attestation validates bytes, not currency)` });
    }
  }
  for (const a of accounts) {
    if (typeof a.current === 'number' && a.current < 0) {
      flags.push({ kind: 'NEGATIVE_ACCOUNT', detail: `${a.name} (${a.mask || '????'}): $${a.current.toFixed(2)}` });
    }
  }
  const obs = (obligations && obligations.obligations) || [];
  let due14 = 0;
  for (const o of obs) {
    if (o.paid) continue;
    const d = daysUntil(o.due, today);
    if (d === null) continue;
    if (d < 0) flags.push({ kind: 'OVERDUE', detail: `${o.name}: $${o.amount} was due ${o.due}` });
    else if (d <= 5) flags.push({ kind: o.hard ? 'HARD_DEADLINE' : 'DUE_SOON', detail: `${o.name}: $${o.amount} due ${o.due} (${d}d)` });
    if (d <= 14) due14 += o.amount || 0;
  }
  const received30 = (income || [])
    .filter(i => i.status === 'received' && daysUntil(i.date, today) !== null && daysUntil(i.date, today) >= -30 && daysUntil(i.date, today) <= 0)
    .reduce((n, i) => n + (i.amount || 0), 0);
  const inTransit = (income || []).filter(i => i.status === 'in_transit' || i.status === 'requested');
  return { today, net, balAgeH, due14, received30, inTransit, flags, accounts, obligations: obs };
}

function renderSnapshot(r, balances) {
  const L = [];
  L.push('# Finance snapshot — generated by the Finance Repeat check script');
  L.push('');
  L.push(`**As of: ${r.today} (Denver). Balances as of: ${balances ? balances.asOf : 'NO DATA'}. Sources: plaid-balances.json, obligations.json, income-ledger.jsonl in this folder — recorded data only; the script invents nothing. Anything older than 36 hours is stale and flagged.**`);
  L.push('');
  L.push('## Cash (recorded balances)');
  for (const a of r.accounts) L.push(`- ${a.name} (${a.mask || '????'}): **$${(a.current || 0).toFixed(2)}**`);
  L.push(`- **Net cash: $${r.net.toFixed(2)}**`);
  L.push('');
  L.push('## Recorded obligations (unpaid, by due date)');
  const obs = [...r.obligations].filter(o => !o.paid).sort((a, b) => String(a.due).localeCompare(String(b.due)));
  for (const o of obs) L.push(`- ${o.due}: ${o.name} — $${o.amount}${o.hard ? ' — HARD DEADLINE' : ''}${o.note ? ` (${o.note})` : ''}`);
  L.push(`- **Total due in the next 14 days: $${r.due14.toFixed(2)}**`);
  L.push('');
  L.push('## Income (recorded)');
  L.push(`- Received in the last 30 days: $${r.received30.toFixed(2)}`);
  for (const i of r.inTransit) L.push(`- ${i.status}: ${i.source} $${i.amount}${i.note ? ` (${i.note})` : ''}`);
  L.push('');
  L.push('## Flags');
  if (!r.flags.length) L.push('- none');
  for (const f of r.flags) L.push(`- ${f.kind}: ${f.detail}`);
  L.push('');
  L.push('## Standing rules');
  L.push('- NO new monthly expenses until income lands. Nobody moves money, pays a bill, or contacts a creditor without Jesse\'s explicit approval of the exact action.');
  L.push('- When a recorded source and a live claim disagree, the recorded source loses: re-record from the live source and let the check re-run.');
  return L.join('\n') + '\n';
}

function attestedAgeHours(data, now) {
  // Age in hours of an in-file/sidecar "asOf" attestation written by
  // financeRefresh.js after validation. null when unusable; a
  // future-dated asOf (clock skew) counts as 0.
  if (!data || typeof data.asOf !== 'string') return null;
  const t = Date.parse(data.asOf);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (now.getTime() - t) / 3600000);
}

function effectiveObligationsAgeH(obligationsData, now) {
  const ages = [fileAgeHours('obligations.json', now), attestedAgeHours(obligationsData, now)]
    .filter(a => typeof a === 'number');
  return ages.length ? Math.min(...ages) : null;
}

function effectiveIncomeAgeH(now) {
  const ages = [fileAgeHours('income-ledger.jsonl', now)];
  try {
    const sidecar = readJson('income-asof.json');
    const raw = fs.readFileSync(path.join(FIN_DIR, 'income-ledger.jsonl'), 'utf8');
    const sha = crypto.createHash('sha256').update(raw).digest('hex');
    if (sidecar && sidecar.sha256 === sha) {
      const a = attestedAgeHours(sidecar, now);
      if (typeof a === 'number') ages.push(a);
    }
  } catch { /* no usable sidecar -> mtime only */ }
  const nums = ages.filter(a => typeof a === 'number');
  return nums.length ? Math.min(...nums) : null;
}

function main() {
  const balances = readJson('plaid-balances.json');
  const obligations = readJson('obligations.json');
  const income = readJsonl('income-ledger.jsonl');
  const now = new Date();
  const inputAges = {
    obligations: effectiveObligationsAgeH(obligations, now),
    income: effectiveIncomeAgeH(now),
  };
  const rawAges = {
    obligations: fileAgeHours('obligations.json', now),
    income: fileAgeHours('income-ledger.jsonl', now),
  };
  const r = check({ balances, obligations, income, inputAges, rawAges, now });
  fs.mkdirSync(FIN_DIR, { recursive: true });
  fs.writeFileSync(path.join(FIN_DIR, 'finance-snapshot.md'), renderSnapshot(r, balances));
  fs.writeFileSync(path.join(FIN_DIR, 'finance-flags.json'), JSON.stringify({ asOf: new Date().toISOString(), net: r.net, due14: r.due14, flags: r.flags }, null, 2));
  console.log(`[financeCheck] ${r.today}: net $${r.net.toFixed(2)}, due14 $${r.due14.toFixed(2)}, flags: ${r.flags.map(f => f.kind).join(', ') || 'none'}`);
  return 0;
}

if (require.main === module) {
  try { process.exit(main()); } catch (e) { console.error('[financeCheck] fatal:', e.message); process.exit(1); }
}

module.exports = { check, renderSnapshot, daysUntil, attestedAgeHours, effectiveObligationsAgeH, effectiveIncomeAgeH, fileAgeHours };
