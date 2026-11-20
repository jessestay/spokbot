# Repo rename readiness: multiagentcommsframework → spokbot

**Status: NOT renamed (deliberately).** The product is now **Spokbot**;
this repository is still `jessestay/multiagentcommsframework`. The rename
is a Phase 1 task, to be done in a maintenance window — not casually —
because production depends on this repo's identity.

## Why not just rename it now

- The production engine (macf-server) runs from a checkout of this repo.
  Its git remote, update/watchdog scripts, and deployment habits all
  reference the current name/path.
- GitHub redirects web and git URLs after a rename, but redirects are a
  courtesy, not a contract: they stop working if a new repo is ever
  created under the old name, and they do not rewrite anything hardcoded
  in scripts, configs, docs, or other repos.
- Several local and server working copies (including the CEO's own
  clone) carry the old remote URL.

## What to sweep when the rename happens

1. **Pre-checks**
   - Confirm `jessestay/spokbot` is not already taken by another of
     Jesse's repos.
   - Announce a maintenance window; production verification is already
     red (11/12 functions) — do not stack a rename on top of unrelated
     instability. Rename only in a calm window.
2. **Rename** in GitHub Settings (owner action, ~1 minute).
3. **Update remotes explicitly** (do not rely on redirects):
   - macf-server production checkout: `git remote set-url origin
     https://github.com/jessestay/spokbot.git`, then a test fetch.
   - Every local clone (CEO VM clone included): same `set-url`.
   - Any CI/Actions, watchdog, or deploy script that clones/fetches by
     URL rather than by the checkout's configured remote.
4. **Sweep hardcoded references** in-repo and in the instance:
   `grep -r "multiagentcommsframework"` across the repo, the server
   checkout, and the instance's scripts/docs (README clone URL, SETUP.md,
   AGENT_SETUP.md, INITIALIZE_CHAT_PROMPT.md are known carriers).
   Case variants too (`MultiAgentCommsFramework`).
5. **Verify after the rename**
   - `git ls-remote` against the new URL from both the server and a
     local clone.
   - Engine watchdog's next git-touching run completes clean.
   - The repo page, README links, and the LICENSE link resolve under
     the new name.
6. **Do not** create a placeholder repo under the old name "to keep the
   redirect" — that is exactly what breaks GitHub's rename redirect.

## What does NOT break

- Existing clones keep working through the redirect until their remotes
  are updated (step 3 removes that dependency).
- Issues, PRs, stars, and history transfer with the rename.
- The Apache-2.0 license and all content are unaffected.
