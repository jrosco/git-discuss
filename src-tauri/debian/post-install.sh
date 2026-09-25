#!/bin/sh
set -e

cli="/usr/lib/git-discuss/resources/bin/git-discuss"
if [ -x "$cli" ]; then
  existing=$(readlink /usr/bin/git-discuss 2>/dev/null || true)
  if [ ! -e /usr/bin/git-discuss ] || [ "$existing" = "$cli" ]; then
    ln -sfn "$cli" /usr/bin/git-discuss
  else
    echo "A different git-discuss command already exists at /usr/bin/git-discuss; leaving it unchanged."
  fi
fi
