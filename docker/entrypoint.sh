#!/usr/bin/env bash
# Starts as root only to make the data directory writable, then drops to an
# unprivileged user. NANO_UID/NANO_GID let the files match a host user.
set -euo pipefail

uid="${NANO_UID:-1000}"
gid="${NANO_GID:-$uid}"
data="${NANO_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$data/home"
  if [ "$(stat -c %u "$data")" != "$uid" ]; then
    chown -R "$uid:$gid" "$data"
  fi
  # Packs and workspace under the data directory are the agent's to edit, and jobs keep state there. A root-owned file
  # (made by `docker exec` without -u, which runs as root) breaks the job, so hand it back.
  # --from=0 touches only root-owned entries; -R does not follow symlinks; ! -L skips symlinked roots. skills/ is left alone.
  for dir in "$data/packs" "$data/workspace"; do
    if [ ! -L "$dir" ] && [ -d "$dir" ]; then
      chown -R --from=0 "$uid:$gid" "$dir" || echo "nano: could not take back root-owned files in $dir" >&2
    fi
  done
  # The core queue database and its WAL files: a root-owned -wal or -shm (a CLI run through `docker exec` without -u)
  # would make it read-only for Nano.
  for f in "$data"/nano.sqlite "$data"/nano.sqlite-wal "$data"/nano.sqlite-shm; do
    if [ -e "$f" ] && [ ! -L "$f" ]; then chown --from=0 "$uid:$gid" "$f" || true; fi
  done
  # A fresh install gets a starter knowledge base; an existing one is never touched.
  kb="${NANO_KB_DIR:-$data/kb}"
  if [ -d "$kb" ] && [ -z "$(ls -A "$kb")" ]; then
    cp -r /app/templates/kb/. "$kb/" && chown -R "$uid:$gid" "$kb"
  elif [ ! -e "$kb" ]; then
    mkdir -p "$kb" && cp -r /app/templates/kb/. "$kb/" && chown -R "$uid:$gid" "$kb"
  fi
  # Shipped packs may start a root helper before privileges drop. A pack under
  # the data directory is writable by the agent, so a start-root.sh there is ignored.
  IFS=',' read -ra pack_names <<< "${NANO_PACKS:-core}"
  for pack_name in "${pack_names[@]}"; do
    pack_name="${pack_name#"${pack_name%%[![:space:]]*}"}"
    pack_name="${pack_name%"${pack_name##*[![:space:]]}"}"
    case "$pack_name" in
      ""|*[!A-Za-z0-9_-]*) echo "nano: ignoring invalid pack name" >&2; continue ;;
    esac
    hook="/app/packs/${pack_name}/start-root.sh"
    if [ -x "$hook" ]; then
      echo "nano: starting ${pack_name}"
      "$hook"
    fi
  done
  export HOME="$data/home"
  groups="$gid${NANO_EXTRA_GROUPS:+,$NANO_EXTRA_GROUPS}"
  exec setpriv --reuid="$uid" --regid="$gid" --groups="$groups" "$@"
fi

export HOME="${HOME:-$data/home}"
exec "$@"
