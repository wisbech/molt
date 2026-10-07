# molt

When context outgrows its shell, shed it into the folder and keep going.

A Claude Code mod. Two criteria, one call, no new session, nothing to remember.

## The problem, measured

If your Claude Code usage looks like this, the cache is not your problem:

| | |
|---|---|
| Tokens, one project, one week | 158.7M |
| Cache hit rate | 96% |
| Cache read | 152.2M |
| Cache write | 5M |
| Uncached input | 0.7M |
| Output | 0.8M |

That is a healthy cache. Only 4% of input missed it. Yet 96% of all tokens were cache
*reads*, and cache reads are what you pay for a long thread: every API call resends the
whole conversation. A hit is cheaper than a miss, but half a million tokens of hits per
call, hundreds of times a day, is still the bill.

Parsing the session transcripts (`~/.claude/projects/<project>/*.jsonl`, one `usage` per
assistant message) found where it went. One thread had been kept open for seven days:

| The seven-day thread | |
|---|---|
| API calls | 618 |
| Average context per call | ~480k tokens |
| Peak context | 966k of a 1M window |
| Cache reads | 296M |
| Full cache rewrites | 14, each 550k to 850k tokens |
| Subagents spawned, all on the most expensive model | 61 |

Two mechanisms did the damage.

**1. Thread length.** Every tool call re-read ~480k tokens. A fresh session costs ~70k
tokens of system prompt, tools, skills and memory. Resuming the thread cost 480k on the
first message and on every call after it. The second-largest thread, same setup, averaged
230k per call and cost a quarter as much. Spend tracks thread length.

**2. The cache expiring while you sleep.** The prompt cache lives one hour on a
subscription (five minutes on an API key). Every morning's first message rewrote the
entire context at full write price. Fourteen such rewrites, 550k to 850k tokens each,
every one after an idle gap over an hour. Auto-compact never helped: on a 1M-window
model it fires at about 967k by default.

What it was not: the personal harness, hooks, voice calls and planning rituals accounted
for under 4% of the tokens. Uninstalling them would have changed nothing. Measure before
you blame your tooling.

### What Claude Code already gives you

- `/autocompact 150k` sets the auto-compact window per model and saves it.
- `/clear` between unrelated tasks. `/compact <focus>` at natural breaks.
- `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` in `settings.json` `env`: subagents inherit the
  main model unless told otherwise.
- `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` where available.
- `/context` and `/usage` to see what fills the window and what hits the cache.

Those fix the size. None of them fixes the idle rewrite, and all of them need you to
remember. Molt is the part that runs itself.

## The mechanism

Two criteria, one call.

1. **Idle.** The prompt cache expires after an hour idle. The first call after that
   re-writes the whole context at full write price; in the trace above every expensive
   event was one of these. So 50 minutes into an idle stretch, while the cache is still
   warm and reads are cheap, the session molts. When you come back the rewrite is of a
   60k context, not 500k.
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
older than 7 days is marked stale, not trusted. The folder is harness-agnostic: any agent
that reads markdown can continue from it.

## Install

Paste this into Claude Code and let the agent do it:

```
Install the molt mod for Claude Code:
1. claude plugin marketplace add wisbech/molt
2. claude plugin install molt@molt
3. If the build says hooks modules are early access, add "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" under "env" in ~/.claude/settings.json.
Then tell me whether /molt shows up in the command list.
```

By hand:

```bash
claude plugin marketplace add wisbech/molt
claude plugin install molt@molt
```

Or for one launch, without installing: `claude --plugin-dir /path/to/molt`.

Site: https://wisbech.github.io/molt/ · Tests: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`

## Use

- Nothing, usually. At a criterion the session molts by itself.
- The bar above the prompt shows `ctx 132k · molts at 120k (solved: …)` and a **Molt now** button.
- `/molt [note]` molts now, with a note for the next stretch.
- `/molt lint` is free deterministic housekeeping: index cap, orphans, broken links,
  superseded notes still routed, notes about deleted files, stale handoff.
- `/molt graph` prints `note -> links`.
- Options: `idleMinutes` (default 50; set to your cache TTL minus a margin), `threshold`
  (empty: solved; a number pins it), `auto` (off: button and command only).

## Measure your own

```bash
python3 - <<'EOF'
import json, glob, os
d = os.path.expanduser('~/.claude/projects/')
for f in sorted(glob.glob(d + '*/*.jsonl'), key=os.path.getsize, reverse=True)[:5]:
    seen, n, cr, cw, mx = set(), 0, 0, 0, 0
    for line in open(f):
        try: o = json.loads(line)
        except: continue
        m = o.get('message') or {}; u = m.get('usage') or {}
        if o.get('type') != 'assistant' or not u or m.get('id') in seen: continue
        seen.add(m.get('id')); n += 1
        ctx = u.get('input_tokens', 0) + u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0)
        cr += u.get('cache_read_input_tokens', 0); cw += u.get('cache_creation_input_tokens', 0); mx = max(mx, ctx)
    print(f"{os.path.basename(f)[:8]} calls={n} avg_ctx={(cr+cw)/max(n,1)/1e3:.0f}k peak={mx/1e3:.0f}k cache_read={cr/1e6:.0f}M cache_write={cw/1e6:.1f}M")
EOF
```

If `avg_ctx` is a few hundred k, you have the problem above.

## Borrowed from

- wisbech/serf: "the folder is the state"; bandit's folder-router: folders as routing table
- karpathy LLM wiki: index + append-only log + lint
- Anthropic harness guidance: progress file, fixed startup routine, git as the safety net
- Graphiti: supersede, never delete
- The evidence that context files restating the code cost more and help less
  (ETH Zurich, arXiv 2602.11988), and that LLM-maintained documents decay with edits:
  hence small files, an immutable log, deterministic lint.
