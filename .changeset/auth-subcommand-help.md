---
"@agentproto/cli": patch
---

Auth subcommand help: `agentproto auth <sub> --help` (and `-h`) printed usage instead of crashing with a bare `TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]` for every subcommand (login, status, logout, provider, cred, profile, subaccounts, discover).
