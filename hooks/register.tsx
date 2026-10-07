// molt: when context outgrows its shell, shed it into the folder and keep going.
//
// Criteria, in order of what they save:
//   1. idle: the prompt cache expires after an hour idle, and the first call after that
//      re-writes the whole context at full price. So 50 minutes into an idle stretch,
//      while the cache is still warm and reads are cheap, molt; the rewrite on return
//      is then of a small context. This is where the money went in the traces.
//   2. size: context tokens >= the ceiling, the backstop. The ceiling is solved, not set:
//      over a stretch between molts, tokens per call ≈ (F + T)/2 + m·T·g/(T − F), where
//      F is the floor (context right after a molt), g the growth per API call and m the
//      reads a molt itself costs. Its minimum is T = F + sqrt(2·m·g·F). Molt measures
//      F, g and m from usage and re-solves after every turn; `threshold` pins it instead.
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
const IDLE_FLOOR = 50_000 // below this a fresh session costs about the same; nothing to shed

type Note = { id: string; path: string; title: string; status: string; links: string[]; files: string[] }
type Lint = { problems: string[]; notes: Note[]; indexLines: number }

// Module state. A reload starts it over, which is fine: it is all derivable.
const S = {
  section: null as string | null, // the context block; re-read after every molt
  ctx: 0,
  phase: 'idle' as 'idle' | 'shedding',
  molts: 0,
  last: '',
  idleTimer: null as { cancel: () => void } | null,
  // the sweet-spot inputs
  floor: 0, // F: context at the first turn after a start or a molt
  isFloorPending: true,
  growth: 5_000, // g: tokens added per API call, EMA
  moltReads: 3, // m: reads one molt costs (the handoff turn's calls + the compaction), EMA
  ceiling: 150_000, // T: solved, or pinned by the threshold option
}

const k = (n: number) => `${Math.round(n / 1000)}k`
const ema = (old: number, next: number, a = 0.3) => old + a * (next - old)

// Tokens read this turn across all its API calls, and how many calls that was.
function turnReads(usage: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | undefined, ctxBefore: number, ctxAfter: number) {
  if (!usage) return null
  const reads = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const avgCtx = Math.max(1, (Math.max(ctxBefore, 1) + Math.max(ctxAfter, 1)) / 2)
  return { reads, calls: Math.max(1, Math.round(reads / avgCtx)) }
}

// T = F + sqrt(2·m·g·F), kept inside sane bounds and rounded to 5k.
export function solveCeiling(floor: number, growth: number, moltReads: number): number {
  const f = Math.max(20_000, floor)
  const t = f + Math.sqrt(2 * Math.max(1, moltReads) * Math.max(500, growth) * f)
  return Math.round(Math.min(400_000, Math.max(f + 20_000, t)) / 5_000) * 5_000
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
    `The folder is the state. ${DIR}/INDEX.md is the routing table: one line per note saying when to read it; open a note only when its line applies. ${DIR}/HANDOFF.md is where the last stretch stopped. ${DIR}/log.md is append-only history; grep it, never load it whole. When context grows past the threshold or the session idles, it molts: /molt saves state here, then the session compacts.`,
    index !== null ? `## ${DIR}/INDEX.md\n${index}` : '',
    handoff !== null ? `## ${DIR}/HANDOFF.md\n${handoff}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

const COMPACT_INSTRUCTIONS = `The project state was just saved to ${DIR}/HANDOFF.md and ${DIR}/INDEX.md, which the conversation carries. Keep only: the user's latest request, what is in progress right now, files currently being edited, and any tool result the very next step needs. Drop everything the handoff covers.`

// Shedding runs as its own turn once the session is idle; a timer outlives the dispatch.
function shed($: Engine): void {
  if (S.phase === 'shedding') return
  S.phase = 'shedding'
  S.idleTimer?.cancel()
  S.idleTimer = null
  $.ui.invalidate('ui.render')
  $.clock.after(1, () => void $.prompt.submit({ text: '/molt' }))
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

export const register: Register = (on, options) => {
  const pinned = Number(options?.threshold) > 0 ? Math.max(20_000, Number(options?.threshold)) : 0 // 0 = solve it
  if (pinned) S.ceiling = pinned
  const idleMinutes = String(options?.idleMinutes ?? '').trim() === '0' ? 0 : Math.max(1, Number(options?.idleMinutes) || 50)
  const isAuto = options?.auto !== false

  // A new prompt means the person is back: the idle clock starts over at turn.complete.
  on('prompt.submit', ($, e, next) => {
    S.idleTimer?.cancel()
    S.idleTimer = null
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    // Priors from earlier sessions; this session's floor is measured on its first turn.
    const g = Number(await $.store.get('growth'))
    const m = Number(await $.store.get('moltReads'))
    if (g > 0) S.growth = g
    if (m > 0) S.moltReads = m
    S.isFloorPending = true
    S.section = await compose($)
    const { problems } = await lint($)
    if (problems.length) $.ui.toast(`${DIR}: ${problems.length} lint issue(s). Run /molt lint.`)
    return next(e)
  })

  // Rides the first user message next to claudeMd; changes only when a molt rewrote the files.
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    if (S.section === null) return r
    return { ...r, blocks: [...r.blocks, { name: 'molt', text: S.section }] }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    const ctxBefore = S.ctx
    const { context } = await $.session.usage()
    S.ctx = context.tokens ?? 0
    const t = turnReads(e.usage, ctxBefore, S.ctx)

    if (S.isFloorPending && S.ctx > 0) {
      S.floor = S.ctx
      S.isFloorPending = false
    } else if (S.phase === 'idle' && t && S.ctx > ctxBefore) {
      S.growth = ema(S.growth, (S.ctx - ctxBefore) / t.calls)
      void $.store.set('growth', S.growth)
    }

    if (S.phase === 'shedding') {
      S.phase = 'idle'
      if (e.reason === 'answer') {
        const before = S.ctx
        if (t) {
          S.moltReads = ema(S.moltReads, t.calls + 1) // the handoff turn's calls, plus the compaction
          void $.store.set('moltReads', S.moltReads)
        }
        S.section = await compose($)
        const r = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS })
        if ('skip' in r) {
          S.last = `molt: compaction skipped (${r.skip})`
        } else {
          S.molts += 1
          S.ctx = r.tokensAfter ?? S.ctx
          S.isFloorPending = true // the next turn measures the new floor
          S.last = `molted ${k(before)} → ${k(S.ctx)}`
        }
        $.ui.toast(S.last)
      } else {
        S.last = `molt interrupted (${e.reason})`
      }
    }

    if (!pinned) S.ceiling = solveCeiling(S.floor || S.ctx, S.growth, S.moltReads)

    if (S.phase === 'idle' && isAuto && S.ctx >= S.ceiling) {
      shed($)
    } else if (S.phase === 'idle' && isAuto && idleMinutes > 0 && S.ctx >= IDLE_FLOOR) {
      // Molt before the cache goes cold, not after.
      S.idleTimer?.cancel()
      S.idleTimer = $.clock.after(idleMinutes * 60_000, () => {
        S.idleTimer = null
        S.last = `idle ${idleMinutes} min, molting before the cache expires`
        shed($)
      })
    }

    $.ui.status(`ctx ${k(S.ctx)}${S.molts ? ` · molts ${S.molts}` : ''}`)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // The bar: context against the threshold, and the one button.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (S.ctx < 20_000 && S.phase === 'idle' && !S.last)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const text =
      S.phase === 'shedding'
        ? `molting… saving ${DIR}/HANDOFF.md, then compacting`
        : `ctx ${k(S.ctx)} · molts at ${k(S.ceiling)}${pinned ? '' : ` (solved: floor ${k(S.floor)}, +${k(S.growth)}/call, molt ${S.moltReads.toFixed(1)} reads)`} or ${idleMinutes} min idle${S.last ? ` · ${S.last}` : ''} `
    return (
      <Box>
        <Text dimColor>{text}</Text>
        {S.phase === 'idle' && <Button key="molt" label="Molt now" onPress={() => shed($)} />}
      </Box>
    )
  })

  // /molt lint and /molt graph answer here; anything else runs commands/molt.md and sheds.
  on('command.run', { command: 'molt' }, async ($, e, next) => {
    const arg = e.args.trim()
    if (arg === 'lint' || arg === 'graph') {
      const { problems, notes, indexLines } = await lint($)
      if (arg === 'graph') return { text: graphText(notes) }
      const head = `${DIR}/: ${notes.length} note(s), INDEX.md ${indexLines}/${INDEX_CAP} lines, context ${k(S.ctx)}, molts ${S.molts}, ceiling ${k(S.ceiling)}${pinned ? ' (pinned)' : ` (floor ${k(S.floor)}, growth ${k(S.growth)}/call, molt ${S.moltReads.toFixed(1)} reads)`}`
      return { text: problems.length ? `${head}\n${problems.map(p => `- ${p}`).join('\n')}` : `${head}\nclean.` }
    }
    S.phase = 'shedding'
    S.idleTimer?.cancel()
    S.idleTimer = null
    $.ui.invalidate('ui.render')
    return next(e)
  })
}
