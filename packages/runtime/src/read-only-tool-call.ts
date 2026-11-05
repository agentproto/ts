/**
 * Is a tool call provably read-only? Read by the turn-retry side-effect gate
 * (`decideTurnRetry`): a turn whose calls are all read-only may be continued
 * after a transient provider failure without re-running a write.
 *
 * The input is the name the daemon recorded for the call (`SessionTurnEndEvent
 * .toolCalls`). Adapters give either a bare harness tool name (`read`, `grep`,
 * `bash`, `edit`) or a title, and for a shell call the ACP title is the
 * command line itself (opencode and claude-code both enrich the announced
 * `bash` / `Terminal` call with the raw command). So a multi-word name is
 * parsed as a shell command and accepted only when every simple command in it
 * runs an allowlisted read-only program with read-only arguments and no
 * output redirection to a file.
 *
 * Conservative by construction: anything the parser does not understand
 * (command substitution, subshells, heredocs, control flow, unknown programs)
 * counts as possibly side-effecting.
 */

/** Bare harness tool names (first word of the name, lowercased) that never
 *  write. Also accepted as the head of a harness title ("Read File",
 *  "Search \"foo\""), except the ones that are shell programs too. */
const READ_ONLY_TOOLS = new Set([
  "read",
  "view",
  "cat",
  "glob",
  "grep",
  "ls",
  "list",
  "find",
  "search",
  "fetch",
  "webfetch",
  "websearch",
  "todoread",
  "todowrite",
  "think",
])

/** Harness names that are also shell programs: a multi-word name headed by
 *  one of them is a command line, judged by the shell classifier only (so
 *  `cat >> notes.md` is a write, not a "cat"). */
const SHELL_PROGRAM_HEADS = new Set(["cat", "grep", "ls", "find"])

export function isReadOnlyToolName(name: string): boolean {
  const trimmed = name.trim()
  const head = trimmed.split(/[\s:(_.-]/)[0]?.toLowerCase() ?? ""
  if (head === "") return false
  if (!/\s/.test(trimmed)) return READ_ONLY_TOOLS.has(head)
  if (isReadOnlyShellCommand(trimmed)) return true
  // A harness title ("Read File", "Search \"a|b\""): never one that chains a
  // second command or redirects.
  return READ_ONLY_TOOLS.has(head) && !SHELL_PROGRAM_HEADS.has(head) && !hasShellControl(trimmed)
}

function hasShellControl(text: string): boolean {
  const tokens = tokenize(text)
  if (!tokens) return /[;&|<>\n]/.test(text)
  return tokens.some(t => t.t !== "word")
}

// ── shell command classifier ─────────────────────────────────────────────

type Token =
  | { t: "word"; v: string }
  | { t: "op"; v: "&&" | "||" | ";" | "|" | "&" }
  | { t: "redir"; v: "out" | "dup" | "in" }

/** Split a command line into words, control operators and redirections.
 *  `undefined` = a construct this classifier does not try to understand. */
function tokenize(src: string): Token[] | undefined {
  const out: Token[] = []
  let word = ""
  let inWord = false
  const flush = () => {
    if (inWord) out.push({ t: "word", v: word })
    word = ""
    inWord = false
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    const next = src[i + 1]
    if (c === "\\") {
      if (next === undefined) return undefined
      if (next !== "\n") {
        word += next
        inWord = true
      }
      i++
      continue
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      if (end < 0) return undefined
      word += src.slice(i + 1, end)
      inWord = true
      i = end
      continue
    }
    if (c === '"') {
      let j = i + 1
      for (; j < src.length && src[j] !== '"'; j++) {
        const d = src[j]!
        if (d === "`" || (d === "$" && src[j + 1] === "(")) return undefined
        if (d === "\\" && j + 1 < src.length) {
          word += src[j + 1]
          j++
        } else word += d
      }
      if (j >= src.length) return undefined
      inWord = true
      i = j
      continue
    }
    if (c === "`" || c === "(" || c === ")") return undefined
    if (c === "$" && next === "(") return undefined
    if (c === "#" && !inWord) {
      const nl = src.indexOf("\n", i)
      if (nl < 0) break
      i = nl - 1
      continue
    }
    if (c === " " || c === "\t") {
      flush()
      continue
    }
    if (c === "\n") {
      flush()
      out.push({ t: "op", v: ";" })
      continue
    }
    if (c === ";") {
      if (next === ";") return undefined // `case` arm
      flush()
      out.push({ t: "op", v: ";" })
      continue
    }
    if (c === "|") {
      flush()
      if (next === "|") {
        out.push({ t: "op", v: "||" })
        i++
      } else {
        out.push({ t: "op", v: "|" })
        if (next === "&") i++ // `|&` pipes stderr too
      }
      continue
    }
    if (c === "&") {
      flush()
      if (next === "&") {
        out.push({ t: "op", v: "&&" })
        i++
      } else if (next === ">") {
        // `&>` / `&>>`: both streams to a file
        out.push({ t: "redir", v: "out" })
        i += src[i + 2] === ">" ? 2 : 1
      } else out.push({ t: "op", v: "&" })
      continue
    }
    if (c === ">" || c === "<") {
      // A digits-only word right before is the fd (`2>`), not an argument.
      if (inWord && !/^\d+$/.test(word)) flush()
      word = ""
      inWord = false
      if (c === "<") {
        if (next === "<" || next === ">" || next === "(") return undefined // heredoc, read-write open, process subst
        if (next === "&") {
          out.push({ t: "redir", v: "dup" })
          i++
        } else out.push({ t: "redir", v: "in" })
        continue
      }
      if (next === "(") return undefined
      if (next === "&") {
        out.push({ t: "redir", v: "dup" })
        i++
      } else {
        out.push({ t: "redir", v: "out" })
        if (next === ">" || next === "|") i++
      }
      continue
    }
    word += c
    inWord = true
  }
  flush()
  return out
}

/** True when `cmd` is a shell command line made only of read-only programs. */
export function isReadOnlyShellCommand(cmd: string): boolean {
  const tokens = tokenize(cmd)
  if (!tokens) return false
  let words: string[] = []
  let sawCommand = false
  const endCommand = (): boolean => {
    const ok = isReadOnlySimpleCommand(words)
    if (words.length > 0) sawCommand = true
    words = []
    return ok
  }
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (tok.t === "word") words.push(tok.v)
    else if (tok.t === "op") {
      if (!endCommand()) return false
    } else {
      const target = tokens[i + 1]
      if (target?.t !== "word") return false
      i++
      if (tok.v === "out" && target.v !== "/dev/null") return false
      // `>&2`, `2>&1`, `<&0`, `>&-`: fd duplication only, never a file.
      if (tok.v === "dup" && !/^(?:\d+|-)$/.test(target.v)) return false
    }
  }
  if (!endCommand()) return false
  return sawCommand
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Programs that only read, whatever their arguments. */
const ALWAYS_READ_ONLY = new Set([
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "echo",
  "printf",
  "ls",
  "grep",
  "egrep",
  "fgrep",
  "nl",
  "cut",
  "tr",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "stat",
  "du",
  "df",
  "which",
  "type",
  "whoami",
  "id",
  "uname",
  "true",
  "false",
  ":",
  "test",
  "[",
  "sleep",
  "diff",
  "cmp",
  "comm",
  "jq",
  "printenv",
  "column",
  // Changes the shell's own cwd and nothing else.
  "cd",
])

function isReadOnlySimpleCommand(words: readonly string[]): boolean {
  let i = 0
  while (i < words.length && ASSIGNMENT.test(words[i]!)) i++
  if (i === words.length) return true // empty, or shell-local assignments only
  const program = words[i]!
  const args = words.slice(i + 1)
  if (ALWAYS_READ_ONLY.has(program)) return true
  switch (program) {
    case "rg":
      return !args.some(a => a === "--pre" || a.startsWith("--pre="))
    case "sort":
      return !args.some(a => /^-[^-]*o/.test(a) || a.startsWith("--output") || a.startsWith("--compress-program"))
    case "uniq":
      // `uniq IN OUT` writes OUT.
      return args.filter(a => !a.startsWith("-")).length <= 1
    case "sed":
      return isReadOnlySed(args)
    case "find":
      return !args.some(a => FIND_ACTIONS.has(a))
    case "git":
      return isReadOnlyGit(args)
    case "set":
      return args.every(a => /^[-+][a-zA-Z]+$/.test(a) || SET_OPTIONS.has(a))
    case "export":
      return args.every(a => ASSIGNMENT.test(a) || /^[A-Za-z_][A-Za-z0-9_]*$/.test(a))
    case "command":
      return args[0] === "-v" || args[0] === "-V"
    case "env":
      return args.length === 0
    case "date":
      return !args.some(a => a === "-s" || a.startsWith("--set"))
    default:
      return false
  }
}

const SET_OPTIONS = new Set(["pipefail", "errexit", "nounset", "xtrace"])

const FIND_ACTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
])

/** `sed -n` printing line ranges / one regex address, never in place. */
function isReadOnlySed(args: readonly string[]): boolean {
  let quiet = false
  const scripts: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "-i" || a.startsWith("-i") || a.startsWith("--in-place")) return false
    if (a === "-e" || a === "--expression") {
      const s = args[++i]
      if (s === undefined) return false
      scripts.push(s)
    } else if (a === "-n" || a === "--quiet" || a === "--silent") quiet = true
    else if (/^-[nErsu]+$/.test(a)) {
      if (a.includes("n")) quiet = true
    } else if (a.startsWith("-")) return false
    else if (scripts.length === 0) scripts.push(a)
    // otherwise: an input file
  }
  if (!quiet || scripts.length === 0) return false
  const addr = String.raw`(?:\d+|\$|/[^/]*/)`
  const print = new RegExp(String.raw`^\s*(?:${addr}(?:\s*,\s*${addr})?\s*p\s*(?:;\s*|$))+$`)
  return scripts.every(s => print.test(s))
}

const GIT_READ_ONLY = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-remote",
  "ls-files",
  "ls-tree",
  "blame",
  "grep",
  "describe",
  "shortlog",
  "cat-file",
  "rev-list",
  "merge-base",
  "show-ref",
  "for-each-ref",
  "name-rev",
  "cherry",
  "check-ignore",
  "diff-tree",
  "diff-files",
  "diff-index",
  "count-objects",
  "version",
])

const GIT_BRANCH_LIST_FLAGS = new Set([
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "-l",
  "--list",
  "--show-current",
  "--no-color",
  "--merged",
  "--no-merged",
  "--contains",
  "--no-contains",
  "--points-at",
  "-i",
  "--ignore-case",
  "--no-column",
])

/** Flags that put `git branch` in list mode: a positional is then a pattern
 *  or a commit, not a branch to create. */
const GIT_BRANCH_LIST_MODE = new Set([
  "-l",
  "--list",
  "--show-current",
  "--merged",
  "--no-merged",
  "--contains",
  "--no-contains",
  "--points-at",
])

const GIT_CONFIG_READ = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l"])
const GIT_CONFIG_SCOPE = new Set([
  "--global",
  "--local",
  "--system",
  "--show-origin",
  "--show-scope",
  "--name-only",
  "-z",
  "--null",
  "--includes",
])

function isReadOnlyGit(argv: readonly string[]): boolean {
  let i = 0
  // Global options. `-c` (can set a hook-like command) and anything unknown
  // refuse.
  while (i < argv.length && argv[i]!.startsWith("-")) {
    const a = argv[i]!
    if (a === "-C") i += 2
    else if (a === "--no-pager" || a === "-P" || a === "--no-optional-locks") i++
    else if (a.startsWith("--git-dir=") || a.startsWith("--work-tree=")) i++
    else return false
  }
  const sub = argv[i]
  if (sub === undefined) return false
  const args = argv.slice(i + 1)
  // `--output=<file>` (diff/log/show) writes; `--upload-pack` and
  // `--open-files-in-pager` run a program.
  if (args.some(a => a.startsWith("--output") || a.startsWith("--upload-pack") || a.startsWith("--open-files-in-pager"))) {
    return false
  }
  if (GIT_READ_ONLY.has(sub)) return !(sub === "grep" && args.some(a => /^-O/.test(a)))
  switch (sub) {
    case "branch": {
      const flags = args.filter(a => a.startsWith("-"))
      const ok = flags.every(
        a =>
          GIT_BRANCH_LIST_FLAGS.has(a) ||
          a.startsWith("--sort=") ||
          a.startsWith("--format=") ||
          a.startsWith("--color") ||
          a.startsWith("--column") ||
          a.startsWith("--abbrev"),
      )
      if (!ok) return false
      return flags.length === args.length || flags.some(a => GIT_BRANCH_LIST_MODE.has(a))
    }
    case "remote":
      return args.every(a => a === "-v" || a === "--verbose") || args[0] === "get-url" || args[0] === "show"
    case "stash":
      return args[0] === "list" || args[0] === "show"
    case "worktree":
      return args[0] === "list"
    case "config": {
      const flags = args.filter(a => a.startsWith("-"))
      return flags.some(a => GIT_CONFIG_READ.has(a)) && flags.every(a => GIT_CONFIG_READ.has(a) || GIT_CONFIG_SCOPE.has(a))
    }
    case "tag": {
      if (args.length === 0) return true
      const flags = args.filter(a => a.startsWith("-"))
      return (
        flags.some(a => a === "-l" || a === "--list") &&
        flags.every(
          a =>
            a === "-l" ||
            a === "--list" ||
            /^-n\d*$/.test(a) ||
            a.startsWith("--sort=") ||
            a.startsWith("--format=") ||
            a === "--contains" ||
            a === "--points-at" ||
            a === "--merged" ||
            a === "--no-merged" ||
            a === "-i" ||
            a === "--ignore-case",
        )
      )
    }
    default:
      return false
  }
}
