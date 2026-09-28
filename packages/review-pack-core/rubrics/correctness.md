# Correctness rubric

Review the committed range for defects it INTRODUCES. Not style, not
naming, not a pre-existing problem the range doesn't touch — read the base
version of a file when you're not sure whether something is a regression.

- **high** — a real correctness regression: a wrong result, a crash, data
  loss, a broken public contract, a race condition on a path this range
  touches, or a test that now passes for the wrong reason (weakened
  assertion, mocked-away behavior, a skip).
- **medium** — a plausible bug on an edge path (empty input, error branch,
  concurrent access), a contract change without every caller updated, an
  off-by-one or boundary condition that isn't obviously exercised by a test.
- **low** — everything else worth a reviewer's attention: a confusing name
  that invites a future bug, a TODO with no ticket, dead code the range
  adds.

Verify every claim against the file on disk — read whole files and their
callers, never judge a hunk in isolation. An empty `findings` array means
you found nothing at this severity or above worth blocking on.
