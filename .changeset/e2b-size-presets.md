---
"@agentproto/sandbox-e2b": minor
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Size presets for the e2b workstation: `config.size` (`nano`, `small`, `medium`, `large`, `x-large`, `xx-large`) boots that preset's published `agentproto-workstation-<size>` template. `config.template` still wins, and with neither set the bare `agentproto-workstation` template boots, now built at the default `large` (4 vCPU / 8 GB). An unknown size fails with the list of valid sizes; a size e2b refused to create (today `x-large` / `xx-large`, over the plan's 8 vCPU / 8192 MB cap) fails with the recorded e2b error. Exports `SIZES`, `DEFAULT_SIZE` and the `WorkstationSize` type. The workstation templates now bake the GitHub CLI (`gh`, pinned and checksum-verified).

Sandbox agents can open PRs themselves: a spawn whose workspace has a remote token now also gets that same daemon-derived token as `GH_TOKEN`, next to `AGENTPROTO_GIT_TOKEN`, so `gh pr create` works in the box (the token needs Contents + Pull requests write). `GH_TOKEN` is reserved like `AGENTPROTO_GIT_TOKEN`: it is stripped from caller-declared `env.passthrough` / `env.auth.state.env` / `join.tokenEnv`, and it never resolves to the daemon's own `GH_TOKEN`. A caller that used to pass `GH_TOKEN` through `env.passthrough` no longer gets it in the box.
