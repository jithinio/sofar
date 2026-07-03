import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolErrorShape } from '@harness/schema/tool-inputs'
import { createHarnessServer, type HarnessServerHandle } from '../../src/mcp/server'

/** Fixture repo: fake .git (HEAD) + .harness/ with a bound initiative. */
export interface FixtureOptions {
  /** Branch name; null = detached HEAD (raw sha in HEAD). Default "main". */
  branch?: string | null
  /** Initiative slug bound to the branch. Default "demo". */
  slug?: string
  /** Write bindings.json binding branch → slug. Default true. */
  bind?: boolean
  /** Use a worktree-style .git FILE ("gitdir: <path>"). Default false. */
  worktree?: boolean
}

export interface Fixture {
  root: string
  slug: string
  initiativeDir: string
  eventsPath: string
}

export function makeRepoFixture(options: FixtureOptions = {}): Fixture {
  const { branch = 'main', slug = 'demo', bind = true, worktree = false } = options
  const root = mkdtempSync(join(tmpdir(), 'harness-mcp-'))

  const headContent = branch === null ? `${'a'.repeat(40)}\n` : `ref: refs/heads/${branch}\n`
  if (worktree) {
    const gitdir = join(root, 'worktree-gitdir')
    mkdirSync(gitdir, { recursive: true })
    writeFileSync(join(gitdir, 'HEAD'), headContent)
    writeFileSync(join(root, '.git'), `gitdir: ${gitdir}\n`)
  } else {
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), headContent)
  }

  const initiativeDir = join(root, '.harness', 'initiatives', slug)
  mkdirSync(initiativeDir, { recursive: true })
  if (bind && branch !== null) {
    writeFileSync(
      join(root, '.harness', 'bindings.json'),
      `${JSON.stringify({ [branch]: slug }, null, 2)}\n`,
    )
  }
  return { root, slug, initiativeDir, eventsPath: join(initiativeDir, 'events.jsonl') }
}

export interface Connected {
  client: Client
  handle: HarnessServerHandle
}

/** Server + client over a linked in-memory transport pair. */
export async function connectServer(rootDir: string): Promise<Connected> {
  const handle = createHarnessServer({ rootDir })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'harness-test-client', version: '0.0.0' })
  await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)])
  return { client, handle }
}

export interface CallOutcome<T> {
  isError: boolean
  body: T
}

/** Call a tool and parse content[0].text as JSON (result or typed error). */
export async function callTool<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallOutcome<T>> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text: string }>
  return { isError: result.isError === true, body: JSON.parse(content[0]!.text) as T }
}

/** Call a tool expecting a typed error; asserts isError in the caller. */
export async function callToolExpectError(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolErrorShape> {
  const { isError, body } = await callTool<ToolErrorShape>(client, name, args)
  if (!isError) throw new Error(`expected ${name} to fail, got: ${JSON.stringify(body)}`)
  return body
}
