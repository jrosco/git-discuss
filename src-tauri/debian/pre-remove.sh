#!/bin/sh
set -e

cli="/usr/lib/git-discuss/resources/bin/git-discuss"
existing=$(readlink /usr/bin/git-discuss 2>/dev/null || true)
if [ "$existing" = "$cli" ]; then
  rm -f /usr/bin/git-discuss
fi
