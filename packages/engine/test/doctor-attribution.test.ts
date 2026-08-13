import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TRAILER_KEY } from '../src/core/attribution'
import { runDoctor } from '../src/cli/doctor'
import { runInit } from '../src/cli/init'

/**
 * doctor's attribution check (2.4) — the surface that makes silent failure
 * visible.
 *
 * The check is deliberately EMPIRICAL: it asks whether recent commits actually
 * carry trailers rather than enumerating the reasons they might not (hook never
 * installed, `sofar` on PATH too old for `commit-trailer`, session env var
 * gone). These tests pin that behaviour, not the causes.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function repo(name: string, { init = true }: { init?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), `sofar-docattr-${name}-`))
  roots.push(root)
  execFileSync('git', ['init', '--quiet', '.'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root, stdio: 'ignore' })
  if (init) runInit(root, { home: join(root, 'no-home') })
  return root
}

function commit(root: string, subject: string, slug?: string): void {
  writeFileSync(join(root, `f-${subject.replace(/\W/g, '')}`), `${subject}\n`)
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' })
  const msg = slug === undefined ? `${subject}\n` : `${subject}\n\n${TRAILER_KEY}: ${slug}\n`
  const path = join(root, '.commitmsg')
  writeFileSync(path, msg)
  execFileSync('git', ['commit', '--quiet', '-F', path], { cwd: root, stdio: 'ignore' })
}

function doctorText(root: string): string {
  return runDoctor(root).stdout
}

describe('doctor: commit attribution (2.4)', () => {
  it('warns when the hook is absent — the fresh-clone case', () => {
    // .git/hooks is never cloned, so this is the DEFAULT state of any clone.
    const root = repo('nohook', { init: false })
    mkdirSync(join(root, '.sofar', 'initiatives'), { recursive: true })
    writeFileSync(join(root, '.sofar', 'bindings.json'), '{}\n')
    const out = doctorText(root)
    expect(out).toContain('commit attribution off')
    expect(out).toContain('sofar init')
  })

  it('warns when the hook is installed but nothing recent is attributed', () => {
    // The silent-failure case: version skew, or a missing session env var. The
    // hook exits 0 on every path, so this warning is the ONLY signal.
    const root = repo('silent')
    commit(root, 'one')
    commit(root, 'two')
    const out = doctorText(root)
    expect(out).toContain('carry no attribution')
    expect(out).toContain('commit-trailer')
  })

  it('reports ok once commits are actually attributed', () => {
    const root = repo('live')
    commit(root, 'one', 'alpha')
    commit(root, 'two')
    const out = doctorText(root)
    expect(out).toMatch(/commit attribution live \(1\/2 recent commits attributed\)/)
  })

  it('never FAILs on unattributed history — only warns', () => {
    // record-integrity D3: a permanently red doctor trains people to ignore it,
    // and pre-adoption history is unattributed by definition.
    const root = repo('nofail')
    commit(root, 'one')
    const out = doctorText(root)
    expect(out).toContain('carry no attribution')
    expect(out).not.toMatch(/FAIL.*attribution/)
  })

  it('says nothing at all when there is no history to judge', () => {
    const root = repo('empty')
    expect(doctorText(root)).not.toContain('attribution live')
  })

  it('is silent outside a git repo rather than inventing a problem', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-docattr-nogit-'))
    roots.push(root)
    mkdirSync(join(root, '.sofar', 'initiatives'), { recursive: true })
    writeFileSync(join(root, '.sofar', 'bindings.json'), '{}\n')
    const out = doctorText(root)
    expect(out).not.toContain('commit attribution')
  })
})
