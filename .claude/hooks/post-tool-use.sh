#!/bin/sh
# sofar PostToolUse shim (matcher: Edit|Write|MultiEdit|Bash) — no logic
# here (BD4); the CLI owns behavior. stdin (hook JSON) passes through;
# stdout is hookSpecificOutput JSON carrying any guarded rule the edit crosses.
exec sofar event post-tool
