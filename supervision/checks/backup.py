#!/usr/bin/env python3
"""Server-native nightly MACF snapshot (replaces the VM backup cron's local
half; the Google Drive upload leg has no connector on the server).

Snapshots, into ~/workspace/macf/backups-server/:
  - Vikunja database (consistent copy via the sqlite backup API)
  - slack-agents config (.env, engine/scrum-config.json, engine/schedules.json)
  - engine state (directive poll state, delivery learnings, token health)
  - the supervision layer itself (scripts, units manifest, watch state)
Keeps the last 3 tarballs. Prints "BACKUP OK <file> <bytes>" on success.
"""
import glob
import os
import sqlite3
import tarfile
import time

MACF = "/home/ubuntu/workspace/macf"
OUT_DIR = os.path.join(MACF, "backups-server")
STAMP = time.strftime("%Y%m%d-%H%M%S")
WORK = os.path.join(OUT_DIR, ".staging-" + STAMP)


def add_if_exists(tf, path, arcname):
    if os.path.exists(path):
        tf.add(path, arcname=arcname)
        return True
    print("skip (missing): %s" % path)
    return False


def main():
    os.makedirs(WORK, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)

    # Consistent Vikunja DB copy.
    src_db = os.path.join(MACF, "vikunja", "data", "vikunja.db")
    dst_db = os.path.join(WORK, "vikunja.db")
    src = sqlite3.connect("file:%s?mode=ro" % src_db, uri=True)
    dst = sqlite3.connect(dst_db)
    with dst:
        src.backup(dst)
    dst.close()
    src.close()

    out_path = os.path.join(OUT_DIR, "macf-server-backup-%s.tar.gz" % STAMP)
    with tarfile.open(out_path, "w:gz") as tf:
        tf.add(dst_db, arcname="vikunja.db")
        sa = os.path.join(MACF, "slack-agents")
        add_if_exists(tf, os.path.join(sa, ".env"), "slack-agents/.env")
        add_if_exists(tf, os.path.join(sa, "engine", "scrum-config.json"),
                      "slack-agents/engine/scrum-config.json")
        add_if_exists(tf, os.path.join(sa, "engine", "schedules.json"),
                      "slack-agents/engine/schedules.json")
        for name in (".directive-poll-state.json", ".delivery-learnings.json",
                     ".engine-gaps.json", ".token-health.json", ".agent-health.json"):
            add_if_exists(tf, os.path.join(sa, "engine", name),
                          "slack-agents/engine/" + name)
        sup = os.path.join(MACF, "supervision")
        for path in sorted(glob.glob(os.path.join(sup, "checks", "*")) +
                           glob.glob(os.path.join(sup, "state", "*")) +
                           [os.path.join(sup, "run.sh"),
                            os.path.join(sup, "UNITS.txt")]):
            if os.path.isfile(path):
                tf.add(path, arcname=os.path.relpath(path, MACF))
    os.remove(dst_db)
    os.rmdir(WORK)

    backups = sorted(glob.glob(os.path.join(OUT_DIR, "macf-server-backup-*.tar.gz")))
    for old in backups[:-3]:
        os.remove(old)
        print("rotated out: %s" % old)
    size = os.path.getsize(out_path)
    print("BACKUP OK %s %d" % (out_path, size))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
