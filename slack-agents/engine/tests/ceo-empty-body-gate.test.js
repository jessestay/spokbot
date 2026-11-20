// CEO BUILD regression tests (Oct 22, 2026 — audit F1/F2).
// The Oct 22 failure: agents returned header-only responses
// ("[from: Lawyer → CEO] " with an empty body) after real tool work, and
// finalizeDelegation stamped them "completed" because raw tool receipts
// counted as evidence. These tests pin the fix:
//  1. An empty/trivial response body can NEVER finalize — poller shape
//     or workflow-nested shape — regardless of banked tool receipts.
//  2. A real body still finalizes and posts (no false rejections).
//  3. The visible-reply mirror never posts a header-only body.
//  4. delegationFailure() produces the shared failure contract shape.
'use strict';

const { finalizeDelegation, postVisibleDirectiveReply } = require('../directiveFinalize');
const { delegationFailure } = require('../../utils/delegation');

const CHANNEL = 'C0ASH4TF604';

function makeClient() {
  const posts = [];
  return {
    posts,
    chat: {
      postMessage: async (params) => {
        posts.push(params);
        return { ts: '1792000099.000001' };
      },
    },
    conversations: {
      replies: async () => ({ messages: [{ ts: '1792000099.000001' }] }),
      history: async () => ({ messages: [{ ts: '1792000099.000001' }] }),
    },
  };
}

function makeItem(ts, agentId = 'lawyer') {
  return {
    channel: CHANNEL,
    m: { ts },
    text: '[from: CEO → Lawyer] Do the research and report back with findings.',
    msgTs: ts,
    agentId,
  };
}

describe('CEO empty-body gate (F2)', () => {
  test('workflow-nested header-only response is rejected as empty_response, nothing posted', async () => {
    const client = makeClient();
    const state = {};
    const item = makeItem('1792000001.000001');
    const result = {
      'execute-directive': {
        completed: true,
        response: '[from: Lawyer → CEO] ',
        threadTs: item.m.ts,
        channel: 'management',
        subResults: [],
        evidence: 'Legal guidance with 16 tool execution(s): vikunjaGetTask, fileList, mcp_tavily_tavily_search',
        agentId: 'lawyer',
      },
    };
    const processed = await finalizeDelegation(client, state, item, result);
    expect(processed).toBe(0);
    expect(client.posts.length).toBe(0);
    expect(state._retries[`${CHANNEL}:${item.m.ts}`]).toBe(1);
  });

  test('poller-shape header-only response is rejected the same way', async () => {
    const client = makeClient();
    const state = {};
    const item = makeItem('1792000002.000002');
    const result = {
      completed: true,
      response: '[from: Lawyer → CEO] ',
      threadTs: item.m.ts,
      subResults: [],
      evidence: 'Legal guidance with 3 tool execution(s): fileList',
      agentId: 'lawyer',
    };
    const processed = await finalizeDelegation(client, state, item, result);
    expect(processed).toBe(0);
    expect(client.posts.length).toBe(0);
    expect(state._retries[`${CHANNEL}:${item.m.ts}`]).toBe(1);
  });

  test('workflow-nested response with a real body finalizes and posts', async () => {
    const client = makeClient();
    const state = {};
    const item = makeItem('1792000003.000003');
    const result = {
      'execute-directive': {
        completed: true,
        response: '[from: Lawyer → CEO] Phase 1 identification results: I searched both Gmail accounts and the court records index. The judgment creditor is not identifiable from the records searched; the full search log is attached to Vikunja #766.',
        threadTs: item.m.ts,
        channel: 'management',
        subResults: [],
        evidence: 'Legal guidance with 16 tool execution(s)',
        agentId: 'lawyer',
      },
    };
    const processed = await finalizeDelegation(client, state, item, result);
    expect(processed).toBe(1);
    // For the workflow shape, finalizeDelegation does not post (no
    // top-level response by design) — the consume loop's visible-reply
    // mirror does. Run the mirror as the consume loop would:
    const intake = { update: async () => {} };
    const rec = {
      key: `${CHANNEL}:${item.m.ts}`,
      channel: CHANNEL,
      ts: item.m.ts,
      agentId: 'lawyer',
      result,
    };
    const posted = await postVisibleDirectiveReply({ intake, client, rec });
    expect(posted).toBe(true);
    expect(client.posts.length).toBe(1);
    expect(client.posts[0].text).toContain('Phase 1 identification results');
  });

  test('visible reply mirror withholds a header-only body', async () => {
    const client = makeClient();
    const updates = [];
    const intake = { update: async (key, fields) => { updates.push({ key, fields }); } };
    const rec = {
      key: `${CHANNEL}:1792000004.000004`,
      channel: CHANNEL,
      ts: '1792000004.000004',
      agentId: 'lawyer',
      result: { 'execute-directive': { completed: true, response: '[from: Lawyer → CEO] ' } },
    };
    const posted = await postVisibleDirectiveReply({ intake, client, rec });
    expect(posted).toBe(false);
    expect(client.posts.length).toBe(0);
    expect(updates.length).toBe(0);
  });
});

describe('delegationFailure contract (F1)', () => {
  test('produces a failed, null-response delegation result', () => {
    const f = delegationFailure({ errorClass: 'round_exhausted_with_work', agentId: 'lawyer', threadTs: '1.2', channel: 'management' });
    expect(f.completed).toBe(false);
    expect(f.ok).toBe(false);
    expect(f.response).toBe(null);
    expect(f.errorClass).toBe('round_exhausted_with_work');
    expect(f.agentId).toBe('lawyer');
    expect(Array.isArray(f.subResults)).toBe(true);
  });

  test('defaults the error class to no_result', () => {
    const f = delegationFailure({ agentId: 'cfo' });
    expect(f.errorClass).toBe('no_result');
  });
});
