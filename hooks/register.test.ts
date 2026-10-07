import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { solveCeiling } from './register'

// The test engine's command.run is typed with the engine-stamped fields (origin, presentation),
// which the kit fills in; a test passes the person's part only.
const run = ($: Engine, args: string) => $.command.run({ command: 'molt', args } as never)

// An in-memory folder beneath the plugin: the test stands for the engine's fs and clock.
function folder(on: On, files: Record<string, string>, mtimeMs = 0) {
  // The engine hands hooks absolute paths; the fixture is keyed from the project root.
  const rel = (p: string) => (p.includes('.state') ? p.slice(p.indexOf('.state')) : p.replace(/^.*\/(src\/)/, '$1'))
  const has = (p: string) => rel(p) in files || Object.keys(files).some(f => f.startsWith(`${rel(p)}/`))
  on('clock.now', () => ({ value: mtimeMs + 10 * 86_400_000 })) // every fixture file is 10 days old
  on('fs.exists', (_, e) => ({ value: has(e.path) }))
  on('fs.read', (_, e) => ({ value: files[rel(e.path)] ?? '' }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file' as const, size: (files[rel(e.path)] ?? '').length, mtimeMs, isLink: false } }))
  on('fs.list', (_, e) => ({
    value: Object.keys(files)
      .filter(f => f.startsWith(`${rel(e.path)}/`))
      .map(f => f.slice(rel(e.path).length + 1))
      .filter(n => !n.includes('/'))
      .map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs, isLink: false })),
  }))
}

test('the ceiling is the cost minimum: F + sqrt(2·m·g·F), bounded, in 5k steps', () => {
  // John's setup: 73k floor, 3 reads per molt. Light work (1k/call) → ~95k; heavy (20k/call) → ~165k.
  expect(solveCeiling(73_000, 1_000, 3)).toBe(95_000)
  expect(solveCeiling(73_000, 5_000, 3)).toBe(120_000)
  expect(solveCeiling(73_000, 20_000, 3)).toBe(165_000)
  // never closer than 20k above the floor, never above 400k, floor never read below 20k
  expect(solveCeiling(73_000, 10, 1)).toBe(95_000)
  expect(solveCeiling(300_000, 200_000, 5)).toBe(400_000)
  expect(solveCeiling(0, 5_000, 3)).toBe(45_000)
})

test('/molt lint reports an empty folder as clean', async ($, on) => {
  folder(on, {})
  const r = await run($, 'lint')
  expect(r.text).toContain('0 note(s)')
  expect(r.text).toContain('clean')
})

test('the namespaced command of an installed plugin is answered too', async ($, on) => {
  folder(on, {})
  const r = await $.command.run({ command: 'molt:molt', args: 'lint' } as never)
  expect(r.text).toContain('clean')
})

test('/molt graph on no notes says so', async ($, on) => {
  folder(on, {})
  const r = await run($, 'graph')
  expect(r.text).toContain('is empty')
})

test('lint finds an orphan, a bad link, a superseded note still routed, a stale handoff', async ($, on) => {
  folder(on, {
    '.state/notes/alpha.md': '---\ntitle: Alpha\nstatus: active\nlinks: [ghost]\nfiles: [src/gone.ts]\n---\nbody with [[old]]',
    '.state/notes/old.md': '---\ntitle: Old\nstatus: superseded\nsuperseded_by: alpha\n---\nbody',
    '.state/INDEX.md': '- [Old](notes/old.md) — read when nothing\n- [Missing](notes/missing.md) — never\n',
    '.state/HANDOFF.md': '# Goal\nold',
  })
  const r = await run($, 'lint')
  expect(r.text).toContain('orphan: notes/alpha.md')
  expect(r.text).toContain('unknown note "ghost"')
  expect(r.text).toContain('notes/old.md is superseded but still in INDEX.md')
  expect(r.text).toContain('links to missing notes/missing.md')
  expect(r.text).toContain('src/gone.ts, which no longer exists')
  expect(r.text).toContain('HANDOFF.md is')
  const g = await run($, 'graph')
  expect(g.text).toContain('alpha -> ghost, old')
  expect(g.text).toContain('old (superseded)')
})

test('/molt with a note passes through to the markdown command beneath', async ($, on) => {
  folder(on, {})
  on('command.run', { command: 'molt' }, () => ({ text: 'ran beneath' }))
  const r = await run($, 'ship it')
  expect(r.text).toBe('ran beneath')
})
