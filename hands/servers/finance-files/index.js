#!/usr/bin/env node
// servers/finance-files/index.js — finance-files MCP server
//
// Access to the Finance Repeat's recorded sources for the CFO (and CEO):
// the deterministic finance check's inputs and outputs in the agent
// sandbox. Built Oct 23, 2026 after the #766 CFO review failure: the CFO's
// only granted server was PayPal-only and could not read the recorded
// finance data at all (grant gap, ticket #904).
//
// Read tools return file contents verbatim with the file's mtime, so
// callers can cite the as-of time. Two narrowly-scoped write tools were
// added Nov 9, 2026 (ticket #986) so the CFO/CEO can record new
// obligations and income in the check's inputs — before that the inputs
// were frozen at their Oct 23 seed because this server was read-only.
// Writes are atomic (temp file + rename for obligations.json, append for
// the JSONL ledger), preserve existing content, and are audit-logged.
// An optional boolean `paid` field on obligation upserts was added
// Nov 11, 2026 (#986 follow-up): before that, a paid obligation could
// only say so in its note, and the Finance Repeat check kept flagging
// it OVERDUE. financeCheck.js already honors `paid` (skips paid
// entries in its flag loop); this field lets the state be recorded
// through the tool instead of by hand-editing obligations.json.
//
// Access control (fail closed): MACF_ROLE must be CFO or CEO and
// MACF_ROLE_TOKEN must match that role's entry in the role-token file.
'use strict';

const fs = require('fs');
const path = require('path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const HANDS_ROOT = path.resolve(__dirname, '..', '..');
const ROLE_TOKENS_FILE = path.join(HANDS_ROOT, '.role-tokens');
const AUDIT_LOG = path.join(HANDS_ROOT, 'logs', 'finance-files-audit.log');
const { financeDir } = require('./paths');
const FINANCE_DIR = financeDir();

const FILES = {
  finance_snapshot_read: { file: 'finance-snapshot.md', description: 'The current finance snapshot (balances, net cash, obligations summary, flags) as last rewritten by the deterministic Finance Repeat check. Returns content + file mtime.' },
  finance_obligations_read: { file: 'obligations.json', description: 'The recorded obligations list (creditor, amount, due date, status, notes) the Finance Repeat tracks. Returns content + file mtime.' },
  finance_income_read: { file: 'income-ledger.jsonl', description: 'The recorded income ledger (one JSON object per line: source, amount, date, status). Returns content + file mtime.' },
  finance_flags_read: { file: 'finance-flags.json', description: 'The Finance Repeat computed flags (negative accounts, overdue items, hard deadlines, amounts due in 7/14 days, net cash) with the check timestamp. Returns content + file mtime.' },
};

const WRITE_TOOLS = {
  finance_obligation_upsert: {
    file: 'obligations.json',
    description: 'Add a new obligation to obligations.json, or update the existing obligation with the same name. Fields: name, amount, due (YYYY-MM-DD), optional note, optional hard (true = hard deadline), optional paid (true = obligation has been paid; paid obligations stay on record but are excluded from the Finance Repeat check\'s OVERDUE/DUE_SOON flags). The write is atomic (temp file + rename) and preserves all other recorded obligations.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Obligation/creditor name; the upsert key.' },
        amount: { type: 'number', description: 'Amount owed.' },
        due: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Due date, YYYY-MM-DD.' },
        note: { type: 'string', description: 'Optional note; replaces the recorded note when provided.' },
        hard: { type: 'boolean', description: 'Optional; true marks a hard deadline.' },
        paid: { type: 'boolean', description: 'Optional; true marks the obligation as paid. Paid obligations are excluded from OVERDUE/DUE_SOON flags.' },
      },
      required: ['name', 'amount', 'due'],
    },
  },
  finance_income_append: {
    file: 'income-ledger.jsonl',
    description: 'Append one income record to income-ledger.jsonl. Fields: date (YYYY-MM-DD), source, amount, status (e.g. received, in_transit, requested), optional note. The existing ledger content is preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Income date, YYYY-MM-DD.' },
        source: { type: 'string', description: 'Income source (e.g. Amazon Flex).' },
        amount: { type: 'number', description: 'Amount.' },
        status: { type: 'string', description: 'received, in_transit, or requested.' },
        note: { type: 'string', description: 'Optional note.' },
      },
      required: ['date', 'source', 'amount', 'status'],
    },
  },
};

function checkRole() {
  const role = process.env.MACF_ROLE;
  const token = process.env.MACF_ROLE_TOKEN;
  if (role !== 'CFO' && role !== 'CEO') {
    console.error('[finance-files] REFUSED: MACF_ROLE must be CFO or CEO');
    process.exit(2);
  }
  let expected = process.env[`MACF_${role}_ROLE_TOKEN`] || null;
  if (!expected) {
    try {
      const lines = fs.readFileSync(ROLE_TOKENS_FILE, 'utf8').split('\n');
      for (const line of lines) {
        const m = line.match(new RegExp('^' + role + '=(.+)$'));
        if (m) expected = m[1].trim();
      }
    } catch (e) { /* missing file -> refuse */ }
  }
  if (!expected || !token || token !== expected) {
    console.error('[finance-files] REFUSED: invalid role token');
    process.exit(2);
  }
  return role;
}

function audit(role, tool, ok, summary) {
  const entry = { ts: new Date().toISOString(), server: 'finance-files', role, tool, ok, summary: String(summary).slice(0, 500) };
  try { fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n'); } catch (e) { console.error('[finance-files] audit log write failed:', e.message); }
}

function readFinanceFile(tool) {
  const spec = FILES[tool];
  const p = path.join(FINANCE_DIR, spec.file);
  const st = fs.statSync(p);
  const content = fs.readFileSync(p, 'utf8');
  return `[finance-files] ${spec.file} (last modified ${st.mtime.toISOString()})\n\n${content}`;
}

function reqString(v, field) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} is required and must be a non-empty string`);
  return v.trim();
}

function reqAmount(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('amount is required and must be a finite number');
  return v;
}

function reqDate(v, field) {
  const s = reqString(v, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T12:00:00Z`))) {
    throw new Error(`${field} must be a valid date in YYYY-MM-DD form`);
  }
  return s;
}

function writeFileAtomic(p, content) {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}

function upsertObligation(args) {
  const name = reqString(args.name, 'name');
  const amount = reqAmount(args.amount);
  const due = reqDate(args.due, 'due');
  if (args.note !== undefined && typeof args.note !== 'string') throw new Error('note must be a string');
  if (args.hard !== undefined && typeof args.hard !== 'boolean') throw new Error('hard must be a boolean');
  if (args.paid !== undefined && typeof args.paid !== 'boolean') throw new Error('paid must be a boolean');
  const p = path.join(FINANCE_DIR, 'obligations.json');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!data || !Array.isArray(data.obligations)) {
    throw new Error('obligations.json has an unexpected shape (no obligations array); refusing to rewrite it');
  }
  const idx = data.obligations.findIndex(o => o && o.name === name);
  let entry;
  let action;
  if (idx >= 0) {
    entry = { ...data.obligations[idx], name, amount, due };
    if (args.note !== undefined) entry.note = args.note;
    if (args.hard !== undefined) entry.hard = args.hard;
    if (args.paid !== undefined) entry.paid = args.paid;
    data.obligations[idx] = entry;
    action = 'updated';
  } else {
    entry = { name, amount, due };
    if (args.note !== undefined) entry.note = args.note;
    if (args.hard !== undefined) entry.hard = args.hard;
    if (args.paid !== undefined) entry.paid = args.paid;
    data.obligations.push(entry);
    action = 'added';
  }
  writeFileAtomic(p, JSON.stringify(data, null, 2) + '\n');
  const st = fs.statSync(p);
  console.error(`[finance-files] finance_obligation_upsert ${action}: ${name} $${amount} due ${due} (obligations.json mtime ${st.mtime.toISOString()})`);
  return `[finance-files] obligations.json ${action} (last modified ${st.mtime.toISOString()})\n\n${JSON.stringify(entry, null, 2)}`;
}

function appendIncome(args) {
  const entry = {
    date: reqDate(args.date, 'date'),
    source: reqString(args.source, 'source'),
    amount: reqAmount(args.amount),
    status: reqString(args.status, 'status'),
  };
  if (args.note !== undefined) {
    if (typeof args.note !== 'string') throw new Error('note must be a string');
    entry.note = args.note;
  }
  const p = path.join(FINANCE_DIR, 'income-ledger.jsonl');
  let prefix = '';
  try {
    const cur = fs.readFileSync(p, 'utf8');
    if (cur && !cur.endsWith('\n')) prefix = '\n';
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.appendFileSync(p, prefix + JSON.stringify(entry) + '\n');
  const st = fs.statSync(p);
  console.error(`[finance-files] finance_income_append: ${entry.source} $${entry.amount} ${entry.status} ${entry.date} (income-ledger.jsonl mtime ${st.mtime.toISOString()})`);
  return `[finance-files] income-ledger.jsonl appended (last modified ${st.mtime.toISOString()})\n\n${JSON.stringify(entry)}`;
}

async function main() {
  const role = checkRole();
  const server = new Server({ name: 'finance-files', version: '1.2.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...Object.entries(FILES).map(([name, spec]) => ({
        name,
        description: spec.description,
        inputSchema: { type: 'object', properties: {} },
      })),
      ...Object.entries(WRITE_TOOLS).map(([name, spec]) => ({
        name,
        description: spec.description,
        inputSchema: spec.inputSchema,
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const isRead = !!FILES[name];
    const isWrite = !!WRITE_TOOLS[name];
    if (!isRead && !isWrite) {
      audit(role, name, false, 'unknown tool');
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    const file = isRead ? FILES[name].file : WRITE_TOOLS[name].file;
    try {
      const text = isRead
        ? readFinanceFile(name)
        : (name === 'finance_obligation_upsert'
          ? upsertObligation(req.params.arguments || {})
          : appendIncome(req.params.arguments || {}));
      audit(role, name, true, `${isRead ? 'read' : 'write'} ${file}`);
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      audit(role, name, false, e.message);
      return { content: [{ type: 'text', text: `finance-files ${isRead ? 'read' : 'write'} failed for ${file}: ${e.message}. Not fabricating data.` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[finance-files] ready (role=${role})`);
}

main().catch((e) => { console.error('[finance-files] fatal:', e.message); process.exit(1); });
