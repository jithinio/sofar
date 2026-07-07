#!/bin/sh
# sofar Stop shim — no logic here (BD4); the CLI owns behavior.
# Exit 2 from the CLI blocks the stop (write-back enforcement, BD2).
exec sofar event stop
