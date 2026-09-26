# Correctness rubric

Review the range for defects this change INTRODUCES. Not style, not naming.

- **high** — a real correctness or security regression: wrong result, crash,
  data loss, broken public contract, auth/permission bypass, a test that now
  passes for the wrong reason.
- **medium** — a plausible bug on an edge path, a missing guard on untrusted
  input, a contract change without its callers updated.
- **low** — everything else worth mentioning.

Pre-existing problems the range doesn't touch are out of scope. When unsure
whether something is a regression, read the base version of the file.
