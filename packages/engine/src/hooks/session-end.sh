#!/bin/sh
# harness SessionEnd shim — no logic here (BD4); the CLI owns behavior.
# Cleanup only: appends a mechanical session_closed marker.
exec harness event session-end
