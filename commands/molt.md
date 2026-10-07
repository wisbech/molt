---
description: Molt now: save state to .state/ and compact this session in place (housekeeping is /molt-lint, /molt-graph)
argument-hint: [note for the next stretch]
---
Molt: save the project state to `.state/` so this session can shed its history and continue from the folder. Use your file tools; create the folder if needed.

1. Replace `.state/HANDOFF.md`, under 60 lines, with sections: Goal, Status (done, and how it was verified), Decisions (this session, one line each with the reason), Open items, Files touched, Next step (one concrete action). The user adds: $ARGUMENTS
2. Append one line to `.state/log.md`: `## [YYYY-MM-DD HH:MM] molt | <title>`. Create the file if missing. Never edit earlier lines.
3. For each decision, failure or pattern worth keeping beyond this task, write `.state/notes/<kebab-id>.md` with frontmatter (`title`, `status: active`, `verified: <today>`, `files: [paths it is about]`, `links: [ids of related notes]`) and a body under 40 lines. Add one line to `.state/INDEX.md`: `- [title](notes/<id>.md) — read when <trigger>`. Keep INDEX.md under 200 lines. If a note supersedes another, set the old one's `status: superseded` and `superseded_by: <id>`, and remove its INDEX line.
4. Do not write what the code or git history already says. Do not change anything else.
5. Reply with one line naming what was written. The session compacts itself right after.
