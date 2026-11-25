#!/bin/sh
set -eu
apt-get update
apt-get install -y --no-install-recommends openssh-client passwd
rm -rf /var/lib/apt/lists/*
chmod +x "$(dirname "$0")/bin/nano-messages"
