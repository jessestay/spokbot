// Builds tests/fixtures/user-stories.fixture.json — the FRAMEWORK-COPY
// registry fixture used by the lint tests. It is generated from the
// pristine production baseline snapshot
// (~/workspace/spokbot-build/baseline-server/slack-agents/engine/.user-stories.json),
// which is never edited. The transformations are exactly the ones the
// F12 backfill prescribes, and each is enumerated here so the fixture's
// provenance is reproducible:
//
//   1. Step-B references (2026-11-18): the eight zero-test stories that
//      gained BDD+TDD in the framework tree (US-110, US-113, US-114,
//      US-116, US-117, US-119, US-122, US-123) get their feature/suite
//      paths; US-115 gains its BDD feature (its TDD ref already
//      existed). US-120 and US-121 stay empty — step-B findings: their
//      components are instance-side, absent from the framework tree.
//   2. US-112 / US-113 criterion repairs: each story carried one
//      criterion in compressed "Given …, Then …" form with no explicit
//      "When" (measured by US-FW-003's lint). The missing When clause
//      is inserted, wording otherwise unchanged. The PRODUCTION
//      registry gets this same repair at its first post-cutover edit;
//      until then only this fixture carries it.
//   3. Step-C feature stories (2026-11-18): three NEW stories
//      (US-FW-018, US-FW-025, US-FW-031 — story documents of the same
//      IDs live in stories/) adopt the tree's 3 orphaned feature
//      files, which the linkage lint can only link via registry
//      references. US-FW-031 carries BDD only: the PM-breakdown
//      component exists but has no automated suite, and the fixture
//      records that gap (a no-TDD lint warning) instead of inventing
//      a reference. The production registry receives these stories
//      at the same first post-cutover edit; `nextId` is untouched
//      (it sequences the US-1xx series, not US-FW ids).
//   4. Step-D TDD closure (2026-11-19): US-FW-031's missing suite
//      now exists (engine/tests/pm-breakdown.test.js — 26 tests
//      pinning ceoToPm routing/shape and pmBreakdown's gateway
//      prompt/parse behavior), so the story gains its TDD reference
//      and the BDD-only gap recorded in (3) is closed. Two of the
//      story's criteria legs remain unimplemented in the component
//      (Vikunja subtask writes; clarifying questions) — the suite
//      records that in its header instead of inventing coverage.
//
// Usage: node tests/fixtures/build-fixture.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const baselinePath = path.join(os.homedir(),
  'workspace/spokbot-build/baseline-server/slack-agents/engine/.user-stories.json');
const outPath = path.join(import.meta.dirname, 'user-stories.fixture.json');

const data = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const stories = Array.isArray(data) ? data : data.stories;
const byId = Object.fromEntries(stories.map(s => [s.id, s]));

const STEP_B_REFS = {
  'US-110': ['engine/features/us-110-weekly-content-batch.feature', 'engine/tests/us-110-content-batch.test.js'],
  'US-113': ['engine/features/us-113-social-publishing.feature', 'engine/tests/us-113-social-publishing.test.js'],
  'US-114': ['engine/features/us-114-seo-changes.feature', 'engine/tests/us-114-seo-changes.test.js'],
  'US-116': ['engine/features/us-116-capability-audit.feature', 'engine/tests/us-116-capability-audit.test.js'],
  'US-117': ['engine/features/us-117-dead-letter-inspection.feature', 'engine/tests/us-117-dead-letter.test.js'],
  'US-119': ['engine/features/us-119-finance-snapshot.feature', 'engine/tests/us-119-finance-snapshot.test.js'],
  'US-122': ['engine/features/us-122-demo-relay.feature', 'engine/tests/us-122-demo-relay.test.js'],
  'US-123': ['engine/features/us-123-watchdog-liveness.feature', 'engine/tests/us-123-watchdog-liveness.test.js'],
};
for (const [id, [bdd, tdd]] of Object.entries(STEP_B_REFS)) {
  byId[id].bdd_tests = [bdd];
  byId[id].tdd_tests = [tdd];
}
byId['US-115'].bdd_tests = ['engine/features/us-115-deliverables-counted-when-sent.feature'];

// Criterion repairs: insert the missing "When" clause, nothing else.
function repair(story, from, to) {
  const i = story.acceptance_criteria.indexOf(from);
  if (i === -1) throw new Error(`${story.id}: criterion to repair not found verbatim`);
  story.acceptance_criteria[i] = to;
}
repair(byId['US-112'],
  'Given a ledger write failure, Then the failure is loud in the run log and the prior ledger stays intact.',
  'Given a ledger write failure, When the write is attempted, Then the failure is loud in the run log and the prior ledger stays intact.');
repair(byId['US-113'],
  'Given no approval, Then nothing publishes.',
  'Given no approval, When the publish step runs, Then nothing publishes.');

// Step-C feature stories: adopt the 3 orphaned feature files.
const DOD = stories[0].definition_of_done;
const STEP_C_STORIES = [
  {
    id: 'US-FW-018',
    title: 'As a Spokbot operator, I want Vikunja supervised by a watchdog that restarts it with setsid and never kills itself, so that the team\'s board survives session teardown and never dies silently',
    story_points: 3,
    acceptance_criteria: [
      'Given Vikunja is not responding on 127.0.0.1:3456, When the watchdog runs its liveness probe, Then it detects the failure, kills any stale Vikunja process with an anchored pkill, and relaunches it via start.sh so it responds within 10 seconds',
      'Given Vikunja was started by start.sh, When the parent exec session terminates, Then Vikunja continues running and still responds on 127.0.0.1:3456 (the setsid invariant)',
      'Given Vikunja is responding, When the watchdog probes, Then it does not kill or restart it, and start.sh exits 0 immediately (idempotent, probe-first)',
      'Given the watchdog executes the restart sequence, When it runs pkill, Then the pattern is anchored with ^ and the watchdog\'s own process is not matched',
    ],
    bdd_tests: ['engine/vikunja-supervision.feature'],
    tdd_tests: ['engine/tests/vikunja-supervision.test.js'],
    status: 'in-progress',
    sprint_id: null,
    created_at: '2026-11-18T00:00:00.000Z',
    definition_of_done: DOD,
  },
  {
    id: 'US-FW-025',
    title: 'As a Spokbot operator, I want the autonomous driver verifiably scheduled, so that a working driver script with no schedule is detected as a critical defect instead of agents going silent',
    story_points: 3,
    acceptance_criteria: [
      'Given the schedules manifest, When it is validated, Then autonomous-agent-driver is declared with id, cadence, command, owner, and purpose, and no schedule id is duplicated',
      'Given the driver script exists but the autonomous-agent-driver schedule is absent from the runtime, When check-schedules runs, Then it reports the driver MISSING and CRITICAL and exits 1; given the schedule present, Then it reports OK and exits 0',
      'Given every agent in the roster, When the autonomous interface is checked, Then each agent exposes runAutonomous() and the CFO\'s run produces its dashboard artifact',
    ],
    bdd_tests: ['engine/autonomous-schedule.feature'],
    tdd_tests: ['engine/tests/autonomous-agent.test.js', 'engine/tests/schedule-manifest.test.js'],
    status: 'in-progress',
    sprint_id: null,
    created_at: '2026-11-18T00:00:00.000Z',
    definition_of_done: DOD,
  },
  {
    id: 'US-FW-031',
    title: 'As the CEO of the Spokbot team, I want requirements broken down into assigned user stories by the PM, so that a content or visual requirement becomes platform-sized stories with acceptance criteria on the board instead of one vague ask',
    story_points: 3,
    acceptance_criteria: [
      'Given the CEO sends a content requirement via ceoToPm spanning X, Facebook, and TikTok, When the PM processes it, Then it produces one user story per platform, each with acceptance criteria, assigned to the CMO, written to Vikunja as subtasks',
      'Given a visual requirement, When the PM processes it, Then it produces feed and stories stories specifying dimensions and style, assigned to the CUXO',
      'Given a requirement with missing acceptance criteria, When the PM processes it, Then it identifies the gaps, posts clarifying questions to the CEO, and creates no stories until the CEO responds',
    ],
    bdd_tests: ['engine/pm-breakdown.feature'],
    tdd_tests: [],
    status: 'in-progress',
    sprint_id: null,
    created_at: '2026-11-18T00:00:00.000Z',
    definition_of_done: DOD,
  },
];
for (const s of STEP_C_STORIES) {
  if (byId[s.id]) throw new Error(`${s.id} already exists in the baseline registry`);
  stories.push(s);
}

// Step-D transformation (4): close US-FW-031's recorded TDD gap.
stories.find(s => s.id === 'US-FW-031').tdd_tests = ['engine/tests/pm-breakdown.test.js'];

const out = Array.isArray(data) ? stories : { ...data, stories };
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${outPath}: ${stories.length} stories`);
