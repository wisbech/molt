# molt

When context outgrows its shell, shed it into the folder and keep going.

## Why

Token spend in Claude Code tracks thread length, not cache misses. A thread kept open for
a week re-reads ~500k tokens on every call. Molt keeps the session but not the shell.

## The mechanism

Two criteria, one call.

1. **Idle.** The prompt cache expires after an hour idle. The first call after that
   re-writes the whole context at full write price; in a week-long trace every expensive
   event was one of these, 550k to 850k tokens each. So 50 minutes into an idle stretch,
   while the cache is still warm and reads are cheap, the session molts. When you come back
   the rewrite is of a 60k context, not 500k.
2. **Size.** Context tokens ≥ the ceiling, the backstop. The ceiling is solved, not set.
   Over a stretch between molts, tokens per call ≈ (F + T)/2 + m·T·g/(T − F): F the floor
   (context right after a molt), g the growth per API call, m the reads a molt costs. The
   minimum is T = F + √(2·m·g·F). Molt measures all three from usage and re-solves after
   every turn, so light chat lands near 95k and heavy subagent work near 165k on a 73k floor.
   Set `threshold` to a number to pin it instead.

The call is `/molt`. The model saves state to `.state/`; the mod then compacts the session in
place with instructions to keep only what the handoff does not cover. Same session, same
prompt box, next call carries a fraction of the tokens.

```
.state/
  INDEX.md      routing table: one line per note, says WHEN to read it (cap 200)
  HANDOFF.md    where the last stretch stopped (cap 60; rewritten by each molt)
  log.md        append-only history; grep it, never load it whole
  notes/*.md    decisions, failures, patterns; frontmatter links/files form the graph
```

INDEX.md and a fresh HANDOFF.md ride the first user message next to CLAUDE.md. A HANDOFF
older than 7 days is marked stale, not trusted.

## Use

- Nothing, usually. At the threshold the session molts by itself.
- The bar above the prompt shows `ctx 132k · molts at 120k (solved: …)` and a **Molt now** button.
- `/molt [note]` molts now, with a note for the next stretch.
- `/molt lint` is free deterministic housekeeping: index cap, orphans, broken links,
  superseded notes still routed, notes about deleted files, stale handoff.
- `/molt graph` prints `note -> links`.
- Options: `idleMinutes` (default 50; set to your cache TTL minus a margin), `threshold`
  (empty: solved; a number pins it), `auto` (off: button and command only).

## Borrowed from

- wisbech/serf: "the folder is the state"; bandit's folder-router: folders as routing table
- karpathy LLM wiki: index + append-only log + lint
- Anthropic harness guidance: progress file, fixed startup routine, git as the safety net
- Graphiti: supersede, never delete
