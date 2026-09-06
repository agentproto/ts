Replace this prompt file with the agent step's real task: what it reads,
what it produces, and any hard constraints. This file is loaded at workflow
load time and becomes the step's prompt (it wins over the manifest's inline
`prompt`), and its sha256 is pinned into the run record.

Use `$input.<name>` placeholders for the workflow's declared inputs.
