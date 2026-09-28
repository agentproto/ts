# Security rubric

Review the committed range for vulnerabilities it INTRODUCES — OWASP-class
issues, not a general code-quality pass. Pre-existing exposure the range
doesn't touch is out of scope.

- **high** — an exploitable vulnerability an attacker could act on today:
  injection (SQL, command, template, path traversal), an auth/permission
  check removed or weakened, a secret or credential committed or logged, an
  SSRF-capable request built from untrusted input, deserialization of
  untrusted data, a broken access-control boundary (IDOR, missing
  authorization on a new endpoint).
- **medium** — a real weakness that needs a specific precondition to exploit:
  missing input validation on a field that reaches a sensitive sink later,
  an overly broad CORS/allowlist change, a timing side-channel, insufficient
  rate limiting on a sensitive action, a dependency added with a known
  advisory.
- **low** — hardening opportunities: a missing security header, verbose
  error output that leaks internals, a secret handled correctly but not via
  the repo's usual secrets path.

Trace untrusted input to where it's used — a finding needs a concrete sink,
not "user input exists somewhere nearby." When a check only reads code
without executing it, say so in the finding rather than asserting an
exploit you didn't verify.
