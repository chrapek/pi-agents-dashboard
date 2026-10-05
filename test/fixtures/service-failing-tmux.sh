#!/bin/sh
# Fake tmux for test/service.test.ts: list-sessions reports "no server", new-session fails.
for a in "$@"; do
  case "$a" in
    new-session) echo "fake new-session failure" >&2; echo "second line" >&2; exit 1 ;;
    list-sessions) echo "no server running on /tmp/fake" >&2; exit 1 ;;
  esac
done
exit 0
