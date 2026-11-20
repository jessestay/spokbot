# Local-first model profile — staged, not active

**Status (Nov 14, 2026): STAGED.** The profile exists as configuration
(`slack-agents/config/models.local-first.example.yaml`) and is documented
here. It is **not** the live routing config on any production instance,
and no routing behavior has changed. This document is the activation
checklist and the proof protocol for when an operator chooses to turn it
on.

## What changes vs. the production `models.yaml`

Same schema, same tier names (quick / smart / best), same gateway legs.
One behavioral difference:

| Tier  | Production order | Local-first profile order |
|-------|------------------|---------------------------|
| quick | local, then free cloud | unchanged (already local-first) |
| smart | paid cloud chain → free chain → local last | **local mid-size → local small → free cloud → paid cloud (last resort)** |
| best  | cloud | unchanged (cloud, critical work only) |

The engine's existing quality gate still applies to local smart-tier
answers: a local final answer finalizes only with executed tool work or
a schema-valid deliverable. Local-first changes *who answers first*, not
*what counts as done*.

## Prerequisites

1. A local inference engine running on the instance host (or reachable
   from it), exposing an OpenAI-compatible endpoint:
   - **Ollama** (default): `ollama serve`, pull the chosen models first.
   - llama.cpp server, SGLang, or vLLM are drop-in equivalents.
   - MIA recipes (Mia's AI Lab) are the certified catalog for DGX Spark /
     RTX-class hardware; Ollama/GGUF is the path for modest hardware.
2. Model ids in the profile sized to the hardware. Honest sizing: a 4 GB
   GPU or free-tier ARM VM runs 3–8B models; the mid-size smart model
   should be the largest instruct model that fits with room for context.
3. The gateway (LiteLLM) legs `macf-local-smart` and `macf-local` pointed
   at the local engine's endpoint. Credentials, if any, live only on the
   gateway — never in this repo.
4. Prefix caching enabled in the local engine (llama.cpp slot cache /
   `--cache-reuse`; SGLang RadixAttention is on by default).

## Activation steps (operator-only; NOT done by this staging)

1. Back up the instance's live config:
   `cp slack-agents/config/models.yaml slack-agents/config/models.yaml.bak-<date>`
2. Copy the profile into place:
   `cp slack-agents/config/models.local-first.example.yaml slack-agents/config/models.yaml`
   and edit the two local model ids to the models actually pulled.
3. Restart the engine service on the instance (this is the step that
   changes live behavior — it requires the instance owner's go-ahead and
   a low-traffic window).
4. Confirm from the routing log (`log_routing: true`) that smart-tier
   calls are being served by `macf-local-smart`.

Rollback is the reverse: restore the backup `models.yaml` and restart.

## The full-day local-first proof

The Phase 0 proof (architecture memo, section 9) is: **the engine runs
one full day local-first with no loss of verified output.** Concretely,
over a continuous 24 h window with the profile active:

- **Routing evidence:** from the gateway/routing logs, the share of
  smart-tier calls served by a local leg (target: the large majority;
  every cloud escalation is a named fallback event, not a silent drift).
- **Outcome evidence:** the instance's outcome audit for the proof day
  vs. the previous cloud-first day — verified deliveries, postcondition
  pass rate, and dead-letter count must not regress.
- **Failure evidence:** empty-response and timeout rates per local leg;
  cold-load stalls must stay inside the `local_timeout_ms` budget.
- **Cost evidence:** paid-leg spend for the proof day (expected: ~$0
  unless escalations fired).

If outcomes regress, the profile rolls back and the regression — not the
ambition — is what gets fixed first. A proof run is recorded in the
instance's own logs/audit trail, not in this repo.
