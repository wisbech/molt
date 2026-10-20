// molt: the folder is the state. /molt saves a handoff to .state/, then compacts the session in place.
// Call: the /molt command (commands/molt.md) has the model save state to .state/,
//       then this module compacts the session in place. Same session, small context.
//
// .state/INDEX.md    routing table, one line per note, says WHEN to read it (cap 200)
// .state/HANDOFF.md  where the last stretch stopped (cap 60, rewritten by each molt)
// .state/log.md      append-only history, greppable, never injected whole
// .state/notes/*.md  decisions, failures, patterns; frontmatter links/files = the graph
import type { EngineInterface as Engine, Register } from 'claude-code'

const DIR = '.state'
const INDEX_CAP = 200
const HANDOFF_CAP = 60
const STALE_DAYS = 7
const DAY = 86_400_000

type Note = { id: string; path: string; title: string; status: string; links: string[]; files: string[] }
type Lint = { problems: string[]; notes: Note[]; indexLines: number }

// Module state. A reload starts it over, which is fine: it is all derivable.
const S = {
  section: null as string | null, // the context block; re-read after every molt
  phase: 'idle' as 'idle' | 'shedding',
}

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  const out: Record<string, string> = {}
  for (const line of (m?.[1] ?? '').split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

// `links: [a, b]`, `links: a, b`, plus [[wikilinks]] in the body
function listOf(value: string | undefined, body: string, wiki: boolean): string[] {
  const items = (value ?? '')
    .replace(/^\[|\]$/g, '')
    .split(/[,\s]+/)
    .map(s => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
  if (wiki) for (const w of body.matchAll(/\[\[([^\]|#]+)/g)) items.push((w[1] ?? '').trim())
  return [...new Set(items.filter(Boolean))]
}

async function readText($: Engine, path: string): Promise<string> {
  return String(await $.fs.read(path))
}

async function readCapped($: Engine, path: string, cap: number): Promise<string | null> {
  if (!(await $.fs.exists(path))) return null
  const lines = (await readText($, path)).split('\n')
  if (lines.length <= cap) return lines.join('\n')
  return `${lines.slice(0, cap).join('\n')}\n… ${lines.length - cap} more lines cut. Keep this file under ${cap} lines.`
}

async function ageDays($: Engine, path: string): Promise<number> {
  return ((await $.clock.now()) - (await $.fs.stat(path)).mtimeMs) / DAY
}

async function readNotes($: Engine): Promise<Note[]> {
  if (!(await $.fs.exists(`${DIR}/notes`))) return []
  const notes: Note[] = []
  for (const entry of await $.fs.list(`${DIR}/notes`)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue
    const text = await readText($, `${DIR}/notes/${entry.name}`)
    const fm = frontmatter(text)
    const id = entry.name.replace(/\.md$/, '')
    notes.push({
      id,
      path: `notes/${entry.name}`,
      title: fm.title ?? id,
      status: fm.status ?? 'active',
      links: listOf(fm.links, text, true).map(l => l.replace(/\.md$/, '').replace(/^notes\//, '')),
      files: listOf(fm.files, '', false),
    })
  }
  return notes
}

// Deterministic housekeeping: no model, no tokens.
async function lint($: Engine): Promise<Lint> {
  const problems: string[] = []
  const notes = await readNotes($)
  const ids = new Set(notes.map(n => n.id))
  const index = (await $.fs.exists(`${DIR}/INDEX.md`)) ? await readText($, `${DIR}/INDEX.md`) : null
  const indexLines = index ? index.split('\n').filter((l: string) => l.trim()).length : 0

  if (index === null) {
    if (notes.length) problems.push(`no ${DIR}/INDEX.md but ${notes.length} note(s): nothing routes to them`)
  } else {
    if (indexLines > INDEX_CAP) problems.push(`INDEX.md has ${indexLines} lines, cap is ${INDEX_CAP}: merge or archive`)
    for (const m of index.matchAll(/\]\(([^)]+\.md)\)/g)) {
      const target = (m[1] ?? '').replace(/^\.\//, '')
      if (!(await $.fs.exists(`${DIR}/${target}`))) problems.push(`INDEX.md links to missing ${target}`)
    }
    for (const n of notes) {
      const routed = index.includes(n.path)
      if (!routed && n.status === 'active') problems.push(`orphan: ${n.path} is not in INDEX.md`)
      if (routed && n.status !== 'active') problems.push(`${n.path} is ${n.status} but still in INDEX.md`)
    }
  }
  for (const n of notes) {
    for (const l of n.links) if (!ids.has(l)) problems.push(`${n.path} links to unknown note "${l}"`)
    for (const f of n.files) if (!(await $.fs.exists(f))) problems.push(`${n.path} is about ${f}, which no longer exists`)
  }
  if (await $.fs.exists(`${DIR}/HANDOFF.md`)) {
    const age = await ageDays($, `${DIR}/HANDOFF.md`)
    if (age > STALE_DAYS) problems.push(`HANDOFF.md is ${Math.round(age)} days old: verify against git log before trusting it`)
  }
  return { problems, notes, indexLines }
}

// What a fresh stretch reads: the routing table and where the last one stopped.
async function compose($: Engine): Promise<string | null> {
  const index = await readCapped($, `${DIR}/INDEX.md`, INDEX_CAP)
  let handoff: string | null = null
  if (await $.fs.exists(`${DIR}/HANDOFF.md`)) {
    const age = await ageDays($, `${DIR}/HANDOFF.md`)
    handoff =
      age <= STALE_DAYS
        ? await readCapped($, `${DIR}/HANDOFF.md`, HANDOFF_CAP + 20)
        : `(${Math.round(age)} days old, stale. Check git log before trusting it.)`
  }
  if (index === null && handoff === null) return null
  return [
    `The folder is the state. ${DIR}/INDEX.md is the routing table: one line per note saying when to read it; open a note only when its line applies. ${DIR}/HANDOFF.md is where the last stretch stopped. ${DIR}/log.md is append-only history; grep it, never load it whole. /molt saves state here, then the session compacts.`,
    index !== null ? `## ${DIR}/INDEX.md\n${index}` : '',
    handoff !== null ? `## ${DIR}/HANDOFF.md\n${handoff}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

const COMPACT_INSTRUCTIONS = `The project state was just saved to ${DIR}/HANDOFF.md and ${DIR}/INDEX.md, which the conversation carries. Keep only: the user's latest request, what is in progress right now, files currently being edited, and any tool result the very next step needs. Drop everything the handoff covers.`

// The free answers: lint and graph never touch the model.
async function answer($: Engine, what: 'lint' | 'graph'): Promise<{ text: string }> {
  const { problems, notes, indexLines } = await lint($)
  if (what === 'graph') return { text: graphText(notes) }
  const head = `${DIR}/: ${notes.length} note(s), INDEX.md ${indexLines}/${INDEX_CAP} lines`
  return { text: problems.length ? `${head}\n${problems.map(p => `- ${p}`).join('\n')}` : `${head}\nclean.` }
}

function graphText(notes: Note[]): string {
  if (!notes.length) return `${DIR}/notes/ is empty.`
  return notes
    .map(
      n =>
        `${n.id}${n.status !== 'active' ? ` (${n.status})` : ''} -> ${n.links.join(', ') || '(no links)'}${n.files.length ? `  files: ${n.files.join(', ')}` : ''}`,
    )
    .join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Registered commands raise command.run and answer without a model turn, in every mode.
    // (/molt itself is the plugin's markdown command: a skill the model expands.)
    await $.command.register({ name: 'molt-lint', description: `Lint ${DIR}/: index cap, orphans, broken links, stale handoff. Free.` })
    await $.command.register({ name: 'molt-graph', description: `Print ${DIR}/notes links as note -> links. Free.` })
    S.section = await compose($)
    const { problems } = await lint($)
    if (problems.length) $.ui.toast(`${DIR}: ${problems.length} lint issue(s). Run /molt-lint.`)
    return next(e)
  })

  // Rides the first user message next to claudeMd; changes only when a molt rewrote the files.
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    if (S.section === null) return r
    return { ...r, blocks: [...r.blocks, { name: 'molt', text: S.section }] }
  })

  // The molt turn ended: re-read the files it wrote, then compact. A refused compaction is silent.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    if (S.phase === 'shedding') {
      S.phase = 'idle'
      if (e.reason === 'answer') {
        S.section = await compose($)
        await $.session.compact({ instructions: COMPACT_INSTRUCTIONS }).catch(() => undefined)
      }
    }
    return next(e)
  })

  // Names may come namespaced (molt:molt-lint) from an installed plugin, bare from --plugin-dir.
  on('command.run', { command: ['molt-lint', 'molt:molt-lint'] }, $ => answer($, 'lint'))
  on('command.run', { command: ['molt-graph', 'molt:molt-graph'] }, $ => answer($, 'graph'))

  // A molt is starting: the model is about to save state. Fires however /molt was invoked.
  on('skill.prompt', { skill: ['molt', 'molt:molt'] }, ($, e, next) => {
    const arg = /The user adds: (\S*)/.exec(e.text)?.[1]
    if (arg === 'lint' || arg === 'graph') {
      // Typed as /molt lint where the skill path took it: hand the model the free answer to relay.
      return answer($, arg).then(r => ({ text: `Relay this to the user exactly, then stop:\n\n${r.text}` }))
    }
    S.phase = 'shedding'
    return next(e)
  })
  on('command.run', { command: ['molt', 'molt:molt'] }, ($, e, next) => {
    const arg = e.args.trim()
    if (arg === 'lint' || arg === 'graph') return answer($, arg)
    S.phase = 'shedding'
    return next(e)
  })
}
