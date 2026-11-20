// kernel-p1-chain.test.js — #807 Phase 1 (US-P1.1): the smart tier's chain
// must end with the LOCAL route (macf-local, desktop Ollama) so a delegation
// whose OpenRouter legs are both down still has somewhere real to go.
// Real modelRouter against the real config/models.yaml — no mocks.

const { getFallbackChain } = require('../../utils/modelRouter');

describe('#807 Phase 1 — models.yaml chains', () => {
  test('smart chain is [paid, deepseek-direct, free, macf-local] — local LAST', () => {
    // Oct 21, 2026 (burn-down stall fix, documented in models.yaml): the
    // direct DeepSeek leg was added between paid and free because the legs
    // below paid were dead. Local remains LAST (#807 Phase 1 invariant).
    expect(getFallbackChain('smart')).toEqual(['macf-smart-paid', 'openrouter/deepseek/deepseek-v4-flash', 'macf-smart-free', 'macf-local']);
    const chain = getFallbackChain('smart');
    expect(chain[chain.length - 1]).toBe('macf-local');
  });

  test('quick chain unchanged: local Ollama first', () => {
    const quick = getFallbackChain('quick');
    expect(quick[0]).toBe('macf-cheap');
  });

  test('best chain unchanged: no local leg forced onto best', () => {
    expect(getFallbackChain('best')).toEqual(['macf-best']);
  });
});
