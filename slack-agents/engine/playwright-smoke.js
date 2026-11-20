'use strict';
/*
 * playwright-smoke.js — #935 G1 browser-runtime smoke test.
 *
 * Proves the server can drive a real browser: launches the project-local
 * Chromium (slack-agents/.playwright-browsers) headless, loads a public
 * page, writes a screenshot artifact into .state/.
 *
 * Run in ENGINE context (same env as the macf-engine service), from the
 * slack-agents directory of your checkout:
 *   cd <checkout>/slack-agents
 *   HOME=<engine-home> \
 *   PLAYWRIGHT_BROWSERS_PATH=<checkout>/slack-agents/.playwright-browsers \
 *     node engine/playwright-smoke.js
 * Exits 0 and prints SMOKE_OK on success.
 */
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let mode = 'live';
  try {
    const resp = await page.goto('https://example.com', { timeout: 20000 });
    console.log('goto https://example.com status:', resp && resp.status());
    console.log('page title:', await page.title());
  } catch (e) {
    mode = 'fallback-setContent';
    console.log('goto failed:', String(e.message).split('\n')[0]);
    await page.setContent('<title>macf-smoke</title><h1>MACF Playwright smoke test</h1>');
    console.log('fallback page title:', await page.title());
  }
  const shot = path.join(__dirname, '..', '.state', 'playwright-smoke.png');
  await page.screenshot({ path: shot });
  console.log('screenshot:', shot);
  console.log('browser version:', browser.version());
  console.log('mode:', mode);
  await browser.close();
  console.log('SMOKE_OK');
})().catch(e => { console.error('SMOKE_FAIL:', e.message); process.exit(1); });
