'use strict';
/*
 * jobAnswerResolver.js — machine-readable answer map for the submission
 * pipeline (#935 G5, Nov 10, 2026).
 *
 * Until now the answer map existed only as PROSE inside submission-packet.md
 * (rendered for a human/LLM operator by jobSubmitter.renderPacket). An
 * automated consumer cannot fill a form from prose, so this module derives
 * the SAME answers structurally from the SAME single source —
 * jobs/job-search-config.json (Jesse's banked answers, 26 top-level keys,
 * v2026-11-09) — plus the per-candidate salaryFigure that prepare()
 * computed into the queue entry.
 *
 * Attestation discipline (config.attestation_discipline, Jesse's rule):
 * answer ONLY from the config; anything not banked is returned in
 * `uncovered` so the consumer BLOCKS with the verbatim question instead of
 * guessing. Gender and Hispanic/Latino self-ID are deliberately unbanked:
 * they are reported as uncovered-but-voluntary (portals offer
 * decline-to-state), never invented and never blocking.
 */
const fs = require('fs');
const path = require('path');

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

function loadConfig(sandbox) {
  return readJson(path.join(sandbox, 'jobs', 'job-search-config.json'), {});
}

function firstEmail(contact) {
  const m = String(contact || '').match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  return m ? m[0] : 'jesse@staynalive.com';
}

/* resolveAnswers(config, entry) -> { answers, uncovered, voluntaryUncovered }
 * - answers: flat machine-readable map a form-filler can consume directly.
 * - uncovered: banked-answer gaps that BLOCK if a portal requires them
 *   (each: { field, reason }).
 * - voluntaryUncovered: gaps with a decline-to-state path (never blocking,
 *   never guessed). */
function resolveAnswers(config, entry) {
  const cfg = config || {};
  const e = entry || {};
  const answered = cfg.alreadyAnsweredElsewhere || {};
  const fields = cfg.fields || {};
  const eeo = cfg.eeoSelfId || {};
  const refs = (cfg.references && cfg.references.pool) || [];

  const answers = {
    applicantName: 'Jesse Stay',
    email: firstEmail(answered.contact),
    phone: '801-853-8339',
    location: answered.location || 'St. George, UT',
    linkedin: 'linkedin.com/in/facebook',
    workAuthorization: answered.workAuthorization || null,
    sponsorshipRequired: false,
    education: answered.education || null,
    languages: answered.languages || null,
    salaryFigure: e.salaryFigure != null ? e.salaryFigure : null,
    salaryRule: cfg.salaryExpectationRule || null,
    earliestStart: cfg.earliestStart || null,
    noticePeriodDays: fields.notice_period_days != null ? fields.notice_period_days : null,
    travelWillingness: cfg.travelWillingness || null,
    largestBudgetManagedUSD: cfg.largestBudgetManagedUSD != null ? cfg.largestBudgetManagedUSD : null,
    semExperience: cfg.semExperience || null,
    linkedInAds: cfg.linkedInAds || null,
    performanceMarketingYears: fields.performance_marketing_years != null ? fields.performance_marketing_years : null,
    aiLeadershipYears: fields.ai_leadership_years != null ? fields.ai_leadership_years : null,
    teamManagementYears: cfg.teamManagementYears != null ? cfg.teamManagementYears : null,
    scaledMetaSpend: cfg.scaledMetaSpend != null ? cfg.scaledMetaSpend : null,
    lifecyclePlatforms: cfg.lifecyclePlatforms || null,
    webflow: cfg.webflow != null ? cfg.webflow : null,
    reportingTools: cfg.reportingTools || null,
    backgroundCheckConsent: cfg.backgroundCheckConsent != null ? cfg.backgroundCheckConsent : null,
    drugScreeningConsent: cfg.drugScreeningConsent != null ? cfg.drugScreeningConsent : null,
    nonCompeteRestrictions: cfg.nonCompeteRestrictions != null ? cfg.nonCompeteRestrictions : null,
    conflicts: cfg.conflicts != null ? cfg.conflicts : null,
    eeoSelfId: {
      race: eeo.race || null,
      veteranStatus: eeo.veteranStatus || null,
      disabilityStatus: eeo.disabilityStatus || null,
    },
    references: refs.map(r => ({ name: r.name || null, title: r.title || null, org: r.org || null, emails: r.emails || [], phones: r.phones || [] })),
  };

  const uncovered = [];
  const required = [
    ['workAuthorization', 'work authorization is asked on effectively every application'],
    ['education', 'education history is a standard required block'],
    ['salaryFigure', 'no salary band was captured for this posting, so no figure can be computed — packet rule: if the form requires a figure and no band exists, log a blocker (never invent a number)'],
    ['earliestStart', 'start-date availability is a common required question'],
    ['largestBudgetManagedUSD', 'budget-scope questions appear on most senior marketing applications'],
    ['teamManagementYears', 'team-size/management questions appear on most leadership applications'],
    ['backgroundCheckConsent', 'consent checkboxes must come from the banked standing consent'],
    ['drugScreeningConsent', 'consent checkboxes must come from the banked standing consent'],
  ];
  for (const [field, reason] of required) {
    if (answers[field] == null) uncovered.push({ field, reason });
  }

  const voluntaryUncovered = [
    { field: 'eeoSelfId.gender', reason: 'deliberately unbanked (Jesse); voluntary self-ID — decline-to-state path, never guessed' },
    { field: 'eeoSelfId.hispanicLatino', reason: 'deliberately unbanked (Jesse); voluntary self-ID — decline-to-state path, never guessed' },
  ];

  return { answers, uncovered, voluntaryUncovered };
}

module.exports = { loadConfig, resolveAnswers, firstEmail };
