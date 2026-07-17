# LinkedIn — playbooks (the 100x layer)

Playbooks **compose** the read recipes (`recipes.md`) into the things you
actually want: rich personas, the engagement/relationship graph, and
discover→dossier→outreach loops. Everything is the `Person`/`Post`/`Reaction`/
`Comment`/`Edge` model (`voyager.md`) cached to the workspace.

## The Person dossier = identity + voice + interests + network

A persona is the **union** of four signals — don't fetch isolated facts:

```
identity   profile (name, headline, location, positions, urn)        ← voyagerIdentityDashProfiles
voice      their posts + comments (what they SAY)                    ← recent-activity/posts + /comments
interests  what they REACT to (what they value)                      ← recent-activity/reactions
network    who they're connected to / follow / engage with           ← connections + engagement graph
```

### Playbook: `persona.build(personRef)` — SHIPPED helpers

Concrete, drift-proof building blocks (`createLinkedInVoyager` in
`@agstudio/browser-social`, all REST/re-focused):

```
LI.persona(vanity)            → { name, headline, location?, followers?, urn }   (dash REST, no queryId)
LI.dossier(vanity, n)         → { persona, posts:[{urn,text}] }                  (persona + authored posts)
LI.connections({max})         → [{name, vanity, headline}]                       (REST, paginates)
LI.connectionsCount()         → numConnections                                   (ground truth)
LI.reactors(urn) / .comments(urn)  → engaged Persons on a post
```

1. Resolve ref → vanity (search+score if a name; direct if a vanity).
2. `LI.dossier(vanity)` → identity + voice (their authored posts w/ text).
3. (their interests/given-reactions: not yet a clean endpoint — derive from
   posts + who they engage; followers endpoint TBD, old REST is 410-gone).
4. Synthesize: themes, tone, cadence, hooks for outreach.
5. Ingest → graph: `scripts/graph.ts dossier <vanity>` (SocialPerson + AUTHORED
   edges).

→ Output: a dossier rich enough to (a) understand the person and (b) draft a
genuinely personalized note from THEIR voice/interests (feeds
`write-actions.md`).

## The engagement / relationship graph

A post's **reactions + comments = a list of engaged Persons.** Aggregate across
a person's posts → their **engaged audience** (who consistently shows up).
Aggregate the other way → influence (whose posts does X engage with).

### Playbook: `engagement.map(postUrn | personRef)`

- For a post: `who-reacted` (+ reactionType) + `who-commented` (+ text) →
  engaged Persons.
- For a person: run over their last N posts → frequency table of engagers (the
  real relationship graph, beyond formal "connections").
- Output: ranked engagers, each promotable to `persona.build`.

## Discovery → dossier → outreach (the two modes you asked for)

### Mode A — targeted (you name people): `dossier.many([refs])`

→ `persona.build` each → comparison table.

### Mode B — discovery (you give criteria): `audience.find(criteria)`

1. `search` people/posts by keywords/role/company (+ the scorer).
2. Shortlist top matches.
3. `persona.build` each (voice + interests).
4. Rank by fit to the goal.
5. (gated) draft a personalized connect-note / message per persona, from their
   voice — **confirm before any send**.

This closes the loop: find the right people → understand them → reach out, as a
single agentic flow.

## The payoff: graph queries (SHIPPED — `@agstudio/graph-social` query layer)

Once personas + engagement + connections are in Neo4j, the value is the
_queries_ (`scripts/graph.ts insights`):

```
graphStats(store)                              → node/edge counts by type
topEngagers(store, n)                          → most-engaged people (reactions + 2×comments)
engagedAndConnected(store, postUrn, ego)       → WARM INTROS: reacted/commented AND a connection
coEngagement(store)                            → affinity: people who engaged the same posts
audienceByHeadline(store, "AI")                → segment by headline keyword
personDossier(store, "linkedin", vanity)       → all edges for one person (in-graph dossier)
```

`engagedAndConnected` is the killer query — it surfaces the people who are both
in your network AND just engaged with content (the highest-signal outreach
list).

## Build order (what's live vs TBD)

```
✅ REACTED   (reactors() — inline ~10 + reaction type)        ✅ CONNECTED (connections() REST, 3095 enumerable)
✅ COMMENTED (comments() — all loaded + text)                 ✅ AUTHORED  (dossier() → posts)
✅ FOLLOWS   (mutual, derived from CONNECTED on ingest)        ✅ graph query layer (warm-intro / top-engager / segments)
⚠️ full per-post reaction enumeration capped (~10) — modal is viewport-limited (see recipes.md)
⚠️ FOLLOWS one-way / arbitrary-follower ENUMERATION is gated by LinkedIn — every known
   endpoint is 410/404/400 (feed/follows, profileFollowers, networkinfo, voyagerIdentityDashProfileFollowers
   doesn't fire headlessly). What's reliable: (a) mutual FOLLOWS from connections (LinkedIn auto-follows
   on connect), (b) follower COUNT via dash showFollowerCount. Enumerating a big account's followers ≠ available.
```

## Principles

- **API-first**: every step is a Voyager fetch; DOM only for the few write
  buttons.
- **Cache everything**: workspace KB; query cache first, fetch deltas.
  Personas + engagement edges accrete into a local graph over time.
- **Persist to graph-orm (Neo4j)**: the durable layer for this — SocialPerson
  nodes
  - AUTHORED/REACTED/COMMENTED/FOLLOWS/CONNECTED edges, upsert-by-handle,
    queried with spreading-activation / shortest-path / engagement-count. Plan:
    `docs/plans/social-graph-orm.md`. These playbooks then run as graph queries,
    not ad-hoc JSON.
- **Idempotent + resumable**: each person/post keyed by URN; re-runnable.
- **Rate-limit + space writes**; never burst (LinkedIn flags automation).
- **Gate every write**; personalization comes from the dossier, the send from
  the user.
