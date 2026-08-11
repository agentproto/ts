// ─── Mock Data (matches src/mock-data.ts structure) ────────────

const MOCK_CARD = {
  id: "rift-card-agent-orchestration",
  input: {
    rawText: "AI agent orchestration platform for building multi-agent systems",
    title: "AI Agent Orchestration Platform",
    tags: ["ai", "agents", "orchestration"]
  },
  claims: [
    {
      id: "claim-langgraph-stars",
      text: "LangGraph has 38,259 GitHub stars as of July 2026",
      evidenceLabel: "Verified",
      sourceIds: ["gh-langgraph-repo"]
    },
    {
      id: "claim-crewai-stars",
      text: "CrewAI has 56,219 GitHub stars as of July 2026",
      evidenceLabel: "Verified",
      sourceIds: ["gh-crewai-repo"]
    },
    {
      id: "claim-autogen-stars",
      text: "Microsoft AutoGen has 60,029 GitHub stars as of July 2026",
      evidenceLabel: "Verified",
      sourceIds: ["gh-autogen-repo"]
    },
    {
      id: "claim-autogen-maintenance",
      text: "Microsoft AutoGen is in maintenance mode with no new features planned",
      evidenceLabel: "Verified",
      sourceIds: ["gh-autogen-readme"]
    },
    {
      id: "claim-langchain-pricing",
      text: "LangChain offers a Developer tier at $0/seat plus usage ($1.50/LCU, $1.00/LSU) and Plus tier at $39/seat",
      evidenceLabel: "Verified",
      sourceIds: ["langchain-pricing"]
    },
    {
      id: "claim-agent-framework-star-parity-inference",
      text: "Agent orchestration frameworks have achieved similar GitHub star counts to established ML/data tools",
      evidenceLabel: "Inference",
      sourceIds: ["gh-langgraph-repo", "gh-crewai-repo"],
      uncertainty: "Star counts reflect popularity but don't directly measure production adoption or revenue potential"
    },
    {
      id: "claim-market-consolidation-inference",
      text: "Market consolidation appears likely as Microsoft exits active development",
      evidenceLabel: "Inference",
      sourceIds: ["gh-autogen-repo", "gh-autogen-readme"],
      uncertainty: "AutoGen's maintenance mode is confirmed, but competitive response from LangGraph/CrewAI is inferred"
    }
  ],
  sources: [
    {
      id: "gh-langgraph-repo",
      type: "github-repository",
      url: "https://github.com/langchain-ai/langgraph",
      title: "langchain-ai/langgraph",
      observedAt: "2026-07-27T17:07:00.000Z",
      excerpt: 'stargazers_count: 38259; created_at: 2023-08-09T18:33:12Z; license: MIT; description: "Build resilient agents."',
      claimIds: ["claim-langgraph-stars", "claim-agent-framework-star-parity-inference"],
      quality: { tier: "primary", score: 0.9, assessedAt: "2026-07-27T17:07:00.000Z" }
    },
    {
      id: "gh-crewai-repo",
      type: "github-repository",
      url: "https://github.com/crewAIInc/crewAI",
      title: "crewAIInc/crewAI",
      observedAt: "2026-07-27T17:08:00.000Z",
      excerpt: 'stargazers_count: 56219; created_at: 2023-10-27T03:26:59Z; license: MIT',
      claimIds: ["claim-crewai-stars", "claim-agent-framework-star-parity-inference"],
      quality: { tier: "primary", score: 0.9, assessedAt: "2026-07-27T17:08:00.000Z" }
    },
    {
      id: "gh-autogen-repo",
      type: "github-repository",
      url: "https://github.com/microsoft/autogen",
      title: "microsoft/autogen",
      observedAt: "2026-07-27T17:09:00.000Z",
      excerpt: 'stargazers_count: 60029; created_at: 2023-08-18T11:43:45Z; license: CC-BY-4.0',
      claimIds: ["claim-autogen-stars", "claim-market-consolidation-inference"],
      quality: { tier: "primary", score: 0.9, assessedAt: "2026-07-27T17:09:00.000Z" }
    },
    {
      id: "gh-autogen-readme",
      type: "github-file",
      url: "https://raw.githubusercontent.com/microsoft/autogen/main/README.md",
      title: "microsoft/autogen README.md",
      observedAt: "2026-07-27T17:10:00.000Z",
      excerpt: "AutoGen is now in maintenance mode. It will not receive new features or enhancements and is community managed going forward.",
      claimIds: ["claim-autogen-maintenance", "claim-market-consolidation-inference"],
      quality: { tier: "primary", score: 1.0, assessedAt: "2026-07-27T17:10:00.000Z" }
    },
    {
      id: "langchain-pricing",
      type: "pricing-page",
      url: "https://www.langchain.com/pricing",
      title: "LangChain Pricing",
      observedAt: "2026-07-27T17:11:00.000Z",
      excerpt: "Developer: $0 / seat per month then pay as you go. Plus: $39 / seat per month then pay as you go. Usage: $1.50 / LCU, $1.00 / LSU",
      claimIds: ["claim-langchain-pricing"],
      quality: { tier: "primary", score: 0.95, assessedAt: "2026-07-27T17:11:00.000Z" }
    }
  ],
  marketSignal: "moderate",
  recommendation: {
    recommendation: "wait",
    reasons: [
      "Strong competitor presence (3 major frameworks with 38k-60k stars)",
      "Market leader (AutoGen) exiting active development creates opportunity",
      "Pricing models established ($0-39/seat + usage), indicating market maturity",
      "High uncertainty around which remaining player will dominate the consolidation"
    ],
    claimIds: ["claim-langgraph-stars", "claim-crewai-stars", "claim-autogen-stars", "claim-autogen-maintenance", "claim-langchain-pricing"]
  },
  drafts: {
    prd: { placeholder: true },
    landingPage: { placeholder: true },
    xPost: { placeholder: true }
  },
  createdAt: "2026-07-27T17:20:00.000Z",
  updatedAt: "2026-07-27T17:20:00.000Z"
};

// ─── State Management ──────────────────────────────────────────

let currentCard = null;
let userDecision = null;

// ─── DOM Elements ──────────────────────────────────────────────

const inputSection = document.getElementById('inputSection');
const cardSection = document.getElementById('cardSection');
const decisionSection = document.getElementById('decisionSection');
const inputForm = document.getElementById('inputForm');

// Input fields
const titleInput = document.getElementById('titleInput');
const rawTextInput = document.getElementById('rawTextInput');
const tagsInput = document.getElementById('tagsInput');

// Card elements
const cardTitle = document.getElementById('cardTitle');
const cardId = document.getElementById('cardId');
const cardDate = document.getElementById('cardDate');
const signalBadge = document.getElementById('signalBadge');
const claimsCount = document.getElementById('claimsCount');
const claimsList = document.getElementById('claimsList');
const sourcesCount = document.getElementById('sourcesCount');
const sourcesList = document.getElementById('sourcesList');
const recommendationBadge = document.getElementById('recommendationBadge');
const recommendationReasons = document.getElementById('recommendationReasons');

// Buttons
const btnBuild = document.getElementById('btnBuild');
const btnWait = document.getElementById('btnWait');
const btnReject = document.getElementById('btnReject');
const btnNewCard = document.getElementById('btnNewCard');
const btnBackToInput = document.getElementById('btnBackToInput');

// Decision elements
const decisionIcon = document.getElementById('decisionIcon');
const decisionTitle = document.getElementById('decisionTitle');
const decisionMessage = document.getElementById('decisionMessage');

// ─── Rendering Functions ───────────────────────────────────────

function renderCard(card) {
  currentCard = card;

  // Header
  cardTitle.textContent = card.input.title || card.input.rawText.slice(0, 60) + '...';
  cardId.textContent = card.id;
  cardDate.textContent = new Date(card.createdAt).toLocaleString();

  // Market Signal
  signalBadge.textContent = card.marketSignal || '—';
  signalBadge.className = 'signal-badge signal-' + (card.marketSignal || 'unclear');

  // Claims
  claimsCount.textContent = card.claims.length;
  claimsList.innerHTML = '';
  card.claims.forEach(claim => {
    const claimEl = document.createElement('div');
    claimEl.className = `claim-item ${claim.evidenceLabel.toLowerCase().replace(' ', '-')}`;

    const labelClass = claim.evidenceLabel.toLowerCase().replace(' ', '-');

    claimEl.innerHTML = `
      <div class="claim-header">
        <span class="claim-label ${labelClass}">${claim.evidenceLabel}</span>
      </div>
      <div class="claim-text">${claim.text}</div>
      ${claim.uncertainty ? `<div class="claim-uncertainty">⚠ ${claim.uncertainty}</div>` : ''}
    `;

    claimsList.appendChild(claimEl);
  });

  // Sources
  sourcesCount.textContent = card.sources.length;
  sourcesList.innerHTML = '';
  card.sources.forEach(source => {
    const sourceEl = document.createElement('div');
    sourceEl.className = 'source-item';

    const date = source.publishedAt || source.observedAt;
    const dateLabel = source.publishedAt ? 'Published' : 'Observed';

    sourceEl.innerHTML = `
      <div class="source-title">${source.title || source.id}</div>
      ${source.url ? `<a href="${source.url}" class="source-url" target="_blank" rel="noopener">${source.url}</a>` : ''}
      ${date ? `<div class="source-meta">${dateLabel}: ${new Date(date).toLocaleDateString()}</div>` : ''}
      ${source.excerpt ? `<div class="source-excerpt">"${source.excerpt}"</div>` : ''}
    `;

    sourcesList.appendChild(sourceEl);
  });

  // Recommendation
  if (card.recommendation) {
    recommendationBadge.textContent = card.recommendation.recommendation.toUpperCase();
    recommendationBadge.className = `recommendation-badge ${card.recommendation.recommendation}`;

    recommendationReasons.innerHTML = '';
    card.recommendation.reasons.forEach(reason => {
      const li = document.createElement('li');
      li.textContent = reason;
      recommendationReasons.appendChild(li);
    });
  }

  // Show card section
  showSection('card');
}

function showSection(section) {
  inputSection.style.display = section === 'input' ? 'block' : 'none';
  cardSection.style.display = section === 'card' ? 'block' : 'none';
  decisionSection.style.display = section === 'decision' ? 'block' : 'none';
}

function showDecision(decision) {
  userDecision = decision;

  const icons = {
    build: '🚀',
    wait: '⏳',
    reject: '❌'
  };

  const titles = {
    build: 'Building!',
    wait: 'Waiting',
    reject: 'Rejected'
  };

  const messages = {
    build: 'Great choice! This signal shows strong potential. Time to build.',
    wait: 'Smart move. We\'ll monitor this space and revisit when conditions are clearer.',
    reject: 'Decision recorded. This signal doesn\'t meet the bar right now.'
  };

  decisionIcon.textContent = icons[decision];
  decisionTitle.textContent = titles[decision];
  decisionMessage.textContent = messages[decision];

  showSection('decision');
}

// ─── Event Handlers ────────────────────────────────────────────

inputForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const rawText = rawTextInput.value.trim();
  if (!rawText) return;

  // In a real app, this would call an API
  // For the demo, we use the mock card with user's input
  const userInput = {
    rawText,
    title: titleInput.value.trim() || undefined,
    tags: tagsInput.value.split(',').map(t => t.trim()).filter(Boolean)
  };

  // Simulate card generation (use mock data with user input)
  const generatedCard = {
    ...MOCK_CARD,
    input: userInput,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  renderCard(generatedCard);
});

btnBuild.addEventListener('click', () => showDecision('build'));
btnWait.addEventListener('click', () => showDecision('wait'));
btnReject.addEventListener('click', () => showDecision('reject'));

btnNewCard.addEventListener('click', () => {
  inputForm.reset();
  currentCard = null;
  showSection('input');
});

btnBackToInput.addEventListener('click', () => {
  inputForm.reset();
  currentCard = null;
  userDecision = null;
  showSection('input');
});

// ─── Initialize ────────────────────────────────────────────────

showSection('input');
