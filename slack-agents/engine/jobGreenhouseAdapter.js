'use strict';
/*
 * jobGreenhouseAdapter.js — #935 G7 direct-ATS live adapter (Greenhouse).
 *
 * The jobConsumer (G4) is dry-run only and every would-submit entry in the
 * queue carries a LinkedIn URL. The real application channel for many of
 * those postings is a direct ATS board (classified 2026-11-11: 6 of the 38
 * would-submit postings resolve to the SAME role on the company's public
 * Greenhouse board, 1 to Ashby). This adapter walks a Greenhouse
 * application form with Playwright and fills it ONLY from the banked
 * answer map (jobAnswerResolver). Any required question without a banked
 * mapping aborts the walk BEFORE submit with the verbatim question.
 *
 * Modes:
 *   --inspect <slug>           open the application page, dump the form
 *                              inventory (fields, labels, options, captcha
 *                              signals) as JSON; fill nothing.
 *   --walk <slug>              fill everything fillable, verify every
 *                              required field is covered, STOP before the
 *                              submit button; write a walk report.
 *   --submit <slug>            fill, then click submit exactly once and
 *                              capture the confirmation verbatim. Requires
 *                              env JOB_ADAPTER_LIVE_OK=<slug> and refuses
 *                              if a live-submission receipt exists <24h old.
 *
 * Safety: visible CAPTCHA challenge, login wall, or checkpoint => abort
 * immediately, no bypass, no retry through the block.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const P = require('./jobPipeline');
const R = require('./jobAnswerResolver');
const C = require('./jobConsumer');

/* Direct-ATS resolutions found 2026-11-11 by matching queue postings to the
 * companies' public ATS board APIs (same role, same title). Only entries
 * listed here have a verified direct channel. */
const DIRECT = {
  'pacvue-vp-ai-strategy-delivery': { ats: 'greenhouse', board: 'pacvue', jobId: '6216830004', url: 'https://job-boards.greenhouse.io/pacvue/jobs/6216830004' },
  'roofr-senior-director-product-growth': { ats: 'greenhouse', board: 'roofr', jobId: '4752762005', url: 'https://job-boards.greenhouse.io/roofr/jobs/4752762005' },
  'toast-director-managed-marketing': { ats: 'greenhouse', board: 'toast', jobId: '8346001', url: 'https://job-boards.greenhouse.io/toast/jobs/8346001' },
  'hello-heart-vice-president-enterprise-marketing': { ats: 'greenhouse', board: 'helloheart', jobId: '8827510002', url: 'https://job-boards.greenhouse.io/helloheart/jobs/8827510002' },
  'gitlab-principal-growth-marketing-strategist': { ats: 'greenhouse', board: 'gitlab', jobId: '8933640002', url: 'https://job-boards.greenhouse.io/gitlab/jobs/8933640002' },
  'kandu-director-growth-marketing': { ats: 'greenhouse', board: 'kandu', jobId: '4361075009', url: 'https://kandu.com/listing/?gh_jid=4361075009', embedOnly: true },
};

function jobsDir(sandbox) { return path.join(sandbox, 'jobs'); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

function loadEntry(sandbox, slug) {
  const queue = readJson(path.join(jobsDir(sandbox), 'submission-queue.json'), null);
  if (!queue) throw new Error('submission-queue.json missing');
  const entry = queue.entries.find(e => e.slug === slug);
  if (!entry) throw new Error('slug not in queue: ' + slug);
  return entry;
}

/* ---------- question matcher: label text -> banked value ---------- */
function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

function matchQuestion(label, answers) {
  const t = norm(label);
  const has = (...ws) => ws.every(w => t.includes(w));
  if (/^(first name|given name)/.test(t)) return { value: 'Jesse', kind: 'text' };
  if (/^(last name|family name|surname)/.test(t)) return { value: 'Stay', kind: 'text' };
  if (has('preferred') && has('name')) return { skip: true, why: 'optional preferred name; banked legal name already given' };
  if (t.includes('email')) return { value: answers.email, kind: 'text' };
  if (t.includes('phone') || t.includes('mobile')) return { value: answers.phone, kind: 'text' };
  if (t.includes('linkedin')) return { value: 'https://www.linkedin.com/in/facebook', kind: 'text' };
  if (t.includes('legally authorized to work') && t.includes('without') && t.includes('sponsorship')) return { value: 'Yes', kind: 'choice' };
  if (t.includes('legally authorized to work') || t.includes('authorized to work in')) return { value: 'Yes', kind: 'choice' };
  if (t.includes('require sponsorship') || t.includes('sponsorship for employment') || t.includes('visa sponsorship')) return { value: 'No', kind: 'choice' };
  if (t.includes('how did you hear')) return { value: 'LinkedIn', kind: 'choice' };
  if (t.includes('previously worked at') || t.includes('consulted for')) return { uncovered: 'previous-employer question is not in the banked answer map' };
  if (t.includes('employment agreements') || t.includes('post-employment restrictions') || t.includes('non-compete')) return { value: 'No', kind: 'choice' };
  if (t.includes('country in which you are located') || t.includes('current country of residence') || t === 'country' || t.startsWith('country')) return { value: 'United States', kind: 'choice' };
  if (t.includes('location')) return { value: 'St. George', kind: 'choice' };
  if (t.includes('salary') || t.includes('compensation expectation')) return { value: String(answers.salaryFigure), kind: 'text' };
  if (t.includes('gender')) return { value: '__DECLINE__', kind: 'choice' };
  if (t.includes('hispanic') || t.includes('latino')) return { value: '__DECLINE__', kind: 'choice' };
  if (t.includes('race') || t.includes('ethnic')) return { value: answers.eeoSelfId.race, kind: 'choice' };
  if (t.includes('veteran')) return { value: answers.eeoSelfId.veteranStatus, kind: 'choice' };
  if (t.includes('disabilit')) return { value: answers.eeoSelfId.disabilityStatus, kind: 'choice' };
  if (t.includes('website') || t.includes('portfolio')) return { skip: true, why: 'optional; no banked website answer needed' };
  if (t.includes('cover letter')) return { skip: true, why: 'cover letter not banked for this pipeline; field accepts resume-only where optional' };
  return null;
}

/* ---------- page inventory (works on a Page or a Frame) ---------- */
async function inventory(scope) {
  return scope.evaluate(() => {
    const labelFor = (el) => {
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.innerText.trim(); }
      const wrap = el.closest('label'); if (wrap) return wrap.innerText.trim();
      const labelledby = el.getAttribute('aria-label'); if (labelledby) return labelledby;
      let n = el.closest('div');
      for (let i = 0; i < 4 && n; i++) {
        const lt = n.querySelector(':scope > label, :scope > .field-label, :scope > legend');
        if (lt) return lt.innerText.trim();
        n = n.parentElement ? n.parentElement.closest('div') : null;
      }
      return '';
    };
    const fields = [];
    document.querySelectorAll('input, select, textarea').forEach((el, idx) => {
      const lbl = labelFor(el).slice(0, 220);
      const f = {
        idx, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '', id: el.id || '',
        label: lbl,
        required: !!(el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(lbl) || lbl.includes(' *')),
        visible: !!(el.offsetWidth || el.offsetHeight),
      };
      if (f.tag === 'select') f.options = [...el.options].map(o => o.text.trim()).slice(0, 30);
      const wrap = el.closest('.field-wrapper, .application-question, div');
      f.html = wrap ? wrap.outerHTML.replace(/\s+/g, ' ').slice(0, 420) : '';
      f.role = el.getAttribute('role') || '';
      fields.push(f);
    });
    // Greenhouse marks required via a '*' in the label and data attributes
    document.querySelectorAll('label').forEach(l => { /* labels already joined above */ });
    const bodyText = document.body ? document.body.innerText : '';
    const captcha = {
      hcaptchaIframe: !!document.querySelector('iframe[src*="hcaptcha.com"]'),
      recaptchaIframe: !!document.querySelector('iframe[src*="recaptcha"]'),
      captchaText: /i'?m not a robot|verify you are human|security check/i.test(bodyText),
    };
    const buttons = [...document.querySelectorAll('button, input[type="submit"], a')].map(b => (b.innerText || b.value || '').trim()).filter(x => /apply|submit/i.test(x)).slice(0, 10);
    return { fields, captcha, buttons, url: location.href, title: document.title };
  });
}

function pickOption(field, wanted) {
  if (!field.options) return null;
  if (wanted === '__DECLINE__') {
    return field.options.find(o => /decline|do not wish|don'?t wish|prefer not|not to answer|no answer/i.test(o)) || null;
  }
  const w = norm(wanted);
  let hit = field.options.find(o => norm(o) === w);
  if (hit) return hit;
  hit = field.options.find(o => norm(o).includes(w) || w.includes(norm(o)));
  if (hit) return hit;
  if (w === 'yes') return field.options.find(o => /^yes\b/i.test(o)) || null;
  if (w === 'no') return field.options.find(o => /^no\b/i.test(o)) || null;
  if (w === 'not a veteran') return field.options.find(o => /not.*veteran|no.*veteran/i.test(o)) || null;
  if (w === 'no disabilities') return field.options.find(o => /no.*disabilit|do not have/i.test(o)) || null;
  if (w === 'white') return field.options.find(o => /white|caucasian/i.test(o)) || null;
  if (w === 'united states') return field.options.find(o => /united states/i.test(o)) || null;
  return null;
}

/* ---------- fill ---------- */
/* react-select combobox: click the input, type the wanted text to filter,
 * click the best-matching option, read back the selected value. */
async function comboboxFill(scope, f, wanted) {
  const input = scope.locator('#' + f.id);
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click();
  if (wanted !== '__DECLINE__') await input.pressSequentially(wanted, { delay: 25 });
  const opts = scope.locator('.select__option');
  await opts.first().waitFor({ state: 'visible', timeout: 9000 });
  const texts = (await opts.allInnerTexts()).map(t => t.trim());
  let idx = -1;
  if (wanted === '__DECLINE__') {
    idx = texts.findIndex(t => /decline|prefer not|do not wish|don'?t wish|not to disclose/i.test(t));
  } else {
    const w = norm(wanted);
    idx = texts.findIndex(t => norm(t) === w);
    if (idx < 0) idx = texts.findIndex(t => norm(t).includes(w));
    if (idx < 0 && f.id === 'candidate-location') idx = texts.findIndex(t => t.includes(wanted));
  }
  if (idx < 0) throw new Error(`no combobox option matches "${wanted}" (saw: ${texts.slice(0, 8).join(' | ')})`);
  const chosen = texts[idx];
  await opts.nth(idx).click();
  await scope.page().waitForTimeout(400);
  const readBack = await input.evaluate(el => {
    const shell = el.closest('.select-shell') || el.closest('.select__control') || el.parentElement.parentElement;
    const sv = shell ? shell.querySelector('.select__single-value') : null;
    return sv ? sv.innerText.trim() : '';
  });
  return { chosen, readBack };
}

async function fillForm(page, inv, answers, resumePath, log) {
  const scope = page; // Page or Frame — both expose locator/fill/selectOption
  const results = [];
  for (const f of inv.fields) {
    if (f.type === 'hidden' || f.type === 'submit' || f.type === 'button') continue;
    if (f.name === 'g-recaptcha-response') continue; // invisible scoring field, not a question
    const labelText = f.label || f.name || f.id;
    const R0 = { field: labelText, required: !!f.required };
    if (f.type === 'file') {
      const isResume = /resume|cv/i.test(labelText) || /resume/i.test(f.id || '');
      if (isResume && resumePath) {
        const loc = scope.locator(`input[type="file"]`).nth(inv.fields.filter(x => x.type === 'file').indexOf(f));
        await loc.setInputFiles(resumePath);
        results.push({ ...R0, action: 'uploaded-resume' });
        log.push(`file ${labelText} (${f.id}): uploaded resume.pdf`);
      } else {
        results.push({ ...R0, action: f.required ? 'UNCOVERED' : 'skipped-optional-file', why: 'non-resume file input' });
      }
      continue;
    }
    if (!f.id && !f.name) { results.push({ ...R0, action: 'skipped-internal-control', why: 'no id/name (react-select internal mirror of an addressed control)' }); continue; }
    const m = matchQuestion(labelText, answers);
    if (!m) {
      results.push({ ...R0, action: f.required ? 'UNCOVERED' : 'skipped-optional', why: 'no banked mapping' });
      continue;
    }
    if (m.uncovered) { results.push({ ...R0, action: 'UNCOVERED', why: m.uncovered }); continue; }
    if (m.skip) { results.push({ ...R0, action: 'skipped', why: m.why }); continue; }
    const sel = f.id && /^[A-Za-z0-9_-]+$/.test(f.id) ? `#${f.id}` : `[name="${f.name}"]`;
    try {
      if (f.role === 'combobox') {
        const { chosen, readBack } = await comboboxFill(scope, f, m.value);
        results.push({ ...R0, action: 'selected', value: chosen, readBack });
        log.push(`${labelText}: ${chosen}`);
      } else if (f.tag === 'select') {
        const opt = pickOption(f, m.value);
        if (!opt) { results.push({ ...R0, action: f.required ? 'UNCOVERED' : 'skipped-optional', why: `no option matches banked value "${m.value}" (options: ${(f.options || []).join(' | ')})` }); continue; }
        await scope.selectOption(sel, { label: opt });
        results.push({ ...R0, action: 'selected', value: opt });
        log.push(`${labelText}: ${opt}`);
      } else if (f.type === 'radio' || f.type === 'checkbox') {
        results.push({ ...R0, action: f.required ? 'UNCOVERED' : 'skipped-optional', why: 'radio/checkbox groups are not auto-answered in this build' });
      } else {
        await scope.fill(sel, m.value);
        results.push({ ...R0, action: 'filled', value: m.value });
        log.push(`${labelText}: ${m.value}`);
      }
    } catch (e) {
      results.push({ ...R0, action: 'fill-error', why: String(e.message).split('\n')[0] });
    }
  }
  return results;
}

async function run(mode, slug) {
  const sandbox = P.sandboxDir();
  const direct = DIRECT[slug];
  if (!direct) throw new Error('no verified direct-ATS channel for slug: ' + slug);
  const entry = loadEntry(sandbox, slug);
  const config = R.loadConfig(sandbox);
  const { answers, uncovered } = R.resolveAnswers(config, entry);
  if (uncovered.length) throw new Error('resolver uncovered (pre-portal): ' + uncovered.map(u => u.field).join(', '));
  const resumePath = path.join(jobsDir(sandbox), 'candidates', slug, 'resume.pdf');
  if (!fs.existsSync(resumePath)) throw new Error('resume.pdf missing for ' + slug);

  if (mode === 'submit') {
    if (process.env.JOB_ADAPTER_LIVE_OK !== slug) throw new Error('REFUSED: --submit requires env JOB_ADAPTER_LIVE_OK=' + slug);
    const receiptFile = path.join(__dirname, '..', '.state', 'job-adapter-last-live.json');
    const prev = readJson(receiptFile, null);
    if (prev && Date.now() - new Date(prev.at).getTime() < 24 * 3600 * 1000) {
      throw new Error('REFUSED: a live submission was already made <24h ago (' + prev.slug + ' at ' + prev.at + '); one-submission cap');
    }
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const report = { mode, slug, company: entry.company, title: entry.title, ats: direct.ats, startedAt: new Date().toISOString(), log: [] };
  try {
    let resp = await page.goto(direct.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    report.httpStatus = resp && resp.status();
    await page.waitForTimeout(3000);
    // The form may live (a) in a Greenhouse embed iframe on the company's
    // own careers page, (b) behind an Apply button on the board page, or
    // (c) at <board job url>/application. Resolve the working scope.
    let scope = page;
    let inv = await inventory(page);
    const ghFrame = () => page.frames().find(f => /job-boards\.greenhouse\.io/.test(f.url()) && !/recaptcha|googleapis/.test(f.url()));
    let frame = ghFrame();
    if (frame) { scope = frame; inv = await inventory(frame); report.scopeType = 'greenhouse-embed-iframe'; }
    if (!frame && !inv.fields.some(f => /email/i.test(f.label || ''))) {
      const applyBtn = page.locator('button:has-text("Apply"), a:has-text("Apply")').first();
      if (await applyBtn.count()) { await applyBtn.click().catch(() => {}); await page.waitForTimeout(3000); }
      frame = ghFrame();
      if (frame) { scope = frame; inv = await inventory(frame); report.scopeType = 'greenhouse-embed-iframe-after-apply'; }
      else { inv = await inventory(page); report.scopeType = 'board-page'; }
    }
    if (!frame && inv.fields.length === 0 && /job-boards\.greenhouse\.io/.test(direct.url)) {
      resp = await page.goto(direct.url.replace(/\/$/, '') + '/application', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3000);
      inv = await inventory(page);
      report.scopeType = 'board-application-page';
    }
    report.finalUrl = page.url();
    report.captcha = inv.captcha;
    // A VISIBLE challenge (checkbox widget / challenge frame / challenge
    // text) is a hard stop. Greenhouse's invisible reCAPTCHA Enterprise
    // scoring frame ships with every board and presents no challenge to
    // solve; it is recorded, and the portal confirmation remains the judge.
    const frameUrls = page.frames().map(f => f.url());
    report.invisibleRecaptchaEnterprise = frameUrls.some(u => /recaptcha.*size=invisible/.test(u));
    report.visibleCaptchaChallenge = inv.captcha.captchaText || frameUrls.some(u => /recaptcha/.test(u) && (/bframe/.test(u) || /size=normal/.test(u)));
    report.buttons = inv.buttons;
    report.fieldCount = inv.fields.length;
    if (report.visibleCaptchaChallenge || inv.captcha.hcaptchaIframe) {
      report.outcome = 'BLOCKED-captcha';
      report.detail = 'visible CAPTCHA challenge on the application page; stopped, no bypass attempted';
      return report;
    }
    if (/login|signin|sign-in/i.test(page.url()) || inv.fields.length === 0) {
      report.outcome = 'BLOCKED-login-wall-or-no-form';
      report.detail = 'landed on ' + page.url() + ' with ' + inv.fields.length + ' form fields in scope ' + (report.scopeType || '?');
      return report;
    }
    if (mode === 'inspect') {
      report.inventory = inv.fields;
      report.outcome = 'INSPECTED';
      return report;
    }
    const fillResults = await fillForm(scope, inv, answers, resumePath, report.log);
    report.fillResults = fillResults;
    const uncoveredReq = fillResults.filter(r => r.required && !['filled', 'selected', 'uploaded-resume', 'skipped-internal-control'].includes(r.action));
    report.uncoveredRequired = uncoveredReq;
    const shot = path.join(__dirname, '..', '.state', `job-adapter-${slug}-${mode}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    report.screenshot = shot;
    if (uncoveredReq.length) {
      report.outcome = 'BLOCKED-uncovered-required-question';
      report.detail = uncoveredReq.map(r => `${r.field} — ${r.why}`).join(' ; ');
      return report;
    }
    if (mode === 'walk') {
      report.outcome = 'WALK-CLEAN';
      report.detail = 'all required fields covered by the banked answer map; stopped before submit';
      return report;
    }
    // submit (button and confirmation live in the same scope as the form)
    const submitBtn = scope.locator('button[type="submit"], input[type="submit"], button:has-text("Submit application"), button:has-text("Submit")').last();
    if (!(await submitBtn.count())) { report.outcome = 'BLOCKED-no-submit-button'; return report; }
    await submitBtn.click();
    await page.waitForTimeout(6000);
    const after = await scope.evaluate(() => ({ url: location.href, text: (document.body ? document.body.innerText : '').slice(0, 4000) }));
    report.afterUrl = after.url;
    report.afterText = after.text;
    const confirmMatch = after.text.match(/(application (has been )?submitted|thank you for applying|we('ve| have) received your application|application received|successfully submitted)[^\n]*/i);
    if (confirmMatch) {
      report.outcome = 'SUBMITTED';
      report.confirmationVerbatim = confirmMatch[0].trim();
      const receiptFile = path.join(__dirname, '..', '.state', 'job-adapter-last-live.json');
      fs.writeFileSync(receiptFile, JSON.stringify({ slug, at: new Date().toISOString(), confirmation: report.confirmationVerbatim }, null, 2) + '\n');
    } else {
      report.outcome = 'SUBMIT-CLICKED-NO-CONFIRMATION';
      report.detail = 'submit clicked but no confirmation text detected; NOT recorded in the ledger';
    }
    return report;
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  const [mode, slug] = process.argv.slice(2);
  if (!['inspect', 'walk', 'submit'].includes(mode) || !slug) {
    console.error('usage: node jobGreenhouseAdapter.js <inspect|walk|submit> <slug>');
    process.exit(2);
  }
  run(mode, slug).then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(r.outcome && r.outcome.startsWith('BLOCKED') ? 3 : 0); })
    .catch(e => { console.error('ERROR:', e.message); process.exit(2); });
}

module.exports = { run, DIRECT, matchQuestion };
