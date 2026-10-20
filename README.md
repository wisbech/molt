# molt

When context outgrows its shell, shed it into the folder and keep going.

A Claude Code mod. One command you run on purpose, no new session, nothing running in the background.

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

Those cap the size. Molt adds the part they do not: a handoff in a folder, so a compaction, a `/clear`
or a new session resumes from where you stopped.

## What was measured

Version 0.3 molted by itself, on an idle timer and on context size. Over two weeks its own
turns were 13–87% of each session's tokens. A molt costs 3–4 full context reads (the handoff
turn's calls plus the compaction); the cold cache rewrite it was meant to avoid costs one write.
The automatic molts ate the per-call gain, so 0.4.0 removes them.

Claude Code's own `/autocompact 150k` caps the context for free; pair molt with it. What is worth
keeping is the folder-as-state convention and the commands you run on purpose.

## The mechanism

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

## Where it works

| Surface | Commands |
|---|---|
| Terminal, Desktop app | `/molt`, `/molt-lint`, `/molt-graph` |
| Remote Control thread (phone or claude.ai driving your own machine) | `/molt`, and `/molt lint` with a space |
| Cloud session (claude.ai Projects, claude.ai/code, `claude --cloud`) | the same, once the environment loads molt (below) |
| Plain claude.ai chat without Claude Code | none: no plugins run there |

### Cloud sessions and claude.ai Projects

A cloud session runs in a fresh container and does **not** install plugins a repository declares in
`.claude/settings.json`. Load molt through the environment instead. In claude.ai, open the project's
settings, edit its cloud environment, and set:

Environment variables:
```
CLAUDE_CODE_PLUGIN_DIRS=~/molt
```

Setup script:
```bash
git clone --depth 1 https://github.com/wisbech/molt.git ~/molt
```

The setup script runs before Claude Code starts, and `CLAUDE_CODE_PLUGIN_DIRS` loads the clone like
`--plugin-dir`. Every thread in that project then has `/molt`. Because the container is wiped between
sessions, a cloud `/molt` commits `.state/` and pushes the thread's branch, so the next session resumes
from it.

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

- `/molt [note]` before you leave a thread or when it feels heavy. The model writes the handoff to
  `.state/`, then the session compacts in place. The note goes to the next stretch.
- `/molt-lint` is free deterministic housekeeping: index cap, orphans, broken links,
  superseded notes still routed, notes about deleted files, stale handoff. No model turn.
- `/molt-graph` prints `note -> links`. Also free.
- `/autocompact 150k` for the context cap. It is Claude Code's own, it is free, and molt leaves that job to it.

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
