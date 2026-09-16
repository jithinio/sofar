#!/bin/sh
# sofar SessionEnd shim — no logic here (BD4); the CLI owns behavior.
# Cleanup only: appends a mechanical session_closed marker.
# Routing only, never behaviour (BD4, rust-core D32): the native core when it
# is on PATH — sofar.sh's bin/sofar-core, the binary itself after postinstall —
# else the sofar CLI, which dispatches or falls back the same way. SOFAR_CORE=0
# forces the CLI; SOFAR_CORE=<path> names a core (the CLI honours both too).
core="${SOFAR_CORE-}"
if [ "$core" != 0 ] && command -v "${core:-sofar-core}" >/dev/null 2>&1; then
  exec "${core:-sofar-core}" event session-end
fi
exec sofar event session-end
