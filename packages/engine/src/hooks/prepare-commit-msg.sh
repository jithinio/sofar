#!/bin/sh
# sofar prepare-commit-msg shim — no logic here (BD4); the CLI owns behavior.
# Stamps Sofar-Initiative onto the message so the commit → initiative binding
# lives in git, never in the record (D4).
#
# Unlike the Claude Code shims this one CANNOT `exec`: this runs inside
# `git commit`, so a missing binary or any non-zero status would abort the
# user's commit. Attribution is best-effort by contract (D5) — every failure
# path here is a silent success.
if command -v sofar >/dev/null 2>&1; then
  sofar commit-trailer "$1" >/dev/null 2>&1 || true
fi
exit 0
