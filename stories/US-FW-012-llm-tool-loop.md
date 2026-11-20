# US-FW-012 — The tool loop executes for real: no syntax-as-answer, no out-of-schema calls

**Story:** As a Spokbot operator, I want the LLM tool loop
(`generateWithTools`) to execute only real, schema-valid tool calls
— over the text, native, and SDK routes alike — so that an agent's
answer is the result of work actually performed, tool-call syntax
pasted as a final answer is rejected as a deliverable, and a loop
that spent its rounds with receipts banked reports that honestly
instead of throwing it away.

**Difficulty:** 5 points.

**Tests:** `engine/tests/generateWithTools.behavior.test.js`, `engine/tests/generateWithTools.native.behavior.test.js`, `engine/tests/generateWithTools.roundexhaustion.behavior.test.js`, `engine/tests/generateWithTools.sdk.behavior.test.js`, `engine/tests/generateWithTools.typed.behavior.test.js`, and `engine/tests/agentTools.test.js` (jest).

**Background:** F12 step C (story-linking). The tool loop is where
Spokbot's verified-work rule is enforced at generation time:
US-106 covers argument corrections and US-105 the typed-deliverable
contract; this story covers the loop machinery itself and the
execution layer beneath it (`agentTools`: urlCheck, fileWrite /
fileRead roundtrip). The behavior suites drive the real loop
against fake routes: text `[TOOL:]` calls, native JSON-Schema tool
calling, and the Anthropic SDK shape. Criteria are derived from the
suites' assertions; no suite was rewritten.

**Acceptance criteria:**

1. Given a well-formed tool call, When the loop runs, Then the tool
   executes and its result feeds the next round; given tool-call
   syntax offered as the final answer (the #702 pattern), Then
   nothing executes and the output is rejected as a deliverable.
2. Given a native tool call missing a required argument, When it is
   validated, Then a structured correction returns on the tool
   channel, the function never runs, and no file is created; given
   a route without native support, Then that is detected and
   flagged rather than silently degraded.
3. Given rounds exhausted with successful receipts banked, When the
   loop exits, Then it returns round_exhausted_with_work instead of
   throwing; given zero successful receipts, Then it throws the
   empty-streak error; given a deadline-burned exit, Then it throws
   even with receipts banked.
4. Given a contracted (typed) generation, When the model returns
   schema-invalid JSON or persistent prose, Then the attempt fails
   with validationErrors naming the fields, after a repair round.
