#!/usr/bin/env node
/**
 * gen-status.mjs — generates STATUS.md, a tier classification table of every
 * pnpm workspace package.
 *
 * Tiers (exactly one per package, applied in this order):
 *   archived       — dead packages with zero workspace dependents, from the
 *                    explicit override list below (PARACHUTED: verified by
 *                    scanning every workspace package.json's dependencies,
 *                    devDependencies and peerDependencies). The override wins
 *                    over the adapters/** path rule.
 *   adapters       — packages under adapters/** (AIP-45 agent-CLI adapters and
 *                    tool projections) that are not on the override list.
 *   core           — runtime packages the product actually loads/configures:
 *                    runtime, cli, driver core, sandbox family, auth,
 *                    model-catalog, and everything else that is not one of
 *                    the more specific tiers below.
 *   spec-reference - spec-only / doctype-only packages: reference
 *                    implementations of AIP file formats whose workspace
 *                    dependencies are limited to the doctype meta-factory
 *                    (@agentproto/doctype, with the deprecated
 *                    @agentproto/define-doctype shim counted too), generic
 *                    doctype verbs (@agentproto/manifest) and build tooling
 *                    (@agentproto/tooling). This is computed as a transitive
 *                    closure, so doctype packages layered on top of other
 *                    doctype packages (e.g. workspace -> work) qualify too.
 *
 * Flags:
 *   --check   verify STATUS.md is up to date (exit 1 on drift)
 *   --count   print the number of workspace package.json files
 *   --stats   print tier counts
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

// Workspace globs from pnpm-workspace.yaml (examples/* currently matches
// nothing but is part of the contract, so it is honored here as well).
const GLOBS = [
  "packages/*",
  "packages/driver/*",
  "packages/governance/*",
  "packages/agencies/*",
  "adapters/*",
  "examples/*",
];

// Dead packages with no workspace dependents -> archived. Each has been
// verified by scanning all workspace package.json dependency fields.
const ARCHIVED = new Set([
  "@agentproto/driver-sdk", // packages/driver/sdk
  "@agentproto/adapter-kit", // packages/adapter-kit
  "@agentproto/workflow-ai-sdk", // packages/workflow-ai-sdk
  "@agentproto/egress", // packages/egress
  "@agentproto/identity", // packages/identity
  "@agentproto/catalog", // packages/catalog
  "@agentproto/role-catalog", // packages/role-catalog
  "@agentproto/adapter-ai-sdk", // adapters/ai-sdk
  "@agentproto/adapter-mastra", // adapters/mastra
  // AIP-70 rename shims: deprecated re-export packages with no workspace
  // dependents, classified like adapter-kit.
  "@agentproto/agency-v2", // packages/agency-v2
  "@agentproto/app-kit", // packages/app-kit
  "@agentproto/define-doctype", // packages/define-doctype
  "@agentproto/driver-agent-cli", // packages/driver/agent-cli
  "@agentproto/llm-endpoint", // packages/llm-endpoint
  "@agentproto/mastra", // packages/mastra
  "@agentproto/pair-client", // packages/pair-client
  "@agentproto/redaction", // packages/redaction
]);

// Core runtime family: named regardless of doctype-only dependency closure.
const CORE_NAMES = new Set([
  "@agentproto/runtime",
  "@agentproto/agent-runtime",
  "@agentproto/cli",
  "@agentproto/cli-exec",
  "@agentproto/driver",
  "@agentproto/auth",
  "@agentproto/model-catalog",
  "@agentproto/catalog-sync",
  "@agentproto/sandbox",
  "@agentproto/sandbox-box",
  "@agentproto/sandbox-computer",
  "@agentproto/sandbox-e2b",
  "@agentproto/sandbox-instabox",
  "@agentproto/workflow-runtime",
  "@agentproto/runtime-profile-standard",
]);

// Build-time tooling packages: allowed as deps without disqualifying the
// spec-reference classification (they ship build macros, not runtime deps).
const TOOLING_DEPS = new Set(["@agentproto/tooling"]);

// Seed of the spec-reference closure: the AIP doctype meta-factory and its
// deprecated shim name.
const DOCTYPE_SEEDS = new Set([
  "@agentproto/doctype",
  "@agentproto/define-doctype",
]);

function workspaceDirs(root = process.cwd()) {
  const dirs = [];
  for (const glob of GLOBS) {
    const parts = glob.split("/");
    const parentRel = parts.slice(0, -1).join("/");
    const parent = path.join(root, parentRel);
    if (!existsSync(parent)) continue;
    // Parent chain (e.g. packages/driver) must itself exist for the glob
    // to have ever been a workspace match candidate. GLOBS are all
    // `<parent>/*`, so one readdir of the parent is the full match.
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dirRel = path.posix.join(parentRel, entry.name);
      if (existsSync(path.join(root, dirRel, "package.json"))) {
        dirs.push(dirRel);
      }
    }
  }
  return dirs.sort();
}

function packageJson(dir) {
  return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
}

function workspaceDeps(pj) {
  const all = {
    ...pj.dependencies,
    ...pj.devDependencies,
    ...pj.peerDependencies,
  };
  return Object.keys(all).filter((n) => n.startsWith("@agentproto/"));
}

export function computeStatus(root = process.cwd()) {
  const dirs = workspaceDirs(root);
  const entries = dirs.map((dir) => {
    const pj = packageJson(path.join(root, dir));
    return { dir, name: pj.name, version: pj.version, deps: workspaceDeps(pj) };
  });

  // Verify the archived list holds: archived means zero workspace dependents.
  for (const entry of entries) {
    for (const dep of entry.deps) {
      if (ARCHIVED.has(dep)) {
        throw new Error(
          `archived override invalid: ${entry.name} (${entry.dir}) depends on archived ${dep}`,
        );
      }
    }
  }

  // Spec-reference closure: every package that is a doctype/AIP file-format
  // implementation qualifies if (a) it directly uses the doctype meta-factory
  // (@agentproto/doctype, plus the deprecated @agentproto/define-doctype shim,
  // and manifest/tooling/seed itself count too) and (b) each of its workspace
  // dependencies, other than build tooling, is itself a spec-reference
  // package. Runtime packages depending on doctypes plus real services
  // (registry, relay, provider-kit, ...) fail (b).
  const spec = new Set(DOCTYPE_SEEDS);
  const inSpec = (name) =>
    spec.has(name) ||
    DOCTYPE_SEEDS.has(name) ||
    name === "@agentproto/tooling" ||
    name === "@agentproto/manifest";
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of entries) {
      if (
        spec.has(e.name) ||
        ARCHIVED.has(e.name) ||
        CORE_NAMES.has(e.name) ||
        e.dir.startsWith("adapters/")
      )
        continue;
      const usesDoctype =
        e.deps.some((d) => DOCTYPE_SEEDS.has(d)) ||
        DOCTYPE_SEEDS.has(e.name) ||
        e.name === "@agentproto/manifest";
      const runtimeDeps = e.deps.filter((d) => !TOOLING_DEPS.has(d));
      if (usesDoctype && runtimeDeps.every((d) => inSpec(d))) {
        spec.add(e.name);
        changed = true;
      }
    }
  }

  const classified = entries.map((e) => {
    let tier;
    let reason;
    // Precedence matches the documented rule order: the explicit
    // dead-package override list wins over the adapters/** path rule.
    if (ARCHIVED.has(e.name)) {
      tier = "archived";
      reason = "dead: zero workspace dependents (override list)";
    } else if (e.dir.startsWith("adapters/")) {
      tier = "adapters";
      reason = "under adapters/** — AIP-45 adapter or tool projection";
    } else if (CORE_NAMES.has(e.name)) {
      tier = "core";
      reason = "core runtime family (runtime/cli/driver/sandbox/auth/model-catalog)";
    } else if (spec.has(e.name)) {
      tier = "spec-reference";
      reason = "spec/doctype-only: workspace deps limited to doctype meta-packages";
    } else {
      tier = "core";
      reason = "product runtime package consumed by the runtime/cli";
    }
    return { name: e.name, dir: e.dir, version: e.version, tier, reason };
  });

  classified.sort((a, b) => a.tier.localeCompare(b.tier) || a.dir.localeCompare(b.dir));
  return classified;
}

function renderTable(entries) {
  const header =
    [
      "Package",
      "Path",
      "Version",
      "Tier",
      "Reason (one line)",
    ].join(" | ") + " |";
  const sep = "|---|---|---|---|---|";
  const rows = entries.map(
    (e) => `${e.name} | \`${e.dir}\` | ${e.version} | ${e.tier} | ${e.reason} |`,
  );
  return [header, sep, ...rows].join("\n");
}

export function generateStatusFile(entries) {
  return `<!-- This file is generated by scripts/gen-status.mjs. Do not edit by hand. -->

# STATUS — package tiers

A snapshot of every pnpm workspace package (each \`package.json\` under the workspace globs in \`pnpm-workspace.yaml\`), classified into exactly one tier. Totals are not written here, so two pull requests that each add a package merge without leaving this file stale; run \`node scripts/gen-status.mjs --stats\` for the counts.

## Classification rule

1. Packages on the explicit dead-package override list in \`scripts/gen-status.mjs\` (verified zero-dependent in the workspace) → \`archived\`. The override wins over the \`adapters/**\` path rule.
2. \`adapters/**\` (not on the override list) → \`adapters\`.
3. The core runtime family — \`runtime\`, \`cli\`, \`driver\` (core), the \`sandbox\` family, \`auth\`, \`model-catalog\` and their runtime neighbours — → \`core\`.
4. Spec-only / doctype-only packages: reference implementations of AIP file formats whose workspace dependencies resolve (transitively) only to the doctype meta-factory \`@agentproto/doctype\` (plus the deprecated \`@agentproto/define-doctype\` shim), the generic doctype verbs \`@agentproto/manifest\` and build tooling \`@agentproto/tooling\` -> \`spec-reference\`.
5. Everything else → \`core\`.

Each package appears exactly once; tiers are applied in the order above.

## Package table

${renderTable(entries)}
`;
}

function main() {
  const entries = computeStatus();
  const markdown = generateStatusFile(entries);
  const outfile = "STATUS.md";

  if (process.argv.includes("--count")) {
    console.log(entries.length);
    return;
  }
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(outfile, "utf8");
    } catch {
      console.error(`${outfile} is missing`);
      process.exit(1);
    }
    if (current !== markdown) {
      console.error(`${outfile} is out of date — run: node scripts/gen-status.mjs`);
      const currentLines = current.split("\n");
      const expectedLines = markdown.split("\n");
      for (let i = 0; i < Math.max(currentLines.length, expectedLines.length); i++) {
        if (currentLines[i] !== expectedLines[i]) {
          console.error(`first differing line ${i + 1}:`);
          console.error(`  STATUS.md:   ${JSON.stringify(currentLines[i])}`);
          console.error(`  generated:   ${JSON.stringify(expectedLines[i])}`);
          break;
        }
      }
      process.exit(1);
    }
    console.log(`${outfile} is up to date (${entries.length} packages)`);
    return;
  }
  if (process.argv.includes("--stats")) {
    const counts = {};
    for (const e of entries) counts[e.tier] = (counts[e.tier] || 0) + 1;
    for (const [tier, n] of Object.entries(counts)) console.log(`${tier}: ${n}`);
    console.log(`total: ${entries.length}`);
    return;
  }
  writeFileSync(outfile, markdown);
  console.log(`wrote ${outfile} (${entries.length} packages)`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
