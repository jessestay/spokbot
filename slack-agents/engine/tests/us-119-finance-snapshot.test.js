'use strict';
/**
 * US-119 — CFO daily finance snapshot + expense-to-sheet (F3 finance).
 *
 * Story: As Jesse, I want the CFO to run a daily finance snapshot and
 * land every newly discovered expense in my budget sheet in the same
 * pass, so that revenue operations reflect real money movement, not
 * plans.
 * AC1: Given a new expense appears in any linked account, When the
 * CFO finance pass runs, Then the expense is recorded once in the
 * budget sheet the same day and the daily snapshot totals reconcile
 * with the account feeds.
 *
 * Framework components: engine/financeCheck.js (the deterministic
 * snapshot computation the CFO consumes) and engine/financeRefresh.js
 * (the input validator that runs before every check). This suite
 * proves the framework half: the snapshot reconciles EXACTLY with
 * its recorded inputs (net = sum of balances, due14 = sum of unpaid
 * obligations due in the window, each expense surfacing exactly
 * once), and a malformed expense record is rejected at validation
 * before it can land. The budget-sheet write itself is the CFO's
 * finance-files MCP step (instance-side tooling), not framework
 * code — recorded as the boundary in the worklog.
 *
 * Fixture dates are computed relative to today (Denver) at runtime,
 * because check() derives "today" from the real clock.
 */
const { check, renderSnapshot } = require('../financeCheck');
const { validateObligations } = require('../financeRefresh');

function denverDate(offsetDays) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + offsetDays * 86400e3));
  return parts; // en-CA yields YYYY-MM-DD
}

function fixture() {
  return {
    balances: {
      asOf: new Date().toISOString(),
      accounts: [
        { name: 'USAA Checking', mask: '8056', current: 100.25 },
        { name: 'USAA Savings', mask: '0293', current: 5.00 },
        { name: 'Found', mask: '4417', current: -90.53 },
      ],
    },
    obligations: {
      obligations: [
        { name: 'New Expense Co', amount: 47.84, due: denverDate(3) },   // the newly discovered expense
        { name: 'Old Overdue', amount: 60.00, due: denverDate(-2) },
        { name: 'Far Future', amount: 999.00, due: denverDate(40) },
        { name: 'Already Paid', amount: 25.00, due: denverDate(2), paid: true },
      ],
    },
    income: [
      { source: 'HDL payroll', amount: 154.11, date: denverDate(-5), status: 'received' },
      { source: 'Ancient gig', amount: 500.00, date: denverDate(-40), status: 'received' },
      { source: 'ESS payroll', amount: 21.39, date: denverDate(-1), status: 'in_transit' },
    ],
    now: new Date(),
  };
}

describe('US-119 finance snapshot — totals reconcile with the account feeds', () => {
  test('net cash is exactly the sum of the recorded balances', () => {
    const r = check(fixture());
    expect(r.net).toBeCloseTo(100.25 + 5.00 - 90.53, 2);
    expect(r.flags.filter(f => f.kind === 'NEGATIVE_ACCOUNT')).toHaveLength(1);
  });

  test('the new expense is recorded once: one flag, counted once in due-14', () => {
    const r = check(fixture());
    const mentions = r.flags.filter(f => /New Expense Co/.test(f.detail));
    expect(mentions).toHaveLength(1);
    expect(mentions[0].kind).toBe('DUE_SOON');
    // due14 = new expense (3d) + overdue (already due) — paid and
    // far-future obligations are excluded, nothing double-counted.
    expect(r.due14).toBeCloseTo(47.84 + 60.00, 2);
    expect(r.flags.filter(f => f.kind === 'OVERDUE')).toHaveLength(1);
  });

  test('income windows reconcile: received-30 counts only the last 30 days, in-transit is listed', () => {
    const r = check(fixture());
    expect(r.received30).toBeCloseTo(154.11, 2);
    expect(r.inTransit).toHaveLength(1);
    expect(r.inTransit[0].source).toBe('ESS payroll');
  });

  test('the rendered snapshot carries the same reconciled totals', () => {
    const f = fixture();
    const md = renderSnapshot(check(f), f.balances);
    expect(md).toContain('Net cash: $14.72');
    expect(md).toContain('Total due in the next 14 days: $107.84');
    expect(md).toContain('New Expense Co');
  });

  test('missing balance data is flagged, never silently zeroed', () => {
    const r = check({ balances: null, obligations: { obligations: [] }, income: [], now: new Date() });
    expect(r.flags.map(f => f.kind)).toContain('NO_BALANCE_DATA');
  });
});

describe('US-119 finance snapshot — malformed expenses stop at validation', () => {
  test('a well-formed obligations file validates clean', () => {
    expect(validateObligations(fixture().obligations)).toBeNull();
  });
  test('a missing name, a non-numeric amount, and a bad due date each fail loudly', () => {
    expect(validateObligations({ obligations: [{ amount: 5, due: '2026-12-01' }] })).toMatch(/missing its name/);
    expect(validateObligations({ obligations: [{ name: 'X', amount: 'five', due: '2026-12-01' }] })).toMatch(/not a finite number/);
    expect(validateObligations({ obligations: [{ name: 'X', amount: 5, due: 'Dec 1' }] })).toMatch(/not a valid YYYY-MM-DD/);
    expect(validateObligations({})).toMatch(/no obligations array/);
  });
});
