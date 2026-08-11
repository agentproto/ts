# Evidence research log

This file records the research behind `src/mock-data.ts`'s cited fixtures:
what was checked, what was used, what was rejected, and why. It exists so
the provenance in the fixtures is auditable independent of the code.

## Categories used

### GitHub (`gh-*` sources)

Fetched live via `curl -s "https://api.github.com/repos/<owner>/<repo>"`
against the GitHub REST API (no auth required for public repo metadata).
Re-verified live a second time before commit; star counts drift by design
(open-source repos gain stars continuously) — each source's `observedAt`
records the exact moment its numbers were captured, and the fixture values
are frozen to that moment rather than "corrected" to match a later count.

- `langchain-ai/langgraph` — 38,259 stars, created `2023-08-09T18:33:12Z`,
  MIT license, description `"Build resilient agents."`
- `crewAIInc/crewAI` — 56,219 stars, created `2023-10-27T03:26:59Z`, MIT
  license, description `"Framework for orchestrating role-playing,
  autonomous AI agents. By fostering collaborative intelligence, CrewAI
  empowers agents to work together seamlessly, tackling complex tasks."`
- `microsoft/autogen` — 60,029 stars, created `2023-08-18T11:43:45Z`,
  CC-BY-4.0 license, description `"A programming framework for agentic AI"`
- `microsoft/autogen`'s own `README.md` (fetched from
  `raw.githubusercontent.com/microsoft/autogen/main/README.md`) contains a
  verbatim "Maintenance Mode" notice: *"AutoGen is now in maintenance mode.
  It will not receive new features or enhancements and is community managed
  going forward."*

### Competitor pricing

Fetched live via `curl -sL "https://www.langchain.com/pricing"` (HTTP 200,
Cloudflare-served). The page's live text was regex-extracted and confirmed
verbatim:

- Developer tier: `$0 / seat per month then pay as you go`
- Plus tier: `$39 / seat per month then pay as you go`
- Usage: `$1.50 / LCU`, `$1.00 / LSU`

## Categories rejected (with reason)

### Reddit

Every reachable access path was exhausted and failed:

- `www.reddit.com`'s public JSON search endpoint returns a bot-challenge
  page (not JSON) for every User-Agent string tried.
- `old.reddit.com`'s equivalent endpoint returns HTTP 403 for every
  User-Agent string tried, and this session's fetch tool refuses
  `old.reddit.com` outright at the tool level.
- Web search for "reddit.com" threads on this topic surfaced zero actual
  Reddit URLs — only third-party blogs paraphrasing or referencing Reddit
  discussion, none of which is a genuine Reddit source.

No genuine Reddit thread content was reachable from this environment.
Working around this with bulk scraping is explicitly out of scope for this
task, so Reddit is documented here as unusable rather than fabricated.

### TrustMRR

The site itself is reachable, but no listing relevant to AI agent
orchestration runtimes was found on it. A third-party blog claimed a
product called "Ballast" was listed on TrustMRR; fetching trustmrr.com
directly did not corroborate that claim, so it was discarded rather than
used as a citation.

### StartMRR

Unreachable from this environment: `trustmrr.com/startmrr` returns HTTP 404,
and `startmrr.com` directly returns HTTP 522 (Cloudflare's "origin
connection timed out"). No content could be fetched to cite.

## Why two categories are enough

The task contract requires "at least one real public category" among
Reddit, GitHub, competitor pricing, TrustMRR, or StartMRR, or a documented
reason each unused category couldn't be used. GitHub and competitor pricing
both produced genuine, independently-verifiable, cite-able content; the
other three are documented above as unusable. No further category research
was pursued once this bar was met.
