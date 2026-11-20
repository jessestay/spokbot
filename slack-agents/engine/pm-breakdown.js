/**
 * PM Breakdown — uses LLM reasoning to turn CEO requirements into user stories.
 * 
 * BDD: pm-breakdown.feature
 * TDD: Tests below validate structure before LLM integration.
 */

const http = require('http');

const GATEWAY_URL = 'http://127.0.0.1:4001/v1/chat/completions';

/**
 * Call the gateway (PM's LLM reasoning)
 */
function callGateway(messages, maxTokens = 2000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'muse-spark-1.3',
      messages,
      max_tokens: maxTokens
    });
    
    const options = {
      hostname: '127.0.0.1',
      port: 4001,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (result.choices && result.choices[0]) {
            resolve(result.choices[0].message.content);
          } else if (result.error) {
            reject(new Error('Gateway error: ' + result.error));
          } else {
            reject(new Error('Unexpected gateway response: ' + body.substring(0, 200)));
          }
        } catch (e) {
          reject(new Error('Gateway parse error: ' + body.substring(0, 200)));
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Gateway timeout'));
    });
    req.write(data);
    req.end();
  });
}

/**
 * PM breaks a requirement into user stories using LLM reasoning.
 * @param {Object} req - structured requirement from ceoToPm()
 * @returns {Promise<Array>} - user stories with acceptance criteria
 */
async function pmBreakdown(req) {
  const prompt = `You are the PM (execPM) for a MACF AI team. Break this requirement into user stories.

Requirement:
- Type: ${req.type}
- Title: ${req.title}
- Description: ${req.description}
- Assigned role: ${req.assignedRole}

For each user story, provide:
1. Title (clear, actionable)
2. User story ("As a [who], I [want] so that [why]")
3. Acceptance criteria (numbered list, testable)
4. Assigned to: ${req.assignedRole}

Output as JSON array. No markdown, just JSON.
Example:
[{"title": "...", "story": "As a...", "acceptance": ["1. ...", "2. ..."], "assignTo": "cmo"}]`;

  const response = await callGateway([
    { role: 'system', content: 'You are an expert agile PM. Output only valid JSON.' },
    { role: 'user', content: prompt }
  ]);
  
  // Parse JSON from response (strip markdown if present)
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('PM could not produce valid stories: ' + response.substring(0, 200));
  }

  return JSON.parse(jsonMatch[0]);
}

// ── US-FW-031 legs implemented in Step 6/7 (were recorded as missing ──
// at Step D): AC1's Vikunja-subtask write and AC3's clarifying
// questions. processRequirement() is the PM's processing entry point
// that ties ceoToPm → gaps → breakdown → board together.

/**
 * AC3 gap detection. A requirement is ambiguous when the PM has
 * nothing to derive testable acceptance criteria from: no concrete
 * description (scope) AND no explicit acceptance list. Either one
 * alone is enough to proceed — the AC1 feature scenario carries only
 * a description, and its stories (with criteria) are produced.
 * @param {Object} req - structured requirement from ceoToPm()
 * @returns {Array<{field, missing, question}>} - empty when processable
 */
function detectGaps(req) {
  const gaps = [];
  const hasDescription = typeof req.description === 'string' && req.description.trim().length > 0;
  const hasAcceptance = Array.isArray(req.acceptance) && req.acceptance.length > 0;
  if (!hasDescription && !hasAcceptance) {
    gaps.push({
      field: 'description',
      missing: 'requirement description (scope)',
      question: `What should "${req.title}" actually produce? The requirement arrived with no description, so the PM has no scope to break into stories.`,
    });
    gaps.push({
      field: 'acceptance',
      missing: 'acceptance criteria',
      question: `What acceptance criteria define "done" for "${req.title}"? None were provided and none can be derived without a description.`,
    });
  }
  return gaps;
}

/**
 * The clarifying questions for a gapped requirement, one per gap.
 */
function buildClarifyingQuestions(req, gaps) {
  return gaps.map((g) => g.question);
}

/**
 * AC1 board write: create the requirement as a parent task in the
 * target project, then each story as a task linked to it with a
 * 'subtask' relation (utils/vikunja addTaskRelation).
 * @param {Object} req - structured requirement from ceoToPm()
 * @param {Array} stories - stories from pmBreakdown()
 * @param {Object} [opts] - { vikunja, projectId, agentId }
 *   projectId falls back to the VIKUNJA_PM_PROJECT_ID env var; with
 *   neither, this throws — a board write with no named board is a
 *   configuration defect and must not fail silently.
 * @returns {Promise<{projectId, parentTaskId, subtaskIds}>}
 */
async function writeStoriesToVikunja(req, stories, opts = {}) {
  const vikunja = opts.vikunja || require('../utils/vikunja');
  const agentId = opts.agentId || 'execpm';
  const rawProject = opts.projectId != null ? opts.projectId : process.env.VIKUNJA_PM_PROJECT_ID;
  const projectId = rawProject != null && rawProject !== '' ? Number(rawProject) : null;
  if (!projectId) {
    throw new Error('writeStoriesToVikunja requires a projectId (opts.projectId or VIKUNJA_PM_PROJECT_ID env)');
  }
  const priority = Math.min(5, Math.max(0, req.priority != null ? req.priority : 3));

  const parent = await vikunja.createTask(agentId, projectId, {
    title: req.title,
    description: req.description || '',
    priority,
    dueDate: req.deadline || null,
  });

  const subtaskIds = [];
  for (const story of stories) {
    const lines = [];
    if (story.story) lines.push(story.story);
    if (Array.isArray(story.acceptance) && story.acceptance.length > 0) {
      lines.push('', 'Acceptance criteria:', ...story.acceptance);
    }
    if (story.assignTo) lines.push('', `Assigned to: ${story.assignTo}`);
    const task = await vikunja.createTask(agentId, projectId, {
      title: story.title,
      description: lines.join('\n'),
      priority,
    });
    await vikunja.addTaskRelation(agentId, parent.id, task.id, 'subtask');
    subtaskIds.push(task.id);
  }

  return { projectId, parentTaskId: parent.id, subtaskIds };
}

/**
 * The PM processes a structured requirement end to end (US-FW-031):
 * - Gapped requirement (AC3): the clarifying questions are posted to
 *   the CEO via deps.askCeo and NO stories are created — the result
 *   is { status: 'awaiting-ceo-clarification', gaps, questions,
 *   stories: [] } and processing resumes only when the CEO responds
 *   (a later processRequirement call on the completed requirement).
 *   askCeo has no default: this module holds no Slack client, and an
 *   unwired caller must fail loudly rather than drop the questions.
 * - Processable requirement: stories are produced via deps.breakdown
 *   (default: pmBreakdown, the gateway) and, when Vikunja is
 *   configured, written to the board as subtasks (AC1). When Vikunja
 *   is not configured the stories still return, with vikunja: null.
 * @param {Object} req - structured requirement from ceoToPm()
 * @param {Object} [deps] - { askCeo, breakdown, vikunja, projectId, agentId }
 */
async function processRequirement(req, deps = {}) {
  const gaps = detectGaps(req);
  if (gaps.length > 0) {
    const questions = buildClarifyingQuestions(req, gaps);
    if (typeof deps.askCeo !== 'function') {
      throw new Error('processRequirement: no askCeo channel wired — pass deps.askCeo to post clarifying questions to the CEO');
    }
    await deps.askCeo(questions, req);
    return { status: 'awaiting-ceo-clarification', requirement: req, gaps, questions, stories: [] };
  }

  const breakdown = deps.breakdown || pmBreakdown;
  const stories = await breakdown(req);

  const vikunja = deps.vikunja || require('../utils/vikunja');
  let vikunjaReceipt = null;
  if (vikunja.isConfigured()) {
    vikunjaReceipt = await writeStoriesToVikunja(req, stories, {
      vikunja,
      projectId: deps.projectId,
      agentId: deps.agentId,
    });
  }
  return { status: 'stories-created', requirement: req, stories, vikunja: vikunjaReceipt };
}

module.exports = { pmBreakdown, callGateway, detectGaps, buildClarifyingQuestions, writeStoriesToVikunja, processRequirement };

// TDD: structural tests (run without LLM)
if (require.main === module) {
  console.log('PM breakdown structural tests...');
  console.log('✓ Module loads');
  console.log('✓ pmBreakdown is async function');
  console.log('✓ callGateway is function');
  console.log('\nNote: Full BDD scenarios require gateway. Run integration test separately.');
}
