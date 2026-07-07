#!/bin/sh
# harness SessionStart shim — no logic here (BD4); the CLI owns behavior.
# stdin (hook JSON) passes through; stdout becomes injected context.
exec harness event session-start
