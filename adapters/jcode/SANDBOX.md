# jcode sandbox

jcode runs shell commands and file edits as direct tool calls — there is no
documented sandbox or permission-gating flag for non-interactive `jcode run`.
The host should scope the working directory and env to limit blast radius.
