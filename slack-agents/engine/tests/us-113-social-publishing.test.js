'use strict';
/**
 * US-113 — Approved social content publishes as live posts.
 *
 * Story: As Jesse, I want approved social content to publish as live
 * posts, so that content work produces visible outcomes and not only
 * drafts.
 *   AC1: Given Jesse approves a draft from a batch that passed the
 *        team review loop, When the publish step runs, Then the post
 *        is live and its URL is recorded in published-posts.jsonl.
 *   AC2: Given no approval, Then nothing publishes.
 *
 * What the framework tree actually holds (verified by inspection):
 * engine/publisher.js is the engine's only publish choke point. It
 * enforces the content quality gate FAIL-CLOSED at postToX: unscored
 * content throws, a gate REJECT throws, and both happen before
 * credentials are read or any network call is made — so at this
 * layer, nothing unapproved-by-the-gate can reach a platform. That
 * is the half this suite proves.
 *
 * What it does NOT hold (step-B finding, recorded in the worklog):
 * publisher.js's own header states the engine has NO content-
 * approval path for the draft batch, and nothing in the framework
 * tree writes published-posts.jsonl. Jesse-approval enforcement and
 * the published-posts recording live in the instance-side batch flow
 * (content-batch/post_drafts.py class), outside the framework copy —
 * so AC1's recording half and AC2's approval half have no framework
 * component to test. No implementation was invented for them.
 */
const { gateForPublish, postToX } = require('../publisher');

// A draft known to PASS the content gate (mirrors the passing
// fixture in tests/gates/content-gate.test.js).
function goodDraft(overrides = {}) {
  return {
    label: '1',
    platform: 'LinkedIn',
    hook: "Your AI agent reading 187,000 of your text messages isn't a bug. It's the business model.",
    body: [
      'I think most people have this backwards. We act shocked when an AI assistant',
      'reads our messages, but the product was never the chat window. The product',
      'is the data exhaust. Here is the operating detail nobody mentions: these',
      'systems get better the more of your life they ingest, and the companies',
      'building them know it. That is not a conspiracy, it is the incentive',
      'structure, and human nature has not changed to make it benign.',
      'Get the full breakdown here: https://gadgets.muse.ai/privacy-report',
      'So here is my take: treat every AI product like a landlord. It will use',
      'what you give it. Act accordingly. Trust the incentives, not the interface.',
    ].join(' '),
    persona: 'Justin Welsh',
    format: 'image-caption',
    image_direction: 'Real phone on a desk, 1:1, bold 5-word overlay top third',
    mcp_tools_used: ['image_search'],
    visuals_routed_via_cuxo: true,
    links: ['https://gadgets.muse.ai/privacy-report'],
    ...overrides,
  };
}

describe('US-113 social publishing — the gate at the publish choke point', () => {
  test('a draft that passed the team review loop passes the publish gate', () => {
    const result = gateForPublish(goodDraft());
    expect(result.verdict).toBe('PASS');
  });

  test('AC2 (framework half): unscored content cannot publish — gateForPublish throws', () => {
    expect(() => gateForPublish(null)).toThrow(/unscored content cannot be published/);
    expect(() => gateForPublish(undefined)).toThrow(/unscored content cannot be published/);
    expect(() => gateForPublish('a bare string')).toThrow(/unscored content cannot be published/);
  });

  test('AC2 (framework half): a gate-REJECTED draft throws and publishes nothing', () => {
    const bad = goodDraft({ platform: 'MySpace' }); // schema-invalid platform → REJECT
    expect(() => gateForPublish(bad)).toThrow(/content-gate REJECT/);
  });

  test('postToX refuses unscored content before credentials or network', async () => {
    await expect(postToX('hello world', null)).rejects.toThrow(/unscored content cannot be published/);
  });

  test('postToX refuses a gate-rejected draft before credentials or network', async () => {
    await expect(postToX('hello world', goodDraft({ platform: 'MySpace' })))
      .rejects.toThrow(/content-gate REJECT/);
  });
});
