#!/usr/bin/env python3
"""Server-native CEO directive watch (port of the VM's directive-watch).

Watches the same directive threads for silence past their limit. Uses the
server .env Slack user token when present (same class as the VM surrogate),
falling back to the bot token. A thread that newly goes overdue is announced
once in Slack #management; the flag resets when a new reply lands.
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from slack_alert import post  # noqa: E402

ENV_PATH = "/home/ubuntu/workspace/macf/slack-agents/.env"
STATE = "/home/ubuntu/workspace/macf/supervision/state/directive-watch.json"

WATCHLIST = [
    {"label": "CMO product PDF review (re-issued Oct 11, text content inline)",
     "channel": "C0ASDH1HC1Y", "parent_ts": "1791733868.886459",
     "max_silent_h": 12},
]


def env_token(*names):
    vals = {}
    with open(ENV_PATH) as f:
        for line in f:
            m = re.match(r"^([A-Z0-9_]+)=(.+)$", line.strip())
            if m:
                vals[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    for n in names:
        if vals.get(n):
            return vals[n]
    return None


def api(token, method, params):
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request("https://slack.com/api/" + method, data=data,
                                 headers={"Authorization": "Bearer " + token,
                                          "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def main():
    token = env_token("SLACK_MCP_XOXP_TOKEN", "SLACK_BOT_TOKEN")
    if not token:
        print("no Slack token available in server .env")
        return 1
    state = {}
    if os.path.exists(STATE):
        try:
            state = json.load(open(STATE))
        except Exception:
            state = {}
    now = time.time()
    out = []
    for w in WATCHLIST:
        key = "%s:%s" % (w["channel"], w["parent_ts"])
        prev = state.get(key, {})
        try:
            d = api(token, "conversations.replies",
                    {"channel": w["channel"], "ts": w["parent_ts"], "limit": 30})
            if not d.get("ok"):
                out.append({"label": w["label"], "error": d.get("error")})
                continue
            msgs = d.get("messages", [])
            replies = msgs[1:]
            latest = max((float(m["ts"]) for m in replies), default=float(w["parent_ts"]))
            silent_h = round((now - latest) / 3600, 1)
            overdue = silent_h >= w["max_silent_h"]
            if len(replies) > prev.get("replies", -1):
                prev["alerted"] = False  # new reply resets the one-shot alert
            if overdue and not prev.get("alerted"):
                post(":hourglass: *Directive thread overdue* — \"%s\" has been silent "
                     "for %.1f hours (limit %sh, %d replies). The owner still owes a reply."
                     % (w["label"], silent_h, w["max_silent_h"], len(replies)))
                prev["alerted"] = True
                print("alert posted for %s" % w["label"])
            prev["replies"] = len(replies)
            prev["silent_hours"] = silent_h
            state[key] = prev
            out.append({"label": w["label"], "replies": len(replies),
                        "silent_hours": silent_h, "overdue": overdue})
        except Exception as e:
            out.append({"label": w["label"], "error": str(e)[:160]})
    json.dump(state, open(STATE, "w"), indent=1)
    print(json.dumps({"threads": out}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
