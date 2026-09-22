#!/bin/sh
# sofar Stop shim — no logic here (BD4); the CLI owns behavior.
# Exit 2 from the CLI blocks the stop (write-back enforcement, BD2).
# Routing only, never behaviour (BD4, rust-core D32): the native core when it
# is on PATH — sofar.sh's bin/sofar-core, the binary itself after postinstall —
# else the sofar CLI, which dispatches or falls back the same way. SOFAR_CORE=0
# forces the CLI; SOFAR_CORE=<path> names a core (the CLI honours both too).
core="${SOFAR_CORE-}"
if [ "$core" != 0 ] && command -v "${core:-sofar-core}" >/dev/null 2>&1; then
  exec "${core:-sofar-core}" event stop
fi
exec sofar event stop
