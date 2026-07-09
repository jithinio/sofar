# sofar

**A portable, tool-independent record of AI coding work** — plan, subtasks,
status, files, and decisions *with rationale* — that any session, model, or CLI
can read and write. `git` remembers what the code became; **sofar** remembers
what you were trying to do, how far you got, and why.

This package is the canonical **install alias**. The engine ships as
[`@alignlabs/sofar`](https://www.npmjs.com/package/@alignlabs/sofar); installing
`sofar` pulls it in and exposes the same `sofar` command.

## Install

```sh
npm install -g sofar
# or the recommended one-liner:
curl -fsSL https://sofar.sh | sh
```

Then in any repo:

```sh
sofar init      # make the repo sofar-ready (hooks, MCP, protocol)
sofar new <slug>
sofar status
```

- **Docs & source:** https://github.com/jithinio/sofar
- **Home:** https://sofar.sh
- **Engine package:** https://www.npmjs.com/package/@alignlabs/sofar

MIT © Align Labs
