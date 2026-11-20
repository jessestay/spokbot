/**
 * outcome-audit.test.js — Oct 26, 2026 (Jesse's order).
 *
 * The outcome audit counts ONLY verified outcomes. These tests pin the
 * gates that keep zero-delivery visible and keep non-outcomes from ever
 * inflating the counts:
 *  - an application without a portal confirmation reference counts 0
 *  - a social post without a live URL counts 0
 *  - a deliverable without a send reference counts 0
 *  - an SEO comment that merely MENTIONS a property URL (the real
 *    Oct 22, 2026 scope comment on task #846) counts 0; a comment stating
 *    a change with the changed-page URL counts 1
 *  - the OUTCOME ALARM fires at a 3+ day zero streak for applications,
 *    social posts and SEO changes only — and names the owning agent
 */

const {
  parseJsonl,
  applicationEvents,
  publishedPostEvents,
  deliveryEvents,
  outreachEvents,
  conciergeMetric,
  isSeoTask,
  seoEvents,
  summarize,
  buildAlarms,
  renderAlarmSection,
  renderReport,
  shiftDay,
} = require('../outcomeAudit');

const DAY = '2026-10-25'; // audit day (yesterday, America/Denver convention)
const tsOn = (day, hour = 18) => {
  // Denver is UTC-6 in October (MDT): 18:00Z = 12:00 Denver same day.
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour)).toISOString();
};

describe('application counting (portal confirmation gate)', () => {
  test('counts only entries carrying a portal confirmation reference', () => {
    const entries = [
      { ts: tsOn(DAY), company: 'Acme', confirmationRef: 'APP-123' },
      { ts: tsOn(DAY), company: 'Beta', portalConfirmation: 'CONF-9' },
      { ts: tsOn(DAY), company: 'Ghost Co' }, // applied? no confirmation -> 0
      { ts: tsOn(DAY), company: 'Empty Ref LLC', confirmationRef: '  ' },
      { ts: tsOn(DAY), company: 'Numeric Ref', confirmationRef: 42 },
    ];
    const events = applicationEvents(entries);
    expect(events).toHaveLength(2);
    expect(events.map(e => e.ref)).toEqual(['APP-123', 'CONF-9']);
    expect(events.every(e => e.day === DAY)).toBe(true);
  });

  test('entries without a usable timestamp never count', () => {
    expect(applicationEvents([{ confirmationRef: 'X-1' }])).toHaveLength(0);
    expect(applicationEvents([{ confirmationRef: 'X-1', ts: 'not a date' }])).toHaveLength(0);
  });
});

describe('social post counting (live URL gate)', () => {
  test('counts only entries with a live http(s) URL', () => {
    const entries = [
      { ts: tsOn(DAY), platform: 'LinkedIn', url: 'https://www.linkedin.com/posts/abc' },
      { ts: tsOn(DAY), platform: 'X', url: 'draft only, not posted' },
      { ts: tsOn(DAY), platform: 'Facebook' }, // no URL -> not published evidence
      { ts: tsOn(DAY), platform: 'TikTok', url: '' },
    ];
    const events = publishedPostEvents(entries);
    expect(events).toHaveLength(1);
    expect(events[0].ref).toContain('linkedin.com');
  });
});

describe('delivery counting (send reference gate)', () => {
  test('drafts never count; sends with a reference do', () => {
    const entries = [
      { ts: tsOn(DAY), client: 'Graham Schwab', name: 'one-pager draft' },
      { ts: tsOn(DAY), client: 'Graham Schwab', messageId: 'gmail-1a169' },
      { ts: tsOn(DAY), client: 'Michele Soulli', sentRef: 'sent/2026-10-21' },
    ];
    const events = deliveryEvents(entries);
    expect(events).toHaveLength(2);
  });
});

describe('SEO change counting (changed-page URL + change language)', () => {
  const scopeComment = {
    id: 101,
    created: '2026-10-22T15:13:01Z',
    // Verbatim shape of the real Oct 22 scope comment on #846: mentions the
    // property URL as a planning instruction. Must NEVER count as a change.
    comment: 'CEO scope addition (Jesse, Oct 22): add https://jessestay.com/canvabook to this repeat as a second property — the Canva For Dummies book hub is a proven revenue surface. Audit its pages in the same blunt SEO/AIO style.',
  };
  const changeComment = {
    id: 102,
    created: '2026-10-24T16:00:00Z',
    comment: 'Updated the title tag and meta description on https://staynalive.com/canva-mastery/ — change is live.',
  };

  test('keyword match by title or label', () => {
    expect(isSeoTask({ title: '[SEO Expert] SEO/AIO Repeat: rolling audit' })).toBe(true);
    expect(isSeoTask({ title: 'Improve search ranking', labels: [{ title: 'SEO' }] })).toBe(true);
    expect(isSeoTask({ title: 'Fix the espresso machine' })).toBe(false);
  });

  test('planning mention of a property URL does not count; a stated change does', () => {
    const tasks = [{ id: 846, title: '[SEO Expert] SEO/AIO Repeat', comments: [scopeComment, changeComment] }];
    const events = seoEvents(tasks);
    expect(events).toHaveLength(1);
    expect(events[0].ref).toContain('staynalive.com');
  });

  test('comments on non-SEO tasks never count, and comments dedupe by id', () => {
    const other = { id: 55, title: 'Random task', comments: [changeComment] };
    expect(seoEvents([other])).toHaveLength(0);
    const seoTask = { id: 846, title: 'SEO audit', comments: [changeComment, changeComment] };
    expect(seoEvents([seoTask])).toHaveLength(1);
  });

  test('a change claim without a property URL does not count', () => {
    const noUrl = { id: 103, created: '2026-10-24T16:00:00Z', comment: 'Updated all the meta tags, everything is live now.' };
    expect(seoEvents([{ id: 1, title: 'SEO work', comments: [noUrl] }])).toHaveLength(0);
  });
});

describe('summarize: today / 7-day / zero streak', () => {
  test('event today -> streak 0, daysSinceNonzero 0', () => {
    const s = summarize([{ day: DAY, ref: 'x' }], DAY);
    expect(s.today).toBe(1);
    expect(s.last7).toBe(1);
    expect(s.zeroStreak).toBe(0);
    expect(s.daysSinceNonzero).toBe(0);
  });

  test('last event 5 days ago -> streak 5', () => {
    const s = summarize([{ day: shiftDay(DAY, -5), ref: 'x' }], DAY);
    expect(s.today).toBe(0);
    expect(s.last7).toBe(1);
    expect(s.zeroStreak).toBe(5);
    expect(s.daysSinceNonzero).toBe(5);
  });

  test('event 10 days ago counts in neither today nor last7, streak 10', () => {
    const s = summarize([{ day: shiftDay(DAY, -10), ref: 'x' }], DAY);
    expect(s.today).toBe(0);
    expect(s.last7).toBe(0);
    expect(s.zeroStreak).toBe(10);
    expect(s.daysSinceNonzero).toBe(10);
  });

  test('no events at all -> full-window streak, daysSinceNonzero null', () => {
    const s = summarize([], DAY);
    expect(s.today).toBe(0);
    expect(s.last7).toBe(0);
    expect(s.zeroStreak).toBe(31);
    expect(s.daysSinceNonzero).toBeNull();
  });
});

describe('alarm rule', () => {
  const zero = { zeroStreak: 9, daysSinceNonzero: 9, unmeasured: false };
  const healthy = { zeroStreak: 0, daysSinceNonzero: 0, unmeasured: false };

  test('fires for applications/socialPosts/seoChanges at 3+ zero days', () => {
    const alarms = buildAlarms({ applications: zero, socialPosts: zero, seoChanges: zero, deliveries: zero });
    expect(alarms.map(a => a.metric)).toEqual(['applications', 'socialPosts', 'seoChanges']);
  });

  test('deliveries are reported but never alarmed', () => {
    const alarms = buildAlarms({ applications: healthy, socialPosts: healthy, seoChanges: healthy, deliveries: zero });
    expect(alarms).toHaveLength(0);
  });

  test('does not fire below the 3-day threshold', () => {
    const twoDays = { zeroStreak: 2, daysSinceNonzero: 2, unmeasured: false };
    expect(buildAlarms({ applications: twoDays, socialPosts: twoDays, seoChanges: twoDays, deliveries: twoDays })).toHaveLength(0);
  });

  test('an unmeasured (source-error) metric never alarms as zero', () => {
    const broken = { zeroStreak: null, daysSinceNonzero: null, unmeasured: true };
    expect(buildAlarms({ applications: healthy, socialPosts: healthy, seoChanges: broken, deliveries: healthy })).toHaveLength(0);
  });

  test('alarm section names the metric and the owning agent in plain language', () => {
    const audit = {
      day: DAY,
      alarms: buildAlarms({ applications: zero, socialPosts: healthy, seoChanges: healthy, deliveries: healthy }),
      metrics: {},
    };
    const md = renderAlarmSection(audit);
    expect(md).toContain('OUTCOME ALARM');
    expect(md).toContain('Job applications confirmed submitted');
    expect(md).toContain('Job Coach');
    expect(md).toContain('ZERO');
  });
});

describe('report rendering', () => {
  test('unmeasured metrics render as UNMEASURED, never as 0', () => {
    const audit = {
      day: DAY,
      alarms: [],
      metrics: {
        applications: { today: 0, last7: 0, daysSinceNonzero: null, zeroStreak: 31, sourceNote: 'ledger' },
        socialPosts: { today: 0, last7: 0, daysSinceNonzero: null, zeroStreak: 31, sourceNote: 'ledger' },
        seoChanges: { unmeasured: true, today: null, last7: null, daysSinceNonzero: null, sourceNote: 'UNMEASURED — Vikunja read failed' },
        deliveries: { today: 0, last7: 0, daysSinceNonzero: null, zeroStreak: 31, sourceNote: 'ledger' },
        outreach: { today: 0, last7: 0, daysSinceNonzero: null, zeroStreak: 31, sourceNote: 'ledger' },
        concierge: { snapshot: true, today: null, last7: null, daysSinceNonzero: null, zeroStreak: null, awaitingReply: 0, trackedConversations: 0, lastPollAt: null, stale: true, sourceNote: 'snapshot' },
      },
    };
    const md = renderReport(audit);
    expect(md).toContain('UNMEASURED');
    expect(md).not.toMatch(/SEO\/AIO page changes \(CTO \(interim, story #899\)\) \| 0 \|/);
  });
});

describe('parseJsonl', () => {
  test('skips torn lines and blanks, keeps valid objects', () => {
    const text = '{"a":1}\n\nnot json\n{"b":2}\n';
    expect(parseJsonl(text)).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('outreach counting (delivered + send reference gate) — F6, Nov 11 2026', () => {
  test('delivered sends with a reference count; blocked/failed/replies never do', () => {
    const entries = [
      { kind: 'send', status: 'sent', ref: 'm1', ts: tsOn(DAY) },
      { kind: 'send', status: 'sent_duplicate', ref: 'm2', ts: tsOn(DAY) },
      { kind: 'send', status: null, ref: 'm3', ts: tsOn(DAY) }, // legacy touch-1 shape
      { kind: 'send', status: 'blocked', ref: 'm4', ts: tsOn(DAY) },
      { kind: 'send', status: 'failed', ref: 'm5', ts: tsOn(DAY) },
      { kind: 'send', status: 'sent', ref: '', ts: tsOn(DAY) },
      { kind: 'reply', ref: 'm6', ts: tsOn(DAY) },
      { kind: 'send', status: 'sent', ref: 'm7', ts: null }, // undated: no day bucket
    ];
    const events = outreachEvents(entries);
    expect(events.map(e => e.ref)).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('concierge snapshot metric — F7, Nov 11 2026', () => {
  test('passes source values through and flags a snapshot older than 48h stale', () => {
    const now = Date.parse('2026-11-11T16:00:00Z');
    const fresh = conciergeMetric({ generatedAt: '2026-11-11T15:00:00Z', trackedConversations: 55, awaitingReply: 11, draftsPending: null, lastPollAt: '2026-11-11T04:25:00-07:00' }, now);
    expect(fresh.snapshot).toBe(true);
    expect(fresh.trackedConversations).toBe(55);
    expect(fresh.awaitingReply).toBe(11);
    expect(fresh.draftsPending).toBeNull(); // never borrowed from awaitingReply
    expect(fresh.stale).toBe(false);
    const old = conciergeMetric({ generatedAt: '2026-11-08T15:00:00Z', trackedConversations: 55, awaitingReply: 11, lastPollAt: 'x' }, now);
    expect(old.stale).toBe(true);
    const undated = conciergeMetric({ trackedConversations: 1, awaitingReply: 0 }, now);
    expect(undated.stale).toBe(true); // unknown age counts as stale
  });
  test('a snapshot metric renders its state, never a fake zero row', () => {
    const audit = { day: DAY, alarms: [], metrics: {
      applications: { today: 0, last7: 0, daysSinceNonzero: null, zeroStreak: 31, daily: {}, events: [], sourceNote: 'x' },
      socialPosts: { today: 0, last7: 0, daysSinceNonzero: null, zeroStreak: 31, daily: {}, events: [], sourceNote: 'x' },
      seoChanges: { today: 0, last7: 0, daysSinceNonzero: null, zeroStreak: 31, daily: {}, events: [], sourceNote: 'x' },
      deliveries: { today: 0, last7: 0, daysSinceNonzero: null, zeroStreak: 31, daily: {}, events: [], sourceNote: 'x' },
      outreach: { today: 0, last7: 0, daysSinceNonzero: null, zeroStreak: 31, daily: {}, events: [], sourceNote: 'x' },
      concierge: { ...conciergeMetric({ generatedAt: new Date().toISOString(), trackedConversations: 55, awaitingReply: 11, lastPollAt: '2026-11-11T04:25:00-07:00' }, Date.now()), sourceNote: 'x' },
    } };
    const md = renderReport(audit);
    expect(md).toContain('SNAPSHOT: 11 awaiting Jesse reply/approval · 55 conversations tracked');
  });
});
