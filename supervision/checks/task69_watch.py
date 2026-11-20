#!/usr/bin/env python3
"""Server-native watch for Vikunja task #69 (desktop agent self-healing).

Port of the VM's task69-watch/watch.py: same snapshot diff (done, priority,
description hash, comment ids). Runs against the server's live Vikunja.
Changes are posted to Slack #management; first run only snapshots.
"""
import hashlib
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from slack_alert import post  # noqa: E402

STATE = "/home/ubuntu/workspace/macf/supervision/state/task69-watch.json"
ENV_PATH = "/home/ubuntu/workspace/macf/slack-agents/.env"
API = "http://127.0.0.1:3456/api/v1"
TASK_ID = 69


def get_token():
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if line.startswith("VIKUNJA_") and "TOKEN" in line and "=" in line:
                if line.startswith("VIKUNJA_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("VIKUNJA_TOKEN not found")


def api_get(path):
    req = urllib.request.Request(API + path,
                                 headers={"Authorization": "Bearer " + get_token()})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def main():
    task = api_get("/tasks/%d" % TASK_ID)
    comments = api_get("/tasks/%d/comments" % TASK_ID)
    if not isinstance(comments, list):
        comments = []
    snap = {
        "done": bool(task.get("done")),
        "priority": task.get("priority"),
        "title": task.get("title"),
        "updated": task.get("updated"),
        "desc_sha": hashlib.sha256((task.get("description") or "").encode()).hexdigest()[:16],
        "comment_ids": sorted(c.get("id") for c in comments if isinstance(c, dict)),
        "comment_count": len(comments),
    }
    prev = {}
    if os.path.exists(STATE):
        try:
            prev = json.load(open(STATE))
        except Exception:
            prev = {}
    events = []
    if prev:
        if prev.get("done") != snap["done"]:
            events.append("TASK DONE" if snap["done"] else "task reopened")
        if prev.get("priority") != snap["priority"]:
            events.append("priority %s -> %s" % (prev.get("priority"), snap["priority"]))
        if prev.get("desc_sha") != snap["desc_sha"]:
            events.append("description updated")
        new_ids = set(snap["comment_ids"]) - set(prev.get("comment_ids") or [])
        for cid in sorted(new_ids):
            c = next((x for x in comments if isinstance(x, dict) and x.get("id") == cid), {})
            author = (c.get("author") or {}).get("username") or "?"
            text = (c.get("comment") or "")[:300].replace("\n", " ")
            events.append("new comment from %s: %s" % (author, text))
    json.dump(snap, open(STATE, "w"), indent=1)
    print(json.dumps({"changed": bool(events), "done": snap["done"], "events": events}))
    for ev in events:
        if ev.startswith("TASK DONE"):
            post(":tada: *Task #69 is COMPLETE* — \"Desktop agent self-healing\" is done. "
                 "The desktop agent is now self-healing; recovery no longer needs a manual restart.")
        else:
            post(":clipboard: *Task #69 update* (desktop agent self-healing): %s" % ev)
    return 0


if __name__ == "__main__":
    sys.exit(main())
