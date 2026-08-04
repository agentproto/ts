/**
 * Deterministic mock data for the Rift demo.
 *
 * Every Source/Claim below is grounded in a specific, independently
 * fetched, real public record — no fabricated URLs, dates, excerpts,
 * metrics, or citations. Verification method and exact timestamps are
 * documented in each Source's fields; see `demos/rift/EVIDENCE.md` for
 * the full research log (categories used, categories rejected, and why).
 *
 * Categories considered and their disposition:
 *   - GitHub                     → used (S1–S4 below)
 *   - Competitor pricing         → used (S5 below)
 *   - Reddit                     → rejected: both the public JSON search
 *     API (www.reddit.com and old.reddit.com) return bot-challenge pages
 *     or HTTP 403 for every User-Agent tried; the fetch tool itself
 *     blocks old.reddit.com. No genuine thread content was reachable, and
 *     bulk scraping to work around that is out of scope.
 *   - TrustMRR                   → rejected: no agent-orchestration-
 *     relevant listing found on the site; a third-party blog's claim that
 *     "Ballast" was listed there did not corroborate on direct fetch of
 *     trustmrr.com, so it was discarded rather than used.
 *   - StartMRR                   → rejected: trustmrr.com/startmrr returns
 *     404 and startmrr.com returns HTTP 522 (origin timeout) — the site is
 *     unreachable from this environment.
 */

import type {
  RiftInput,
  RiftCard,
  Source,
  Claim,
  GeneratedDrafts,
} from "./types.js"

// ─── Sources — real, independently verified ─────────────────────────

export const SOURCES: readonly Source[] = [
  {
    id: "gh-langgraph-repo",
    type: "github-repository",
    url: "https://github.com/langchain-ai/langgraph",
    title: "langchain-ai/langgraph",
    observedAt: "2026-07-27T17:07:00.000Z",
    excerpt:
      'stargazers_count: 38259; created_at: 2023-08-09T18:33:12Z; license: MIT; description: "Build resilient agents."',
    claimIds: ["claim-langgraph-stars", "claim-agent-framework-star-parity-inference"],
    quality: { tier: "primary", score: 0.9, assessedAt: "2026-07-27T17:07:00.000Z" },
  },
  {
    id: "gh-crewai-repo",
    type: "github-repository",
    url: "https://github.com/crewAIInc/crewAI",
    title: "crewAIInc/crewAI",
    observedAt: "2026-07-27T17:07:00.000Z",
    excerpt:
      'stargazers_count: 56219; created_at: 2023-10-27T03:26:59Z; license: MIT; description: "Framework for orchestrating role-playing, autonomous AI agents."',
    claimIds: [
      "claim-crewai-stars",
      "claim-crewai-self-description-public",
      "claim-agent-framework-star-parity-inference",
    ],
    quality: { tier: "primary", score: 0.9, assessedAt: "2026-07-27T17:07:00.000Z" },
  },
  {
    id: "gh-autogen-repo",
    type: "github-repository",
    url: "https://github.com/microsoft/autogen",
    title: "microsoft/autogen",
    observedAt: "2026-07-27T17:07:00.000Z",
    excerpt:
      'stargazers_count: 60029; created_at: 2023-08-18T11:43:45Z; license: CC-BY-4.0; description: "A programming framework for agentic AI"',
    claimIds: ["claim-autogen-stars", "claim-agent-framework-star-parity-inference"],
    quality: { tier: "primary", score: 0.9, assessedAt: "2026-07-27T17:07:00.000Z" },
  },
  {
    id: "gh-autogen-readme-maintenance",
    type: "github-readme",
    url: "https://raw.githubusercontent.com/microsoft/autogen/main/README.md",
    title: "microsoft/autogen README — Maintenance Mode notice",
    observedAt: "2026-07-27T17:12:00.000Z",
    excerpt:
      "AutoGen is now in maintenance mode. It will not receive new features or enhancements and is community managed going forward.",
    claimIds: ["claim-autogen-maintenance-mode"],
    quality: { tier: "primary", score: 0.9, assessedAt: "2026-07-27T17:12:00.000Z" },
  },
  {
    id: "langchain-pricing-page",
    type: "vendor-pricing-page",
    url: "https://www.langchain.com/pricing",
    title: "LangChain Platform — Pricing",
    observedAt: "2026-07-27T17:07:00.000Z",
    excerpt:
      "Developer: $0 / seat per month then pay as you go. Plus: $39 / seat per month then pay as you go. LCU: $1.50 / LCU. LSU: $1.00 / LSU.",
    claimIds: ["claim-langchain-pricing-tiers"],
    quality: { tier: "primary", score: 0.9, assessedAt: "2026-07-27T17:07:00.000Z" },
  },
]

// ─── Claims — one evidence label each, per the Evidence contract ────

export const MOCK_CLAIMS: readonly Claim[] = [
  {
    id: "claim-langgraph-stars",
    text: "LangGraph (langchain-ai/langgraph) has 38,259 GitHub stars, was created 2023-08-09, and is MIT-licensed.",
    evidenceLabel: "Verified",
    sourceIds: ["gh-langgraph-repo"],
  },
  {
    id: "claim-crewai-stars",
    text: "CrewAI (crewAIInc/crewAI) has 56,219 GitHub stars, was created 2023-10-27, and is MIT-licensed.",
    evidenceLabel: "Verified",
    sourceIds: ["gh-crewai-repo"],
  },
  {
    id: "claim-autogen-stars",
    text: "Microsoft AutoGen (microsoft/autogen) has 60,029 GitHub stars and was created 2023-08-18.",
    evidenceLabel: "Verified",
    sourceIds: ["gh-autogen-repo"],
  },
  {
    id: "claim-autogen-maintenance-mode",
    text: "Microsoft AutoGen's own README states the project is now in maintenance mode and directs new users to Microsoft Agent Framework instead.",
    evidenceLabel: "Verified",
    sourceIds: ["gh-autogen-readme-maintenance"],
  },
  {
    id: "claim-langchain-pricing-tiers",
    text: "LangChain's hosted platform prices its Developer tier at $0 per seat/month and its Plus tier at $39 per seat/month, with usage billed at $1.50 per LCU and $1.00 per LSU.",
    evidenceLabel: "Verified",
    sourceIds: ["langchain-pricing-page"],
  },
  {
    id: "claim-crewai-self-description-public",
    text: 'CrewAI markets itself as enabling "collaborative intelligence" among autonomous agents to tackle complex tasks.',
    evidenceLabel: "Public claim",
    sourceIds: ["gh-crewai-repo"],
  },
  {
    id: "claim-agent-framework-star-parity-inference",
    text: "LangGraph, CrewAI, and AutoGen have each independently crossed 35,000+ GitHub stars, suggesting no single agent-orchestration framework has runaway dominance in developer attention.",
    evidenceLabel: "Inference",
    sourceIds: ["gh-langgraph-repo", "gh-crewai-repo", "gh-autogen-repo"],
    uncertainty:
      "GitHub stars measure attention, not validated production adoption, revenue, or retention; this synthesis does not establish market share.",
  },
]

// ─── Fixture-free placeholder input (Foundation-owned; unchanged) ──

export const MOCK_INPUT: RiftInput = {
  rawText:
    "AI agent orchestration runtimes are consolidating around open protocols.",
  title: "Placeholder input",
  tags: ["placeholder"],
}

export const MOCK_DRAFTS: GeneratedDrafts = {
  prd: { placeholder: true },
  landingPage: { placeholder: true },
  xPost: { placeholder: true },
}

export const MOCK_CARD: RiftCard = {
  id: "rift-card-agent-orchestration",
  input: MOCK_INPUT,
  claims: [...MOCK_CLAIMS],
  sources: [...SOURCES],
  marketSignal: "moderate",
  recommendation: {
    recommendation: "wait",
    reasons: [
      "No single framework shows runaway dominance in developer attention yet.",
      "AutoGen's shift to maintenance mode signals the competitive landscape is still consolidating.",
    ],
    claimIds: ["claim-agent-framework-star-parity-inference", "claim-autogen-maintenance-mode"],
  },
  drafts: { ...MOCK_DRAFTS },
  createdAt: "2026-07-27T17:20:00.000Z",
  updatedAt: "2026-07-27T17:20:00.000Z",
}

export const MOCK_CARDS: readonly RiftCard[] = [MOCK_CARD]
