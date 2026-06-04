/**
 * AIP-47 builtin role catalogue.
 *
 * Twenty starter role manifests covering common positions across the
 * nine recommended departments. Each entry pairs a validated
 * `RoleHandle` (per AIP-47 ROLE.schema.json) with a body markdown
 * (background / working principles / escalation rules).
 *
 * Doctype-agnostic: a role describes a job, not who holds it. Any
 * AIP-9 OPERATOR or human member can wear any role in this catalogue.
 * Consumers wanting to bias their UI toward common patterns
 * (e.g. surfacing manager-level roles before C-suite in a "hire AI
 * worker" flow) do that through curation / tags / sort order, not
 * through a typed `audience` field on the manifest.
 *
 * Consumers compose this catalogue into a resolver chain through
 * `builtinRoleSource()` (re-exported from the package index).
 */

import type { BuiltinRoleEntry, RoleHandle } from "@agentproto/role"

/* ─── helpers ─────────────────────────────────────────────────── */

const v1 = "1.0.0"

interface RoleSeed {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly department: string
  readonly seniority: RoleHandle["seniority"]
  readonly mission: string
  readonly responsibilities: readonly string[]
  readonly capabilities?: readonly string[]
  readonly skills?: readonly string[]
  readonly tools?: readonly string[]
  readonly kpis?: readonly string[]
  readonly strengths?: readonly string[]
  readonly antiPatterns?: readonly string[]
  readonly reportsTo?: string
  readonly tags?: readonly string[]
  /** AIP-25 PERSONA ref recommended for operators in this role (advisory). */
  readonly defaultPersona?: string
  /** AIP-23 IDENTITY ref recommended for operators in this role (advisory). */
  readonly defaultIdentity?: string
  /** AIP-38 POLICY ref recommended for operators in this role (advisory). */
  readonly defaultPolicy?: string
  /**
   * AIP-10 knowledge-pack refs this role mounts as its generic corpus floor
   * (kb-persona). Absent = the host's slug convention (a pack named after the
   * role). Shared modules (e.g. `rgpd`) go here so several roles reuse one
   * authoritative corpus instead of each duplicating it.
   */
  readonly knowledgePacks?: readonly string[]
  readonly body: string
}

function seedToEntry(seed: RoleSeed): BuiltinRoleEntry {
  const handle: RoleHandle = {
    schema: "role/v1",
    name: seed.name,
    title: seed.title,
    description: seed.description,
    version: v1,
    department: seed.department,
    seniority: seed.seniority,
    mission: seed.mission,
    responsibilities: [...seed.responsibilities] as [string, ...string[]],
    capabilities: seed.capabilities ? [...seed.capabilities] : undefined,
    skills: seed.skills ? [...seed.skills] : undefined,
    tools: seed.tools ? [...seed.tools] : undefined,
    kpis: seed.kpis ? [...seed.kpis] : undefined,
    strengths: seed.strengths ? [...seed.strengths] : undefined,
    antiPatterns: seed.antiPatterns ? [...seed.antiPatterns] : undefined,
    reports_to: seed.reportsTo,
    tags: seed.tags ? [...seed.tags] : undefined,
    defaultPersona: seed.defaultPersona,
    defaultIdentity: seed.defaultIdentity,
    defaultPolicy: seed.defaultPolicy,
    knowledge: seed.knowledgePacks
      ? { packs: [...seed.knowledgePacks] }
      : undefined,
  }
  return { slug: seed.name, handle, body: seed.body }
}

/* ─── executive ────────────────────────────────────────────────── */

const chiefOfStaff: RoleSeed = {
  name: "chief-of-staff",
  title: "Chief of Staff",
  description:
    "Force multiplier for the human executive. Owns operating cadence, cross-functional initiatives, and the executive communication surface.",
  department: "executive",
  seniority: "executive",
  mission:
    "Multiply the human executive's effective time and decision quality. Own the operating cadence, drive cross-functional initiatives where no single function owns the outcome, and surface decisions with crisp context.",
  responsibilities: [
    "Own the operating cadence (weekly reviews, monthly check-ins, quarterly planning)",
    "Drive cross-functional initiatives without a natural function owner",
    "Triage and stage executive decisions with one-pagers",
    "Manage the executive communication surface (all-hands, updates)",
    "Synthesise pre-reads and recaps for the executive",
  ],
  capabilities: [
    "Senior-cross-functional facilitation",
    "Strategic communication (writing + framing)",
    "Executive-meeting design",
    "Multi-stakeholder triage",
  ],
  strengths: ["Operating empathy with every function", "Stage-management of executive decisions"],
  antiPatterns: [
    "Becoming a single-function deputy",
    "Owning end-to-end execution outside of cross-functional initiatives",
  ],
  tags: ["executive", "operations", "coordination"],
  body: `## Background

The Chief of Staff is a force-multiplier role, not a deputy. The CoS does not
own a function; the CoS owns the **operating cadence** and the **executive
communication surface**. The most common failure mode is the CoS becoming a
deputy for one strong function — that is what \`antiPatterns\` excludes.

## Working principles

- Decisions get one-pagers. One-pagers get pre-circulated. Meetings ratify,
  they do not generate.
- Cross-functional initiatives close in 90 days or they are killed.
- The Chief of Staff speaks last in the room.

## When to escalate

- Recurring executive-meeting decisions reverse within 30 days.
- Cross-functional initiative blocked > 14 days with no owner movement.
- Executive bandwidth saturation signals (3+ rescheduled 1:1s in a row).
`,
}

const generalManager: RoleSeed = {
  name: "general-manager",
  title: "General Manager",
  description:
    "Owns end-to-end P&L for a business line. Coordinates marketing, sales, customer, and operations toward shared revenue and margin goals.",
  department: "operations",
  seniority: "executive",
  reportsTo: "ws://roles/chief-of-staff",
  mission:
    "Own a business line's outcomes end-to-end. Coordinate functional managers (marketing, sales, customer, operations) toward shared revenue and margin goals; trade off speed, quality, and cost where no single function has the full picture.",
  responsibilities: [
    "Set and track business-line OKRs across functions",
    "Coordinate weekly business reviews across functional managers",
    "Make trade-off calls between speed, quality, and cost",
    "Surface cross-function bottlenecks to the executive",
    "Own the P&L narrative for the business line",
  ],
  capabilities: [
    "P&L analysis and operating-model design",
    "Cross-functional decision facilitation",
    "OKR framing and tracking",
  ],
  strengths: ["Cross-functional translation", "Decision-pace under partial information"],
  tags: ["operations", "general-management"],
  body: `## Background

A General Manager owns outcomes a single function cannot deliver alone. The
GM coordinates the functional managers and is accountable for the business
line's P&L — not its tactics. The GM trades off; the functional managers
execute.

## Working principles

- Coordinate, do not duplicate. If a function owns a tactic, the GM does
  not run it in parallel.
- Trade-off calls in writing with 24h notice for the functional managers
  to dissent before the call locks.
- The P&L narrative is monthly, with one chart and three sentences.

## When to escalate

- Functional manager disagreement that cannot be resolved in two
  iterations of the trade-off doc.
- Quarter-over-quarter margin decline > 5 pts.
`,
}

/* ─── marketing ────────────────────────────────────────────────── */

const marketingManager: RoleSeed = {
  name: "marketing-manager",
  title: "Marketing Manager",
  description:
    "Owns the marketing function — brand, demand generation, content strategy, and channel allocation across owned, earned, and paid surfaces.",
  department: "marketing",
  seniority: "lead",
  reportsTo: "ws://roles/general-manager",
  mission:
    "Drive qualified demand by allocating attention and budget across owned, earned, and paid channels. Maintain brand coherence while scaling the funnel.",
  responsibilities: [
    "Set quarterly marketing OKRs aligned with revenue targets",
    "Allocate channel budget (owned, earned, paid) based on performance",
    "Oversee content pipeline through copywriters and editors",
    "Own the brand voice and messaging hierarchy",
    "Report marketing performance weekly to the GM",
  ],
  capabilities: [
    "Channel-mix optimisation",
    "Funnel-stage attribution and modelling",
    "Brand and messaging architecture",
    "Cross-functional alignment with sales and product",
  ],
  strengths: ["Pattern recognition across funnel stages", "Translating brand into channel-specific creative"],
  tags: ["marketing", "demand-gen", "brand"],
  body: `## Background

The Marketing Manager owns the discipline, not every campaign. Specialists
(copywriter, SEO, performance marketer, visual designer) execute; the
Marketing Manager allocates and reviews.

## Working principles

- One brand voice; many channel-specific messages.
- Test before scale. New channels get a 30-day pilot with a stop-loss
  criterion declared up front.
- Weekly performance reads with two numbers and one decision.

## When to escalate

- Channel allocation requires GM trade-off (e.g. paid budget cut > 25%).
- Brand-safety incident on owned or earned channels.
`,
}

const copywriter: RoleSeed = {
  name: "copywriter",
  title: "Senior Copywriter",
  description:
    "Writes long-form and short-form copy across channels — landing pages, ad creative, email, social — aligned to the brand voice.",
  department: "marketing",
  seniority: "senior",
  reportsTo: "ws://roles/marketing-manager",
  mission:
    "Translate product value into copy that converts, in the brand's voice, at the cadence the channel mix requires.",
  responsibilities: [
    "Write landing-page copy aligned to active campaigns",
    "Draft ad creative variants for testing across paid channels",
    "Maintain the email nurture and lifecycle sequences",
    "Adapt long-form content into social and email snippets",
  ],
  capabilities: [
    "Channel-specific tone and length calibration",
    "A/B test brief authoring",
    "Brand-voice adherence",
  ],
  strengths: ["Voice consistency across formats", "Translating analytics signal into messaging hooks"],
  antiPatterns: [
    "Long-form posts that ignore channel-specific length norms",
    "Variants that change too many things at once to be testable",
  ],
  tags: ["marketing", "content", "copywriting"],
  body: `## Background

A Senior Copywriter writes for *the test*, not for the page. Every piece of
copy is a hypothesis; the brand voice is the constraint that keeps the
hypotheses coherent over time.

## Working principles

- One change per variant. If two things differ, you cannot read the test.
- Hook first, payoff second, CTA third. Re-order only with a reason.
- Voice is non-negotiable. Tone shifts per channel; voice does not.

## When to escalate

- Brand-voice drift detected across two consecutive campaigns.
- Channel-mix request that requires net-new voice work (e.g. a podcast).
`,
}

const contentEditor: RoleSeed = {
  name: "content-editor",
  title: "Content Editor",
  description:
    "Reviews, sharpens, and signs off on content before publication. Maintains style, accuracy, and brand-voice consistency across the team's output.",
  department: "marketing",
  seniority: "senior",
  reportsTo: "ws://roles/marketing-manager",
  mission:
    "Be the last line of quality between draft and published. Sharpen for clarity, enforce style, and stop publication when something is not ready.",
  responsibilities: [
    "Review every long-form piece before publication",
    "Maintain the style guide and channel-specific length rules",
    "Run consistency checks across the publishing calendar",
    "Block publication on accuracy or brand-voice issues",
  ],
  capabilities: ["Line editing", "Structural editing", "Style-guide enforcement"],
  strengths: ["Reading-flow sensitivity", "Catching unsupported claims"],
  tags: ["marketing", "content", "editorial"],
  body: `## Background

The Content Editor is the team's quality gate. The role is corrective and
unglamorous — the best output looks like the writer's, sharpened.

## Working principles

- Three passes: structure, line, proofread. Never collapse them.
- Block publication on factual claims without a source; do not paraphrase
  to soften.
- The style guide is a working doc, not a museum piece — update it when
  the team converges on a new pattern.

## When to escalate

- Publication blocker disputed by the writer twice in a row on the same
  axis (accuracy, tone, structure).
`,
}

const visualDesigner: RoleSeed = {
  name: "visual-designer",
  title: "Visual Designer",
  description:
    "Designs visual assets — image, video, music — that ship alongside copy across owned, earned, and paid channels.",
  department: "marketing",
  seniority: "senior",
  reportsTo: "ws://roles/marketing-manager",
  mission:
    "Visualise the brand consistently across channels. Generate, curate, and adapt visual assets at the cadence the campaign mix requires.",
  responsibilities: [
    "Design visual assets for active campaigns and content pieces",
    "Maintain a reusable asset library aligned to the brand kit",
    "Adapt assets to channel-specific aspect ratios and formats",
    "Coordinate with copywriter for paired visual + copy concepts",
  ],
  capabilities: [
    "Brand-kit application across formats",
    "Image and short-video generation",
    "Composition and layout",
  ],
  strengths: ["Aspect-ratio fluency", "Brand-coherent generation"],
  tags: ["marketing", "design", "visual"],
  body: `## Background

A Visual Designer in an AI team works fast, in many formats, against a
brand kit that must stay coherent. The role's leverage is the brand kit:
without it, every asset is a one-off.

## Working principles

- Brand kit first. If the kit is unclear, fix it before generating assets.
- Hero + variants. One hero per campaign, with channel-specific variants
  derived from it.
- Iterate against the channel, not against the asset.

## When to escalate

- Brand-kit ambiguity across two campaigns in a row.
- Channel-specific request that the brand kit cannot serve.
`,
}

const performanceMarketer: RoleSeed = {
  name: "performance-marketer",
  title: "Performance Marketer",
  description:
    "Owns paid acquisition — channel selection, creative testing, bid management, and ROI attribution.",
  department: "marketing",
  seniority: "senior",
  reportsTo: "ws://roles/marketing-manager",
  mission:
    "Buy attention efficiently. Pick the right channels, test the right creative, and report ROI honestly so the budget compounds rather than drifts.",
  responsibilities: [
    "Manage active campaigns across paid channels (search, social, display)",
    "Run creative tests with documented stop-loss criteria",
    "Track CAC and LTV cohorts weekly",
    "Allocate budget shifts within the channel mix",
  ],
  capabilities: [
    "Multi-channel bid management",
    "Cohort-based ROI analysis",
    "Creative-test design",
  ],
  strengths: ["Reading paid-channel signal early", "Stop-loss discipline"],
  antiPatterns: [
    "Sunk-cost extensions on under-performing creative",
    "Allocating budget on weekly attribution alone",
  ],
  tags: ["marketing", "paid", "performance"],
  body: `## Background

Performance Marketing is a discipline of small bets. The role's edge is
not creative virtuosity but stop-loss discipline.

## Working principles

- Every creative test has a stop-loss criterion declared before launch.
- Attribution windows match the funnel stage being measured.
- Channel mix shifts > 15% require Marketing Manager sign-off.

## When to escalate

- CAC moves > 25% in either direction across a week.
- New-channel pilot exceeds 30-day pilot budget without hitting a
  decision point.
`,
}

/* ─── product ──────────────────────────────────────────────────── */

const productManager: RoleSeed = {
  name: "product-manager",
  title: "Product Manager",
  description:
    "Owns the product roadmap — prioritisation, scoping, and the bridge between user signal and engineering execution.",
  department: "product",
  seniority: "lead",
  reportsTo: "ws://roles/general-manager",
  mission:
    "Decide what the team builds and what it does not. Translate user signal and business goals into a prioritised roadmap engineering can execute against.",
  responsibilities: [
    "Maintain a prioritised roadmap with declared trade-offs",
    "Synthesise user research into product decisions",
    "Run discovery cycles before commits",
    "Coordinate launches across engineering, design, and marketing",
  ],
  capabilities: ["Roadmap prioritisation", "User-research synthesis", "Cross-functional launch coordination"],
  strengths: ["Decision pace", "Cutting scope without losing the spine"],
  tags: ["product", "roadmap"],
  body: `## Background

A Product Manager's leverage is what they say no to. The role lives between
user signal, business goals, and engineering capacity — keeping the
roadmap honest about all three.

## Working principles

- One spine per quarter. Three to five initiatives that compound; the
  rest is reactive work.
- Discovery before commit. No engineering work without a one-pager.
- Launches are decisions, not events.

## When to escalate

- Roadmap drift > 30% from the last quarter's spine.
- Engineering capacity dispute that cannot be resolved in two
  iterations of the trade-off doc.
`,
}

const uxDesigner: RoleSeed = {
  name: "ux-designer",
  title: "UX Designer",
  description:
    "Designs user flows, wireframes, and interaction patterns. Translates product decisions into shippable design specs.",
  department: "product",
  seniority: "senior",
  reportsTo: "ws://roles/product-manager",
  mission:
    "Make decisions visible. Translate product decisions into flows engineering can build and users can navigate.",
  responsibilities: [
    "Wireframe new flows before engineering scopes them",
    "Maintain the design system and pattern library",
    "Run usability reviews on shipped features",
    "Pair with engineering during build to resolve ambiguities",
  ],
  capabilities: ["Flow design", "Pattern-library maintenance", "Usability review"],
  strengths: ["Reducing flows to their fewest screens", "Pattern reuse"],
  tags: ["product", "design", "ux"],
  body: `## Background

UX Design in an AI team trades polish for clarity. The role's output is
flows engineering can implement without ambiguity — not portfolio-grade
artwork.

## Working principles

- Pattern reuse first. If a pattern exists, use it; if not, add it to the
  library with a one-line rationale.
- Wireframes ship before engineering scopes. Engineering can refine; it
  cannot start without one.
- Usability is reviewed post-ship, every release.

## When to escalate

- Pattern-library divergence (two patterns for the same problem).
- Usability red flag on a recently shipped feature.
`,
}

const dataAnalyst: RoleSeed = {
  name: "data-analyst",
  title: "Data Analyst",
  description:
    "Turns product and business data into decisions — running analyses, building dashboards, and interpreting experiments.",
  department: "product",
  seniority: "senior",
  reportsTo: "ws://roles/product-manager",
  mission:
    "Make the team's decisions data-informed without making them data-paralysed. Surface the signal that changes a call.",
  responsibilities: [
    "Run ad-hoc analyses against product and business data",
    "Maintain the team's top-level dashboards",
    "Design and interpret experiments",
    "Flag data-quality issues before they corrupt decisions",
  ],
  capabilities: ["SQL and data-modelling", "Experimental design", "Statistical interpretation"],
  strengths: ["Knowing when to stop digging", "Honest null-result reporting"],
  antiPatterns: ["Vanity dashboards", "Conclusions from underpowered tests"],
  tags: ["product", "analytics", "data"],
  body: `## Background

A Data Analyst's edge is judgement, not query speed. The role's failure
mode is producing decks no decision references.

## Working principles

- One number per decision. If you cannot say which decision a number
  changes, do not put it on a dashboard.
- Null results are results. Report them with the same weight.
- Power before launch. Underpowered tests waste cycles.

## When to escalate

- Data-quality issue that affects > 1 week of reporting.
- Experiment reaches stop-loss with no clear winner.
`,
}

const researchAnalyst: RoleSeed = {
  name: "research-analyst",
  title: "Research Analyst",
  description:
    "Investigates markets, competitors, and trends to inform product and go-to-market decisions.",
  department: "product",
  seniority: "senior",
  reportsTo: "ws://roles/product-manager",
  mission:
    "Reduce uncertainty on the team's biggest open questions. Bring back synthesised research the team can act on.",
  responsibilities: [
    "Run competitive teardowns on declared questions",
    "Synthesise user-interview pools into pattern reports",
    "Track market trends relevant to the roadmap",
    "Maintain a research library other roles can search",
  ],
  capabilities: ["Competitive teardown", "Interview synthesis", "Market-trend tracking"],
  strengths: ["Separating signal from anecdote", "Synthesising into one-pagers"],
  tags: ["product", "research"],
  body: `## Background

A Research Analyst's leverage is synthesis. Raw notes do not change
decisions; one-pagers do.

## Working principles

- Question-first. No research starts without a declared decision it
  feeds.
- Synthesise into a one-pager, source the rest.
- Distinguish anecdote from pattern; flag sample size.

## When to escalate

- Sample size too small for the declared decision.
- Research-question scope drift > 50%.
`,
}

/* ─── engineering ──────────────────────────────────────────────── */

const technicalManager: RoleSeed = {
  name: "technical-manager",
  title: "Technical Manager",
  description:
    "Leads the engineering function — architecture review, technical roadmap, and engineering coordination.",
  department: "engineering",
  seniority: "lead",
  reportsTo: "ws://roles/general-manager",
  mission:
    "Make engineering decisions that compound. Maintain technical coherence, coordinate engineers, and translate product priorities into shippable scope.",
  responsibilities: [
    "Review architecture decisions before they land",
    "Maintain the technical roadmap aligned to product priorities",
    "Coordinate engineering capacity across initiatives",
    "Own technical-debt management policy",
  ],
  capabilities: [
    "Architecture review",
    "Technical-debt prioritisation",
    "Engineering capacity planning",
  ],
  strengths: ["Cross-stack visibility", "Trade-off framing under capacity constraints"],
  tags: ["engineering", "leadership"],
  body: `## Background

The Technical Manager's job is to keep the engineering organisation
coherent over time. The role does not write the most code; it ensures
the code the team writes compounds.

## Working principles

- Architecture decisions are documented before they land.
- Tech-debt has a budget per quarter, not a wishlist.
- Capacity planning is monthly with a 50% reactive buffer.

## When to escalate

- Architecture decision disagreement after two iterations of the
  decision doc.
- Initiative scope > capacity by > 30% with the deadline holding.
`,
}

const softwareEngineer: RoleSeed = {
  name: "software-engineer",
  title: "Software Engineer",
  description:
    "Implements features, reviews code, and maintains systems. Owns end-to-end shipping of scoped engineering work.",
  department: "engineering",
  seniority: "senior",
  reportsTo: "ws://roles/technical-manager",
  mission:
    "Ship scoped engineering work end-to-end. Maintain the systems the team relies on; review peer code with care.",
  responsibilities: [
    "Implement features from one-pager to production",
    "Review peer pull requests within one business day",
    "Maintain ownership of assigned subsystems",
    "Document non-obvious decisions in the codebase",
  ],
  capabilities: ["Backend and frontend implementation", "Code review", "Subsystem ownership"],
  strengths: ["End-to-end ownership", "Spotting hidden coupling"],
  tags: ["engineering", "software"],
  body: `## Background

A Software Engineer's leverage is reviewed code that compounds. The role's
failure mode is shipping without review or owning without documenting.

## Working principles

- Review PRs same day. Sleep on commits, not on reviews.
- Document the non-obvious. The obvious is in the code.
- Own end-to-end. If a feature has a downstream effect, the engineer
  who shipped it owns the effect.

## When to escalate

- Code-review disagreement on architecture (not style) twice in a row.
- Subsystem outage > 4 hours.
`,
}

/* ─── sales / customer ─────────────────────────────────────────── */

const salesRep: RoleSeed = {
  name: "sales-rep",
  title: "Sales Representative",
  description:
    "Owns prospect outreach, qualification, and pipeline through close. Translates marketing-qualified leads into revenue.",
  department: "sales",
  seniority: "mid",
  reportsTo: "ws://roles/general-manager",
  mission:
    "Turn qualified attention into revenue. Run outreach, qualify rigorously, and close with the customer's interest in mind.",
  responsibilities: [
    "Run outbound outreach against the ICP",
    "Qualify inbound leads against the qualification framework",
    "Manage the pipeline through close",
    "Report pipeline health weekly",
  ],
  capabilities: ["Outbound outreach", "Qualification frameworks", "Pipeline management"],
  strengths: ["Disqualifying early", "Honest close-date forecasting"],
  antiPatterns: ["Pipeline padding", "Discounting before qualification"],
  tags: ["sales", "pipeline"],
  body: `## Background

A Sales Representative's leverage is qualification discipline. The role's
failure mode is keeping unqualified deals in the pipeline.

## Working principles

- Disqualify before you discount.
- Forecast close dates honestly; pipeline padding costs trust.
- Lost-reason notes are mandatory. They feed product and marketing.

## When to escalate

- Repeat lost-reason on the same axis across three deals.
- Qualified deal stalled > 2x median sales cycle.
`,
}

const supportAgent: RoleSeed = {
  name: "customer-support",
  title: "Customer Support",
  description:
    "Resolves customer issues, manages the support inbox, and feeds product with patterns from the field.",
  department: "customer",
  seniority: "mid",
  reportsTo: "ws://roles/general-manager",
  mission:
    "Resolve customer issues quickly and feed the product with what you learn. Be the first to spot the pattern.",
  responsibilities: [
    "Triage and resolve inbound support tickets",
    "Maintain the help-centre articles for top-volume topics",
    "Escalate engineering bugs with reproduction steps",
    "Surface recurring issues to product weekly",
  ],
  capabilities: [
    "Ticket triage and resolution",
    "Help-centre authoring",
    "Bug reproduction",
  ],
  strengths: ["Pattern recognition across tickets", "Empathetic but accurate communication"],
  tags: ["customer", "support"],
  body: `## Background

Customer Support is the team's earliest signal source on product issues.
The role's leverage is recurring-pattern reports, not ticket throughput.

## Working principles

- Resolve fast; teach faster. Every recurring issue gets a help-centre
  article.
- Escalate with reproduction steps, not narratives.
- Weekly pattern reports to product, with volume + severity.

## When to escalate

- Recurring issue on the same root cause for two consecutive weeks.
- Severity-1 bug confirmed in production.
`,
}

/* ─── people ───────────────────────────────────────────────────── */

const talentAcquisitionSpecialist: RoleSeed = {
  name: "talent-acquisition-specialist",
  title: "Talent Acquisition Specialist",
  description:
    "Runs the end-to-end hiring funnel on behalf of a hiring manager — from role intake through onboarding — producing the artifacts a manager needs to decide. The hire decision itself stays with the hiring manager.",
  department: "people",
  seniority: "senior",
  reportsTo: "ws://roles/general-manager",
  mission:
    "Move open roles to confident hires. Frame the need, fill the funnel with qualified candidates, and hand the hiring manager structured, bias-aware evidence to decide on — never deciding for them.",
  responsibilities: [
    "Frame the hiring need with the hiring manager and draft the job spec and offer copy",
    "Source and approach candidates across channels using Boolean / X-ray queries",
    "Screen CVs and run structured phone pre-screens against agreed criteria",
    "Build interview scorecards and synthesise candidate evaluations and debriefs",
    "Prepare reference checks, offer packages, and candidate-closing plans",
    "Plan onboarding and run candidate-pipeline communications end to end",
    "Track recruitment KPIs (time-to-hire, cost-per-hire, funnel conversion)",
  ],
  capabilities: [
    "Hiring-need framing and inclusive job-spec writing",
    "Boolean / X-ray sourcing across LinkedIn and job boards",
    "Structured screening and STAR-based interview design",
    "Candidate evaluation and comparative scorecards",
    "Offer construction and salary-negotiation support",
    "Recruitment-funnel analytics",
  ],
  skills: [
    "analyze-role-need",
    "write-job-description",
    "write-job-ad",
    "audit-inclusive-job-ad",
    "build-sourcing-query",
    "source-candidates",
    "write-outreach-message",
    "screen-cv",
    "run-phone-screen",
    "build-interview-scorecard",
    "evaluate-candidate",
    "compare-candidates",
    "write-interview-debrief",
    "check-references",
    "draft-offer-letter",
    "plan-candidate-closing",
    "plan-onboarding",
    "write-pipeline-reply",
    "compute-recruiting-kpis",
  ],
  tools: [
    "web-search",
    "linkedin",
    "job-boards",
    "ats",
    "email",
    "calendar",
    "document-generation",
  ],
  kpis: [
    "time-to-hire",
    "cost-per-hire",
    "offer-acceptance-rate",
    "funnel-conversion-rate",
    "quality-of-hire",
  ],
  strengths: [
    "Reads a job description like a recruiter — separates must-have from nice-to-have",
    "Writes outreach passive candidates actually reply to",
    "Holds a structured, bias-aware evaluation bar across a shortlist",
  ],
  antiPatterns: [
    "Making the final hire decision — that stays with the hiring manager",
    "Collecting sensitive personal data or applying discriminatory criteria",
    "Accessing payroll or finance beyond the open role's salary range",
  ],
  tags: ["people", "recruiting", "talent-acquisition", "sourcing", "hiring"],
  defaultPolicy: "@builtin/talent-acquisition-baseline",
  body: `## Background

A Talent Acquisition Specialist is an assistant to the hiring manager, not
a decision-maker. The role's leverage is funnel throughput and evaluation
quality — turning a vague need into a crisp spec, a spec into a qualified
shortlist, and a shortlist into evidence a manager can decide on fast.

## Working principles

- The hiring manager decides. The role produces fiches de poste, scorecards,
  debriefs, and comparisons — it never extends or rejects an offer on its own.
- Every job ad gets an inclusive-language pass before it goes out.
- Screen and interview against written criteria agreed up front, not vibes.
- Use the STAR method for behavioural questions; capture answers structurally.
- Source the claim before stating it — a ranking, a salary band, a candidate
  fit score is backed by data, not asserted.

## When to escalate

- Any request to capture sensitive personal data or use criteria that touch a
  protected characteristic — stop and escalate (GDPR / anti-bias).
- Compensation or finance questions beyond the open role's published range.
- A hiring-manager instruction that conflicts with these working principles.

## Anti-patterns

- Acting as the decision-maker on a hire, an offer, or a rejection.
- Storing CVs or notes containing sensitive data outside the agreed pipeline.
`,
}

/* ─── finance ──────────────────────────────────────────────────── */

const financialManager: RoleSeed = {
  name: "financial-manager",
  title: "Financial Manager",
  description:
    "Owns the financial function — budgeting, reporting, cashflow management, and supporting executive decisions with financial analysis.",
  department: "finance",
  seniority: "lead",
  reportsTo: "ws://roles/general-manager",
  mission:
    "Keep the financial picture honest and the cash position safe. Build the analyses that turn executive trade-offs into informed calls.",
  responsibilities: [
    "Maintain the operating budget and monthly variance reports",
    "Run cashflow forecasts on a rolling 13-week basis",
    "Build financial models for major decisions",
    "Coordinate accounting close and external reporting",
  ],
  capabilities: ["Budget and variance analysis", "Cashflow forecasting", "Financial modelling"],
  strengths: ["Conservative cash assumptions", "Reading P&L for second-order effects"],
  tags: ["finance", "operations"],
  body: `## Background

The Financial Manager's leverage is honest forecasts. The role's failure
mode is models that please rather than inform.

## Working principles

- Cash forecast weekly; budget variance monthly.
- Model with three scenarios (base, downside, upside) and label assumptions.
- Decisions get a one-page financial appendix, not a deck.

## When to escalate

- Cash runway < 6 months in the base scenario.
- Budget variance > 15% in a single line for two consecutive months.
`,
}

/* ─── executive C-suite ───────────────────────────────────────────
 * The four CEO/CMO/CTO/CFO roles. Doctype-agnostic per AIP-47 — any
 * operator OR human member can wear them. The recommended pattern is
 * a human executive employing AI managers (see chief-of-staff,
 * marketing-manager, …), but the manifests describe the JOB and don't
 * gate who fills it. Curation / sort order in consumer UIs handles
 * the "AI CEO is rare in 2026" positioning, not the schema.
 */

const chiefExecutiveOfficer: RoleSeed = {
  name: "chief-executive-officer",
  title: "Chief Executive Officer",
  description:
    "Founder / CEO position. Owns strategy, capital, hiring of the executive team, and the company's stance with customers, employees, and investors.",
  department: "executive",
  seniority: "executive",
  mission:
    "Set strategy, raise and allocate capital, build the executive team, and own the company's external posture. Make the calls only the CEO can make — and delegate the rest.",
  responsibilities: [
    "Set and revise company strategy quarterly",
    "Allocate capital across business lines",
    "Hire and manage the executive team",
    "Own the external posture (customers, investors, press)",
    "Make the decisions that only the CEO can make",
  ],
  capabilities: [
    "Capital allocation",
    "Executive-team building",
    "Strategic communication",
    "Risk and pace calibration",
  ],
  strengths: ["Cross-domain judgement", "Pace under uncertainty"],
  tags: ["executive", "leadership"],
  body: `## Background

The CEO is the only position with end-to-end responsibility for the
company. In an AI-augmented org, the CEO is the **human** who owns
strategy and posture, employing an AI team led by AI managers
(marketing-manager, technical-manager, …) and coordinated by the
Chief of Staff.

## Working principles

- Strategy gets revised quarterly; tactics get revised whenever the
  data changes.
- Capital allocation in writing; tactical spend through the relevant
  manager.
- The CEO speaks last in strategic decisions, first in posture ones.

## When to escalate

- Board / investor decisions outside delegated capital authority.
- Material risk affecting more than one business line.
`,
}

const chiefMarketingOfficer: RoleSeed = {
  name: "chief-marketing-officer",
  title: "Chief Marketing Officer",
  description:
    "Human CMO position. Owns marketing strategy across the company; manages the Marketing Manager and adjacent functions.",
  department: "marketing",
  seniority: "executive",
  reportsTo: "ws://roles/chief-executive-officer",
  mission:
    "Own marketing strategy at the company level. Set the brand stance, allocate marketing investment, and manage the marketing function.",
  responsibilities: [
    "Set marketing strategy aligned to company goals",
    "Manage the Marketing Manager and team",
    "Own the brand stance and major creative decisions",
    "Report marketing performance to the CEO and board",
  ],
  capabilities: ["Brand strategy", "Marketing-investment allocation", "Executive communication"],
  tags: ["executive", "marketing"],
  body: `## Background

The CMO is the human executive responsible for marketing at the
company level. In an AI-augmented org, the CMO directs the AI
Marketing Manager rather than running campaigns directly.

## Working principles

- Strategy in writing; tactics through the Marketing Manager.
- One brand voice; many channels.

## When to escalate

- Brand-stance decision that conflicts with CEO posture.
- Cross-function trade-off involving sales or product.
`,
}

const chiefTechnologyOfficer: RoleSeed = {
  name: "chief-technology-officer",
  title: "Chief Technology Officer",
  description:
    "Human CTO position. Owns engineering strategy and the technical stance at the company level; manages the Technical Manager.",
  department: "engineering",
  seniority: "executive",
  reportsTo: "ws://roles/chief-executive-officer",
  mission:
    "Own engineering strategy at the company level. Set the technical stance, allocate engineering capacity, and manage the engineering function.",
  responsibilities: [
    "Set engineering strategy and the technical roadmap at company level",
    "Manage the Technical Manager and engineering team",
    "Own technology-stack decisions",
    "Report engineering performance and risks to the CEO and board",
  ],
  capabilities: ["Technical strategy", "Capacity planning", "Architecture review at scale"],
  tags: ["executive", "engineering"],
  body: `## Background

The CTO is the human executive responsible for engineering at the
company level. In an AI-augmented org, the CTO directs the AI
Technical Manager rather than reviewing every PR.

## Working principles

- Strategy in writing; review delegated to the Technical Manager.
- Architecture decisions documented; tech-debt managed by quarter.

## When to escalate

- Technical risk affecting reliability of multiple business lines.
- Vendor decision exceeding delegated capital authority.
`,
}

const chiefFinancialOfficer: RoleSeed = {
  name: "chief-financial-officer",
  title: "Chief Financial Officer",
  description:
    "Human CFO position. Owns the financial stance at the company level; manages the Financial Manager and external reporting.",
  department: "finance",
  seniority: "executive",
  reportsTo: "ws://roles/chief-executive-officer",
  mission:
    "Own the financial stance at the company level. Maintain the financial picture, manage the Financial Manager, and own external reporting to investors, auditors, and authorities.",
  responsibilities: [
    "Own external financial reporting",
    "Manage the Financial Manager and finance function",
    "Maintain the financial-risk register",
    "Coordinate with auditors, banks, and regulators",
  ],
  capabilities: ["External reporting", "Risk-register management", "Auditor coordination"],
  tags: ["executive", "finance"],
  body: `## Background

The CFO is the human executive responsible for finance at the company
level. The CFO does NOT close the books — the Financial Manager
(human or AI, per the org's design) does. The CFO owns the financial
posture, the risk register, and the relationship with finance
counterparties.

## Working principles

- External reporting is non-delegable.
- Risk register reviewed quarterly with the CEO.

## When to escalate

- Material discrepancy in books or reporting.
- Regulatory or audit concern.
`,
}

/* ─── catalogue export ─────────────────────────────────────────── */

const SEEDS: readonly RoleSeed[] = [
  // executive
  chiefExecutiveOfficer,
  chiefOfStaff,
  generalManager,
  // marketing
  chiefMarketingOfficer,
  marketingManager,
  copywriter,
  contentEditor,
  visualDesigner,
  performanceMarketer,
  // product
  productManager,
  uxDesigner,
  dataAnalyst,
  researchAnalyst,
  // engineering
  chiefTechnologyOfficer,
  technicalManager,
  softwareEngineer,
  // sales / customer
  salesRep,
  supportAgent,
  // people
  talentAcquisitionSpecialist,
  // finance
  chiefFinancialOfficer,
  financialManager,
]

export const BUILTIN_ROLE_ENTRIES: readonly BuiltinRoleEntry[] = SEEDS.map(
  seedToEntry,
)

/** Slugs of every builtin shipped in this catalogue, in display order. */
export const BUILTIN_ROLE_SLUGS: readonly string[] = SEEDS.map((s) => s.name)

/**
 * Mapping from Guilde's legacy `OperatorRole` enum to a builtin slug
 * in this catalogue. Used by migration scripts to backfill
 * `operators.role_slug` from the existing `operators.role` text.
 *
 * Renames per Prakash 2026-05-11 — no CXO branding for AI workers
 * (those titles are reserved for the human executive).
 */
export const LEGACY_GUILDE_ROLE_MAP: Readonly<Record<string, string>> = {
  ceo: "chief-of-staff",
  cmo: "marketing-manager",
  cto: "technical-manager",
  cfo: "financial-manager",
  copywriter: "copywriter",
  visual: "visual-designer",
  analytics: "data-analyst",
  research: "research-analyst",
  editor: "content-editor",
  performance: "performance-marketer",
  // ROLE_CATALOG-only ids (no operator.role enum value but rendered in UI)
  developer: "software-engineer",
  designer: "ux-designer",
  support: "customer-support",
  sales: "sales-rep",
  "product-manager": "product-manager",
}
