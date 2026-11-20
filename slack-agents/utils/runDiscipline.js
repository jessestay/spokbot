'use strict';

// CEO BUILD 7 (Oct 22, 2026) — RUN DISCIPLINE for generateWithTools.
//
// Phase 1 made run failure honest; it did not make runs well-behaved.
// Oct 22 evidence: the CFO's proactivity sweep spent 20 tool calls (7x
// vikunjaListTasks, 5x fileList) exploring until its rounds ran out and
// shipped nothing; CMO's sweep died in 12s on a repeated argument-contract
// violation whose earlier work was discarded. Three mechanisms, all
// enforced inside the loop rather than by hoping the model behaves:
//
//  (a) PROGRESS CHECKPOINT — when a run has spent half its tool rounds
//      with tool calls but ZERO deliverable-class (write) actions, one
//      steering instruction is injected: produce the deliverable now, or
//      finish with a precise blocker statement.
//  (b) FINAL CORRECTION — a repeated contract violation no longer kills
//      the run on first repeat. The run gets ONE escalation round naming
//      the tool and the exact missing/received fields: fix the call
//      precisely, or complete the task another way. A further identical
//      violation ends the run exactly as before.
//  (c) SALVAGE — when a run still fails after banking verified tool work,
//      its last substantive assistant text rides on the failure result as
//      `salvage`, so retries and humans can build on the partial work
//      instead of restarting from zero. Salvage is labeled data on a
//      failure (ok stays false) — it is never a completion.
//
// Kill switch: MACF_RUN_DISCIPLINE_DISABLED=1 makes every mechanism a
// no-op (the loop behaves exactly as it did before this build).

const WRITE_TOOLS_EXACT = new Set([
  'fileWrite', 'fileEdit', 'wpUpdate', 'wpCreate',
  'vikunjaComment', 'vikunjaUpdateTask', 'vikunjaAttachEvidence', 'vikunjaCreateTask',
  'slackPost', 'slackReply', 'gmailSend', 'gmailDraft',
]);
const WRITE_PATTERN = /(write|edit|create|comment|attach|publish|post|send|upload|update)/i;
const READ_PATTERN = /(read|list|get|check|health|search|fetch|describe|lookup)/i;

// A deliverable-class action: a tool whose successful call mutates the
// world in a way a principal can open (a file, a comment, an update).
// General executors (desktopRun) and anything read-shaped do not count —
// exploration must never satisfy the checkpoint.
function isWriteTool(name) {
  if (typeof name !== 'string' || !name) return false;
  if (WRITE_TOOLS_EXACT.has(name)) return true;
  return WRITE_PATTERN.test(name) && !READ_PATTERN.test(name);
}

function steeringMessage(roundsUsed, maxToolRounds) {
  return `PROGRESS CHECKPOINT — you have used ${roundsUsed} of ${maxToolRounds} tool rounds with no deliverable action yet (nothing written, posted, or updated). Stop exploring. Either (1) produce the deliverable NOW with the information you already have — write the file, post the comment, make the update — or (2) if you are genuinely blocked, finish with a precise blocker statement: what you tried, what is missing, and what you need. Do not spend the remaining rounds on more listing or reading unless it is strictly required to write the deliverable.`;
}

function escalationMessage(toolName, correction) {
  const missing = correction && Array.isArray(correction.missing) && correction.missing.length
    ? correction.missing.join(', ') : '(see the correction above)';
  const received = correction && Array.isArray(correction.received) && correction.received.length
    ? correction.received.join(', ') : '(none)';
  return `FINAL CORRECTION — your repeated calls to ${toolName} violated its argument contract and the identical violation will now end this run as a failure. Missing required argument(s): ${missing}. Argument(s) you sent: ${received}. Either call ${toolName} once more with exactly the required arguments, or abandon this tool and complete the task another way.`;
}

function createRunDiscipline({ maxToolRounds = 6 } = {}) {
  const disabled = process.env.MACF_RUN_DISCIPLINE_DISABLED === '1';
  let toolCalls = 0;
  let okCalls = 0;
  let writes = 0;
  let steered = false;
  let lastText = '';
  const escalated = new Set();
  const halfBudget = Math.max(1, Math.ceil(maxToolRounds / 2));

  return {
    disabled,
    observeTool(toolName, result) {
      toolCalls += 1;
      if (result && result.ok === true) {
        okCalls += 1;
        if (isWriteTool(toolName)) writes += 1;
      }
    },
    observeText(text) {
      if (typeof text === 'string' && text.trim().length >= 40) lastText = text;
    },
    // `round` is the loop's 0-based round index; rounds used so far in
    // tool terms is round+1 once a batch has completed.
    steeringDue(round) {
      if (disabled || steered) return false;
      if (toolCalls === 0 || writes > 0) return false;
      if (round + 1 < halfBudget) return false;
      steered = true;
      return true;
    },
    steeringText(round) {
      return steeringMessage(round + 1, maxToolRounds);
    },
    escalationAvailable(sig) {
      return !disabled && !!sig && !escalated.has(sig);
    },
    markEscalated(sig) {
      if (sig) escalated.add(sig);
    },
    salvage() {
      if (disabled) return null;
      if (okCalls === 0 || !lastText) return null;
      return lastText.length > 4000 ? lastText.slice(0, 4000) : lastText;
    },
    stats() {
      return { toolCalls, okCalls, writes, steered, escalated: [...escalated], lastTextChars: lastText.length };
    },
  };
}

module.exports = { createRunDiscipline, isWriteTool, steeringMessage, escalationMessage };
