---
"@agentproto/runtime": patch
---

Turn retry no longer counts provably read-only shell commands as side-effecting tool calls. A shell call's recorded name is its command line, and the gate used to look only at its first word, so `git status --short && git diff --stat` blocked the retry of a turn cut by a transient error (EPROTO, 5xx, 429) while `cat >> notes.md` passed as a read. The gate now parses the command and accepts it only when every command in it is an allowlisted read-only program (`git status|diff|log|show|rev-parse|ls-remote|...`, `cat`, `sed -n`, `grep`, `rg`, `ls`, `head`, `tail`, `wc`, `pwd`, `echo`, `cd`, ...) joined by `&&`, `||`, `;` or `|`, with no output redirection to a file. Anything it cannot parse (command substitution, subshells, heredocs, loops) still counts, as do `git commit`, `sed -i`, `tee`, `> file` and `pnpm test`.
