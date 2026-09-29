---
schema: knowledge.workspace/v1
name: acme-company-view
title: Acme — research wiki view
description:
  Acme's lens on the shared research wiki. Adds an Investor entity type for the
  finance team and binds an AIP-7 governance policy that gates Concept and
  Investor entries through approval before publication.
version: 1.2.0

extends: ../../research-wiki/KNOWLEDGE.md

appliesTo:
  - ws://companies/acme

curator: ws://operators/acme-librarian
governance: ../policies/acme-knowledge.yaml

entityTypes:
  - name: Investor
    icon: 💼
    parent: Person
    fields: [fund, lead_partner, board_seat, last_meeting_at]
    description:
      An investor on Acme's cap table. Subtype of Person; inherits Person
      fields, adds finance-specific ones.
  - name: Person
    fields: [internal_owner] # appended to parent's [name, role, contact, affiliations]

lints:
  - id: require-source
    kind: require-source
    appliesTo: Investor # narrowed; the parent rule on Concept still applies
    severity: error
  - id: investor-meeting-recency
    kind: max-age
    appliesTo: Investor
    severity: warn
    params:
      days: 60

curation:
  tone: neutral
  conflictResolution: keep-both # finance disputes are kept, not auto-resolved

metadata:
  acme:
    cost_center: research-shared
    pii_class: confidential
---

# Acme — research wiki view

Acme uses the shared research wiki and layers a stricter governance policy on
top. The finance team's Investor subtype extends Person; both pass through
approval before publication.
