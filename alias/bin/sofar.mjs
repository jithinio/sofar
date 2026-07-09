#!/usr/bin/env node
// `sofar` is the canonical install alias for @alignlabs/sofar — the real engine
// lives under the Align Labs scope; this package secures the bare name so the
// obvious install command (`npm i -g sofar`) yields a working `sofar` CLI and
// can never be claimed by a stranger. It simply re-execs the real bundled CLI;
// process.argv passes through untouched (commander reads argv[2:]).
// Source of truth: https://github.com/jithinio/sofar  ·  https://sofar.sh
import '@alignlabs/sofar/dist/cli.js'
