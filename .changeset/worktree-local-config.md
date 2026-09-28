---
"@agentproto/worktree": minor
---

`worktree.provision` gains `cloneGlobs`: glob patterns of gitignored dirs/files (e.g. `node_modules`) cloned into the worktree before `depsCmd`, copy-on-write where the filesystem supports it (macOS `cp -Rc`, Linux `cp --reflink=auto`), falling back to a plain copy, never a symlink. New file `<repoRoot>/.agentproto/worktree.json`: a local, gitignored, host-owned config a machine can use to declare its own `depsCmd`/`linkPaths`/`copyGlobs`/`cloneGlobs`/`writeFiles` defaults (with a `{slug}` placeholder in `writeFiles`), read straight off disk rather than committed. Precedence: explicit tool input > local `worktree.json` > committed `agentproto.json`. Both `worktree.provision` and the daemon's `agent_start({worktree})` spawn path pick up the new local config automatically.
