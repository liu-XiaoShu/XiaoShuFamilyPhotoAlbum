#!/usr/bin/env bash
exec "$(cd "$(dirname "$0")" && pwd)/xiaoshu-ctl.sh" stop "$@"
