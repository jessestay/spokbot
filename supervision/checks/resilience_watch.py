#!/usr/bin/env python3
"""Server-native delegation resilience watch (replaces the VM Muse cron).

Reads the SERVER engine's directive poll state and engine gaps, and reports
ONLY events to Slack #management:
  - a directive newly dead-letters (agent + first ~100 chars + requeue time)
  - a dead-lettered directive is auto-requeued (key gone, not permanent)
  - a directive becomes permanently dead-lettered (finalLogged or 8 requeues)
  - Graham test (#761): designed deliverables appear in a task-761 sandbox
Watermark lives in supervision/state/resilience-watch.json. First run is a
silent baseline, matching the old VM job's behaviour.
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from slack_alert import post  # noqa: E402

SA = "/home/ubuntu/workspace/macf/slack-agents"
POLL_STATE = os.path.join(SA, "engine", ".directive-poll-state.json")
GAPS_FILE = os.path.join(SA, "engine", ".engine-gaps.json")
STATE_PATH = "/home/ubuntu/workspace/macf/supervision/state/resilience-watch.json"
SANDBOX_ROOTS = [
    "/home/ubuntu/workspace/agent-sandbox/task-761",
    os.path.join(SA, "sandbox", "task-761"),
]
ORIGINAL_DRAFTS = {"graham-schwab-materials-DRAFT.md", "829-studios-agreement-review-DRAFT.md"}


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def entry_key(e):
    ch = e.get("channel") or e.get("channelId") or "?"
    ts = e.get("ts") or e.get("msgTs") or "?"
    return "%s:%s" % (ch, ts)


def entry_agent(e):
    return e.get("agentId") or e.get("agent") or e.get("to") or "unknown agent"


def entry_text(e):
    for field in ("text", "preview", "directive", "message"):
        v = e.get(field)
        if isinstance(v, str) and v.strip():
            return v.strip().replace("\n", " ")[:100]
    return "(directive text not stored in the poll-state entry)"


def gap_id(g):
    if isinstance(g, dict):
        if g.get("id"):
            return str(g["id"])
        return hashlib.sha256(json.dumps(g, sort_keys=True).encode()).hexdigest()[:16]
    return hashlib.sha256(str(g).encode()).hexdigest()[:16]


def graham_deliverables():
    found = []
    for root in SANDBOX_ROOTS:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                p = os.path.join(dirpath, name)
                try:
                    size = os.path.getsize(p)
                except OSError:
                    continue
                if size <= 0:
                    continue
                if name.lower().endswith(".pdf") or name not in ORIGINAL_DRAFTS:
                    found.append(p)
    return found


def main():
    state = load_json(POLL_STATE, {})
    dead = state.get("_deadLetter") or []
    pending = state.get("_pendingRetry") or []
    gaps = load_json(GAPS_FILE, [])
    if isinstance(gaps, dict):
        gaps = gaps.get("gaps", [])

    entries = {}
    for e in dead:
        if isinstance(e, dict):
            entries[entry_key(e)] = e
    cur_keys = set(entries)
    cur_gap_ids = {gap_id(g) for g in gaps}
    permanent_now = {
        k for k, e in entries.items()
        if e.get("finalLogged") or (isinstance(e.get("requeues"), int) and e["requeues"] >= 8)
    }

    wm = load_json(STATE_PATH, None)
    if wm is None:
        wm = {
            "reported_keys": sorted(cur_keys),
            "prev_keys": sorted(cur_keys),
            "reported_permanent": sorted(permanent_now),
            "reported_gap_ids": sorted(cur_gap_ids),
            "graham_reported": [],
        }
        with open(STATE_PATH, "w") as f:
            json.dump(wm, f, indent=1)
        print("baseline recorded: %d dead-letter entries / %d unique keys, %d gaps"
              % (len(dead), len(cur_keys), len(cur_gap_ids)))
        return 0

    reported = set(wm.get("reported_keys", []))
    prev_keys = set(wm.get("prev_keys", []))
    reported_perm = set(wm.get("reported_permanent", []))
    reported_gaps = set(wm.get("reported_gap_ids", []))
    graham_reported = set(wm.get("graham_reported", []))

    alerts = []

    # Newly permanently dead (check first so a permanent entry is not also
    # reported as merely new).
    for k in sorted(permanent_now - reported_perm):
        e = entries[k]
        alerts.append(
            ":red_circle: *Permanently dead-lettered directive* — to %s: \"%s...\" "
            "This needs a decision; it will not recover on its own."
            % (entry_agent(e), entry_text(e)))
        reported_perm.add(k)
        reported.add(k)

    # Newly dead-lettered.
    for k in sorted(cur_keys - reported):
        e = entries[k]
        rq = e.get("requeueAt") or e.get("requeue_at") or "after its cooldown"
        alerts.append(
            ":warning: *Directive dead-lettered* — to %s: \"%s...\" "
            "Reason: %s. It will auto-requeue %s."
            % (entry_agent(e), entry_text(e), e.get("reason", "unspecified"), rq))
        reported.add(k)

    # Auto-requeued: present last run, gone now, not permanent.
    for k in sorted(prev_keys - cur_keys):
        if k not in permanent_now:
            alerts.append(
                ":recycle: *Directive auto-requeued* — %s is back in play on its own; "
                "no human re-issue was needed." % k)

    # Graham deliverables.
    new_deliverables = [p for p in graham_deliverables() if p not in graham_reported]
    for p in new_deliverables:
        alerts.append(
            ":package: *Graham test (#761) deliverable found* — %s (%d bytes). "
            "Designed deliverable present in the sandbox." % (p, os.path.getsize(p)))
        graham_reported.add(p)

    new_gaps = cur_gap_ids - reported_gaps
    if new_gaps:
        print("new engine gap ids since last run: %d (logged, not alerted)" % len(new_gaps))
        reported_gaps |= new_gaps

    for text in alerts:
        ts = post(text)
        print("alert posted ts=%s: %s" % (ts, text[:120]))

    wm = {
        "reported_keys": sorted(reported),
        "prev_keys": sorted(cur_keys),
        "reported_permanent": sorted(reported_perm),
        "reported_gap_ids": sorted(reported_gaps),
        "graham_reported": sorted(graham_reported),
    }
    with open(STATE_PATH, "w") as f:
        json.dump(wm, f, indent=1)
    print("dead-letter entries=%d unique=%d pendingRetry=%d gaps=%d alerts=%d"
          % (len(dead), len(cur_keys), len(pending), len(cur_gap_ids), len(alerts)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
