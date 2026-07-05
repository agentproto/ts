---
---

docs(cli): keep the 409 send_prompt_failed example on one line in chat.md

The inline code span `` `409 {…}` `` wrapped across three lines. Markdown
doesn't allow an inline code span to cross a line break, so the closing
backtick never matched and the `{"error":…}` JSON leaked out as raw text —
which breaks MDX consumers (the cli.agentproto.sh docs site parses these files
as MDX and reads `{…}` as a JSX expression, failing the build). Collapsed the
example onto a single backticked line. Docs-only, no release.
