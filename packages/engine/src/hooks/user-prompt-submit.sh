#!/bin/sh
# sofar UserPromptSubmit shim — no logic here (BD4); the CLI owns behavior.
# stdin (hook JSON) passes through; stdout becomes additionalContext.
exec sofar event user-prompt
