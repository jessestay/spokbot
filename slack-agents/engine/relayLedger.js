'use strict';

// CEO RELAY LEDGER (Nov 11, 2026 — Vikunja #960/#972).
//
// The house rule (AGENTS.md, Build 8b): a completed agent directive whose
// reply is addressed to the CEO is relay debt until the CEO presents it to
// Jesse; managerStandup lists the uncleared packages (72h window, >200
// chars of substance) as CEO RELAY DEBT and the CEO clears a record's key
// in .state/ceo-relay-cleared.json when presented.
//
// The defect this fixes: the debt was computed only inside the standup
// text at post time. No persistent ledger existed, so the verification
// audit could not check it — relay debt was "unverifiable" (#960/#972) —
// and anything older than the standup's 72h window silently fell off the
// list without ever being cleared.
//
// This script reuses managerStandup.relayDebt() verbatim (same intake
// records, same cleared-key semantics, same >200-char substance rule) and
// writes .state/relay-ledger.json with BOTH views:
//   - window:   the house-rule 72h list, exactly as the standup shows it
//   - allTime:  every uncleared qualifying package, no window — nothing
//               expires unverified; clearing still happens only via
//               .state/ceo-relay-cleared.json
// Read-only except its own output file. Safe to run every verification
// run:  node engine/relayLedger.js

const fs = require('fs');
const path = require('path');
const { relayDebt } = require('./managerStandup');

const WINDOW_MS = 72 * 3600 * 1000;

function intakeDir() {
  return path.join(__dirname, '..', '.state', 'directive-intake');
}
function clearedFile() {
  return path.join(__dirname, '..', '.state', 'ceo-relay-cleared.json');
}
function outFile() {
  return path.join(__dirname, '..', '.state', 'relay-ledger.json');
}

function loadIntakeRecords(dir = intakeDir()) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function loadCleared(file = clearedFile()) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function enrich(debtItems, records, nowMs) {
  const byKey = new Map();
  for (const r of records || []) {
    if (r && r.channel && r.ts) byKey.set(`${r.channel}:${r.ts}`, r);
  }
  return debtItems.map(d => {
    const rec = byKey.get(`C0ASH4TF604:${d.ts}`) || [...byKey.values()].find(r => r.ts === d.ts) || {};
    const when = Date.parse(rec.replyPostedAt || rec.registeredAt || '') || 0;
    return {
      key: `${rec.channel || 'C0ASH4TF604'}:${d.ts}`,
      agentId: d.agentId,
      ts: d.ts,
      chars: d.chars,
      postedAt: when ? new Date(when).toISOString() : null,
      ageHours: when ? Math.round(((nowMs - when) / 3600000) * 10) / 10 : null,
    };
  }).sort((a, b) => (a.postedAt || '').localeCompare(b.postedAt || ''));
}

function buildLedger(nowMs = Date.now()) {
  const records = loadIntakeRecords();
  const cleared = loadCleared();
  const windowItems = enrich(relayDebt(records, cleared, nowMs, WINDOW_MS), records, nowMs);
  const allTimeItems = enrich(relayDebt(records, cleared, nowMs, Number.POSITIVE_INFINITY), records, nowMs);
  const oldest = allTimeItems.length ? allTimeItems[0] : null;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    rule: 'Completed directive replies addressed to the CEO ([from: <agent> -> CEO], >200 chars of substance) are relay debt until their key (channel:ts) is recorded in .state/ceo-relay-cleared.json. Window view = house-rule 72h; allTime view = no window, nothing expires uncleared.',
    intakeRecords: records.length,
    clearedKeys: Array.isArray(cleared) ? cleared.length : 0,
    windowHours: 72,
    windowCount: windowItems.length,
    allTimeCount: allTimeItems.length,
    oldestUncleared: oldest,
    window: windowItems,
    allTime: allTimeItems,
  };
}

function main() {
  const ledger = buildLedger();
  const out = outFile();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, out);
  const o = ledger.oldestUncleared;
  console.log(`[relayLedger] wrote ${out}`);
  console.log(`[relayLedger] window(72h)=${ledger.windowCount} allTime=${ledger.allTimeCount} clearedKeys=${ledger.clearedKeys} intakeRecords=${ledger.intakeRecords}`);
  console.log(`[relayLedger] oldest uncleared: ${o ? `${o.key} agent=${o.agentId} postedAt=${o.postedAt} ageHours=${o.ageHours}` : 'none'}`);
  return 0;
}

if (require.main === module) {
  try { process.exit(main()); } catch (e) { console.error('[relayLedger] FATAL:', e.message); process.exit(1); }
}

module.exports = { buildLedger, loadIntakeRecords, loadCleared, enrich, WINDOW_MS };
