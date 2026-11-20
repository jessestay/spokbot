"""Shared helper: post a message to a Slack channel using the server bot token.

Token is read from the server slack-agents/.env at call time and never printed.
"""
import json
import re
import urllib.parse
import urllib.request

ENV_PATH = "/home/ubuntu/workspace/macf/slack-agents/.env"
DEFAULT_CHANNEL = "C0ASH4TF604"  # #management


def _token():
    with open(ENV_PATH) as f:
        for line in f:
            m = re.match(r"^SLACK_BOT_TOKEN=(.+)$", line.strip())
            if m:
                return m.group(1).strip().strip('"').strip("'")
    raise RuntimeError("SLACK_BOT_TOKEN not found in server .env")


def post(text, channel=DEFAULT_CHANNEL):
    data = urllib.parse.urlencode({"channel": channel, "text": text}).encode()
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=data,
        headers={"Authorization": "Bearer " + _token()},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        out = json.load(resp)
    if not out.get("ok"):
        raise RuntimeError("chat.postMessage failed: %s" % out.get("error"))
    return out.get("ts")
