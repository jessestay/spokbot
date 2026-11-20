'use strict';
/**
 * US-110 — Weekly content batch produced by the team (F2).
 *
 * Story: As a business owner, I want the weekly content batch produced
 * by the MACF team on the team's own schedule, so that Monday's drafts
 * are the team's work and blockers surface the same day.
 *
 * The framework component is engine/contentBatchTrigger.js: the
 * team-side trigger that fires on the team's own timer and registers
 * ONE directive to the CCO. The batch's authorship is the CCO agent's
 * (the trigger writes no content); what this suite proves is the
 * trigger-side contract each acceptance criterion rests on:
 *   AC1 — the directive is addressed CEO → CCO, names the coming
 *         Monday (America/Denver), and carries a MACF-CONTRACT whose
 *         postconditions require the sandbox batch JSON with >= 3
 *         drafts and >= 1 successful slackPost receipt (the #content
 *         presentation), never prose.
 *   AC2 — the directive mandates credited free-stock media (Pexels /
 *         Pixabay / Unsplash) when Canva is unavailable and forbids
 *         silently media-less drafts.
 *   AC3 — the directive carries the blocker rule: a tool failure is
 *         posted in the directive thread in the same run.
 *   AC4 — the postconditions are artifact/receipt checks, so a run
 *         with no deliverable cannot finalize as completed.
 * Plus the round-4 length guard: the composed directive must fit
 * under MAX_DIRECTIVE_CHARS or Slack splits it and loses the tail.
 */
const { buildDirectiveText, comingMondayDenver, MAX_DIRECTIVE_CHARS } = require('../contentBatchTrigger');

function contractOf(text) {
  const m = text.match(/<!-- MACF-CONTRACT (\{.*\}) MACF-CONTRACT -->/);
  expect(m).not.toBeNull();
  return JSON.parse(m[1]);
}

describe('US-110 weekly content batch — trigger directive', () => {
  const text = buildDirectiveText('2026-11-23');
  const contract = contractOf(text);

  test('AC1: directive is registered to the CCO for the named week, as a directive (not CEO-authored content)', () => {
    expect(text.startsWith('[from: CEO → CCO] WEEKLY CONTENT BATCH — week of 2026-11-23')).toBe(true);
    // The trigger composes instructions only; the CCO authors drafts.
    expect(text).toMatch(/DRAFTS ONLY — never publish or schedule/);
  });

  test('AC1/AC4: contract postconditions require the sandbox batch JSON with >= 3 drafts', () => {
    const fileExists = contract.postconditions.find(p => p.type === 'file_exists');
    expect(fileExists).toMatchObject({ path: 'content/weekly-batch-2026-11-23.json' });
    const arrMin = contract.postconditions.find(p => p.type === 'json_array_min');
    expect(arrMin).toMatchObject({ path: 'content/weekly-batch-2026-11-23.json', field: 'drafts', min: 3 });
  });

  test('AC1: contract requires a successful slackPost receipt — the #content presentation is proven, not claimed', () => {
    const receipt = contract.postconditions.find(p => p.type === 'receipt_count');
    expect(receipt).toMatchObject({ tool: 'slackPost', status: 'ok', min: 1 });
    expect(text).toMatch(/POST TO #content VIA slackPost \(channel C0ASA532BGD\)/);
  });

  test('AC2: when Canva is unavailable every draft still ships with credited free-stock media', () => {
    expect(text).toMatch(/if Canva responds, create one design per draft/);
    expect(text).toMatch(/find a fitting Pexels photo or video per draft/);
    expect(text).toMatch(/crediting the source in the post \(Pixabay\/Unsplash acceptable\)/);
    expect(text).toMatch(/NEVER ship a draft silently media-less/);
  });

  test('AC3: the blocker rule posts any tool failure in the directive thread in the same run', () => {
    expect(text).toMatch(/Blocker rule: if any tool fails during this run, post the blocker in this directive thread immediately/);
    expect(text).toMatch(/A silent failure is a defect/);
  });

  test('the composed directive fits under the Slack split guard', () => {
    expect(text.length).toBeLessThanOrEqual(MAX_DIRECTIVE_CHARS);
  });
});

describe('US-110 weekly content batch — week computation', () => {
  afterEach(() => { jest.useRealTimers(); });

  test('comingMondayDenver returns the coming Monday in America/Denver (today when today is Monday)', () => {
    // Monday 2026-11-23 14:21 UTC = Monday 07:21 MST — the timer fire time.
    jest.useFakeTimers().setSystemTime(new Date('2026-11-23T14:21:00Z'));
    expect(comingMondayDenver()).toBe('2026-11-23');
    // Wednesday 2026-11-18 → the coming Monday is 2026-11-23.
    jest.useFakeTimers().setSystemTime(new Date('2026-11-18T17:00:00Z'));
    expect(comingMondayDenver()).toBe('2026-11-23');
    // Sunday 2026-11-22 (Denver) → the coming Monday is the next day.
    jest.useFakeTimers().setSystemTime(new Date('2026-11-22T17:00:00Z'));
    expect(comingMondayDenver()).toBe('2026-11-23');
  });
});
