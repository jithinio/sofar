import { Command } from 'commander'
import { createHarnessServer } from '../mcp/server'

const program = new Command()

program
  .name('harness')
  .description('Harness v1 engine — event-log initiative memory for coding agents')
  .version('0.1.0')

program
  .command('mcp')
  .description('start the stdio MCP server (server name: harness) exposing the SPEC §MCP tools')
  .option('--root <dir>', 'repo root containing .harness/ (default: current directory)')
  .action(async (opts: { root?: string }) => {
    const handle = createHarnessServer({ rootDir: opts.root })
    await handle.connectStdio()
    // stdio transport keeps the process alive until the client disconnects
  })

await program.parseAsync(process.argv)
