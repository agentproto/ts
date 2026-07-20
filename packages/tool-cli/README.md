# @agentproto/tool-cli

Generic command-line projection for an AIP-14 `ToolHandle`.

`toCliCommand` turns a tool contract and candidate drivers into a typed argv
parser plus a `runTool` dispatcher. Object Zod inputs become flags; arrays are
repeatable flags, booleans accept `--flag` / `--no-flag`, and non-object inputs
use one JSON positional argument. The embedding CLI owns its command registry,
policy checks and output stream.
