#!/bin/sh
# harness PostToolUse shim (matcher: Edit|Write|MultiEdit|Bash) — no logic
# here (BD4); the CLI owns behavior. stdin (hook JSON) passes through.
exec harness event post-tool
