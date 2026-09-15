#!/bin/sh
# sofar PostToolUseFailure shim (matcher: Edit|Write|MultiEdit|Bash) — no
# logic here (BD4); the CLI owns behavior. stdin (hook JSON) passes through;
# a failed call is recorded as the same mechanical event with ok:false, and
# its error text goes to the private diagnostics store, never the record.
exec sofar event post-tool-failure
