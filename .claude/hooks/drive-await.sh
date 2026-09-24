#!/bin/sh
# sofar drive-await shim (drive-visibility 3.7) — no logic here (BD4); the CLI
# owns behavior. Claude Code only: it is wired with `asyncRewake`, which runs
# the hook in the background and wakes the model when it exits 2. stdin (hook
# JSON) passes through; a Bash call that did not start a detached run exits 0
# at once, and the wait ends with ONE line on stderr.
#
# Deliberately NOT routed to the native core like the read-path shims: this
# hook blocks for hours, and the core's job is the hot path.
exec sofar event drive-await
