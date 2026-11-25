#!/bin/sh
# OpenSSH requires a passwd entry for the calling UID. Nano can drop to a
# numeric UID that has no entry yet in the container.
set -eu
[ -n "${NANO_APPLE_MESSAGES_SSH_CONFIG:-}" ] || exit 0
uid="${NANO_UID:-1000}"
gid="${NANO_GID:-$uid}"
if getent passwd "$uid" >/dev/null; then exit 0; fi
if ! getent group "$gid" >/dev/null; then groupadd --gid "$gid" "nano-ssh-$gid"; fi
useradd --no-log-init --no-create-home --no-user-group --uid "$uid" --gid "$gid" \
  --home-dir "${NANO_DATA_DIR:-/data}/home" --shell /usr/sbin/nologin "nano-ssh-$uid"
