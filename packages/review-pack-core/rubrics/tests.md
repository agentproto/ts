# Test-coverage rubric

Review the committed range for a behavior change that ships WITHOUT a test
that would catch its regression. This is not "does every line have a test"
— it's "if someone reverted this behavior tomorrow, would CI notice?"

- **high** — a new behavior, a bug fix, or a changed contract with no test
  anywhere in the range that would fail if the change were reverted; or an
  existing test edited to match the new (possibly wrong) behavior without a
  case for the specific defect that motivated the change.
- **medium** — coverage exists but is shallow: only the happy path is
  tested and the range clearly introduces an edge case (empty/null input, an
  error branch, a boundary value) with no case for it; a test that exercises
  the change only incidentally, as a side effect of asserting something
  else.
- **low** — a missing test for something low-risk (a pure refactor with
  unchanged behavior, a log message, a comment-only change flagged for
  visibility) — worth noting, not blocking.

A pure refactor (no behavior change) or a docs/config-only change needs no
new test — say so explicitly rather than leaving it unaddressed. When you
can't tell whether a change alters behavior without running the tests, run
them.
