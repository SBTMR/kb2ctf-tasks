#!/bin/sh
set -eu
. /opt/lab/config.sh
exec /usr/local/bin/docker-entrypoint.sh "$@"
