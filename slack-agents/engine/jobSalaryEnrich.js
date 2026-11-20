'use strict';
/*
 * jobSalaryEnrich.js — salary-band capture for the harvest -> queue path
 * (Vikunja #1047, Nov 10, 2026).
 *
 * DIAGNOSIS (measured Nov 10, 2026): 187 of 199 submission-queue entries
 * carried no salary band. The downstream path (alertFeeder.normalize ->
 * jobPipeline.ingest -> jobSubmitter.buildQueue) passes salary fields
 * through untouched; the band was NEVER EXTRACTED:
 *   - Census of 147 real LinkedIn alert cards in 18 source emails: only 8
 *     card segments (5.4%) contain any salary text, and the card parser
 *     captured 8/8 of those. The alert email is not the problem.
 *   - Live-page sample of 15 queued LinkedIn candidates with no band:
 *     7/15 DO state an annual band on the posting itself (structured
 *     "Base pay range" block or description text), 7/15 state none,
 *     1/15 states monthly-only comp. The pipeline never fetched the
 *     posting, so those bands never entered the record (posting.json even
 *     says "fetch the posting before applying").
 *
 * WHAT THIS MODULE DOES: at queue-prepare time, for queued candidates
 * whose record still lacks a band and whose URL is a LinkedIn posting,
 * fetch the posting ONCE via LinkedIn's public guest API, extract the
 * band VERBATIM as shown (matched text, low, high, currency, period),
 * and transcribe it onto the candidate's posting.json (salaryMin /
 * salaryMax / salaryBand + provenance). Results — including "the posting
 * states no annual band" — are cached in jobs/salary-enrichment.json so
 * the 30-minute prepare cycle does not refetch: 'band' is permanent,
 * 'none' refreshes after 7 days, 'error' after 2 hours. Per-run fetches
 * are capped (MACF_SALARY_ENRICH_MAX, default 40).
 *
 * NOTHING IS INVENTED: only annual bands as stated are transcribed into
 * salaryMin/salaryMax. Monthly/hourly-only comp is recorded in the cache
 * as non-annual and never annualized into the annual fields. Computing
 * the figure to enter on a form stays the consumer's job (jobSubmitter
 * .salaryFigure under Jesse's banked rules).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE_FILE = 'salary-enrichment.json';
const DAY_MS = 86400000;
const DEFAULT_MAX_FETCH = 40;
const GUEST_API = (id) => `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`;

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n'); }

function linkedinJobId(url) {
  const m = String(url || '').match(/linkedin\.com\/jobs\/view\/(\d+)/i);
  return m ? m[1] : null;
}

/* ---------- verbatim band parsing ---------- */

function periodOf(text) {
  const t = String(text || '');
  if (/\/\s?(hr|hour)\b|per hour|hourly/i.test(t)) return 'hr';
  if (/\/\s?mo\b|\/month\b|per month|monthly/i.test(t)) return 'mo';
  if (/\/\s?(yr|year)\b|per year|annually|annual\b|a year/i.test(t)) return 'yr';
  return null;
}

/* Plausibility guard: keeps description noise (budgets, ARR, profit
 * examples) out of the band fields. Annual-scale unless a period says
 * otherwise. */
function plausible(low, high, period) {
  if (!(low > 0) || !(high >= low)) return false;
  if (period === 'hr') return low >= 5 && high <= 600;
  if (period === 'mo') return low >= 1000 && high <= 100000;
  return low >= 30000 && high <= 2000000;
}

/* One range: "$155,000.00/yr - $175,000.00/yr", "$180,000–$200,000
 * annually", "$150K-$250K / year", "$136000 - $259000", "$150-$240k"
 * (shared K: when only the second amount carries the K suffix and the
 * first is a bare sub-1000 number, the K applies to both). */
const RANGE_RE = /\$\s?([\d,]+(?:\.\d+)?)\s*([Kk])?(?:\s*\/\s?(?:yr|year|hr|hour))?\s*(?:-|–|—|to)\s*\$\s?([\d,]+(?:\.\d+)?)\s*([Kk])?(?:\s*\/\s?(?:yr|year|hr|hour))?/;
const SINGLE_RE = /\$\s?([\d,]+(?:\.\d+)?)\s*([Kk])?(\s*\/\s?(?:yr|year|hr|hour|month|mo)\b|\s+per\s+(?:year|month|hour)\b|\s+annually\b|\s+a\s+year\b)/;

function convAmount(v, k, otherK) {
  const n = parseFloat(String(v).replace(/,/g, ''));
  if (k) return Math.round(n * 1000);
  if (otherK && n < 1000) return Math.round(n * 1000); // shared-K inheritance
  return Math.round(n);
}

function bandFromRangeMatch(m, tail) {
  const low = convAmount(m[1], m[2], m[4]);
  const high = convAmount(m[3], m[4], m[2]);
  const period = periodOf(m[0] + ' ' + (tail || ''));
  if (!plausible(low, high, period)) return null;
  return { low, high, currency: 'USD', period, text: m[0].trim() };
}

/* Parse the first plausible salary band in a chunk of plain text.
 * Ranges are tried across the whole chunk; a single amount counts only
 * when it carries an explicit period marker ($225,000/year) — a bare
 * dollar figure in prose is not a band. Returns
 * { low, high, currency, period, text } or null. */
function parseBandText(text) {
  if (!text) return null;
  const t = String(text);
  const re = new RegExp(RANGE_RE.source, 'g');
  let m;
  while ((m = re.exec(t)) !== null) {
    const band = bandFromRangeMatch(m, t.slice(m.index + m[0].length, m.index + m[0].length + 20));
    if (band) return band;
  }
  const s = t.match(SINGLE_RE);
  if (s) {
    const low = convAmount(s[1], s[2], null);
    const period = periodOf(s[0]);
    if (plausible(low, low, period)) return { low, high: low, currency: 'USD', period, text: s[0].trim() };
  }
  return null;
}

/* ---------- posting HTML -> band ---------- */

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|section|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(Number(n)); } catch { return ' '; } })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n');
}

const SALARY_CONTEXT = /salary|compensation|pay range|base pay/i;

/* Extract the band from a LinkedIn guest-API posting fragment.
 * Precision order:
 *   1. LinkedIn's structured compensation block
 *      (<div class="salary compensation__salary">$X/yr - $Y/yr</div>);
 *   2. the first plausible range in the description whose surrounding
 *      context names it as salary/compensation/pay (keeps revenue,
 *      budget and ARR figures out);
 *   3. a single amount anchored to a salary phrase ("Base Salary
 *      Range: $180,000 annually" shape) — parseBandText on the anchored
 *      span, which still requires its own period/plausibility checks.
 * Returns the band plus `via`, or null when the posting states no band. */
function extractBandFromPostingHtml(html) {
  if (!html) return null;
  const raw = String(html);
  const structured = raw.match(/compensation__salary">([\s\S]{0,200}?)</);
  if (structured) {
    const band = parseBandText(htmlToText(structured[1]));
    if (band) return { ...band, via: 'structured' };
  }
  const text = htmlToText(raw);
  const re = new RegExp(RANGE_RE.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const ctx = text.slice(Math.max(0, m.index - 320), m.index) + ' ' + m[0];
    if (!SALARY_CONTEXT.test(ctx)) continue;
    const band = bandFromRangeMatch(m, text.slice(m.index + m[0].length, m.index + m[0].length + 20));
    if (band) return { ...band, via: 'description' };
  }
  // The anchor span may cross line breaks: posters often put the label
  // ("Compensation:") and the amount in separate paragraphs.
  const anchorRe = /(?:base salary|salary range|compensation range|compensation|salary|pay range)[^$]{0,80}?\$\s?[\d][^\n]{0,50}/gi;
  let a;
  while ((a = anchorRe.exec(text)) !== null) {
    const band = parseBandText(a[0]);
    if (band) return { ...band, via: 'description-single' };
  }
  return null;
}

/* ---------- fetching ---------- */

function fetchGuestPostingHtml(jobId, { timeoutMs = 15000, redirects = 0 } = {}) {
  return new Promise((resolve) => {
    const req = https.get(GUEST_API(jobId), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html',
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
        res.resume();
        fetchGuestPostingHtml(jobId, { timeoutMs, redirects: redirects + 1 }).then(resolve);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/* ---------- enrichment over queue entries ---------- */

/* For queue entries that still lack salaryMin/salaryMax and point at a
 * LinkedIn posting: fetch the posting (cached, capped, concurrency 4),
 * and transcribe any stated ANNUAL band onto the candidate's
 * posting.json. Non-annual-only comp is cached as 'none' with a note —
 * it is never annualized into the annual fields. Mutates posting.json
 * files and the cache; never touches applications.jsonl. Returns run
 * stats. */
async function enrichMissingBands({ sandbox, entries, maxFetch = DEFAULT_MAX_FETCH, fetchFn = fetchGuestPostingHtml, now = Date.now() } = {}) {
  const jobs = path.join(sandbox, 'jobs');
  const cacheFile = path.join(jobs, CACHE_FILE);
  const cache = readJson(cacheFile, {});
  const stats = { targets: 0, fetched: 0, bandsFound: 0, noBand: 0, errors: 0, cachedSkips: 0, cappedSkips: 0 };
  const pending = (entries || []).filter((e) => e && !e.salaryMin && !e.salaryMax && linkedinJobId(e.url));
  stats.targets = pending.length;
  let budget = maxFetch;

  async function handle(entry) {
    const slug = entry.slug;
    const jobId = linkedinJobId(entry.url);
    const postingFile = path.join(jobs, 'candidates', slug, 'posting.json');
    const posting = readJson(postingFile, null);
    if (!posting || posting.salaryMin || posting.salaryMax) return;
    const cached = cache[slug];
    if (cached && cached.status === 'band' && cached.band) {
      // Cache has a band the posting lost — restore without a fetch.
      posting.salaryMin = cached.band.low;
      posting.salaryMax = cached.band.high;
      posting.salaryBand = cached.band;
      posting.salarySource = 'linkedin-guest-posting';
      writeJson(postingFile, posting);
      stats.bandsFound++;
      return;
    }
    if (cached && cached.status === 'none' && now - Date.parse(cached.fetchedAt || 0) < 7 * DAY_MS) { stats.cachedSkips++; return; }
    if (cached && cached.status === 'error' && now - Date.parse(cached.fetchedAt || 0) < 2 * 3600000) { stats.cachedSkips++; return; }
    if (budget <= 0) { stats.cappedSkips++; return; }
    budget--;
    stats.fetched++;
    let html = null;
    try { html = await fetchFn(jobId); } catch { html = null; }
    if (!html) { // one paced retry: guest-API failures are usually transient rate limits
      await new Promise((r) => setTimeout(r, 1200));
      try { html = await fetchFn(jobId); } catch { html = null; }
    }
    await new Promise((r) => setTimeout(r, 500)); // pacing: stay a polite guest
    const fetchedAt = new Date(now).toISOString();
    if (!html) { cache[slug] = { jobId, status: 'error', fetchedAt }; stats.errors++; return; }
    const band = extractBandFromPostingHtml(html);
    if (band && (band.period === 'yr' || band.period == null)) {
      posting.salaryMin = band.low;
      posting.salaryMax = band.high;
      posting.salaryBand = {
        text: band.text, low: band.low, high: band.high, currency: band.currency,
        period: band.period, source: 'linkedin-guest-posting', via: band.via, fetchedAt,
      };
      posting.salarySource = 'linkedin-guest-posting';
      writeJson(postingFile, posting);
      cache[slug] = { jobId, status: 'band', band: posting.salaryBand, fetchedAt };
      stats.bandsFound++;
    } else {
      cache[slug] = {
        jobId, status: 'none',
        note: band ? `posting states a non-annual band only (period: ${band.period})` : 'posting states no salary band',
        fetchedAt,
      };
      stats.noBand++;
    }
  }

  const workers = [];
  const queue = [...pending];
  async function worker() { while (queue.length) { const e = queue.shift(); await handle(e); } }
  for (let i = 0; i < 4; i++) workers.push(worker());
  await Promise.all(workers);
  writeJson(cacheFile, cache);
  return stats;
}

module.exports = {
  linkedinJobId, periodOf, plausible, parseBandText, htmlToText,
  extractBandFromPostingHtml, fetchGuestPostingHtml, enrichMissingBands,
  CACHE_FILE, DEFAULT_MAX_FETCH,
};
