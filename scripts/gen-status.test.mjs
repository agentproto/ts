import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeStatus, generateStatusFile } from "./gen-status.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const STATUS_PATH = path.join(REPO_ROOT, "STATUS.md");

/**
 * Independent recount of workspace package dirs under the globs in
 * pnpm-workspace.yaml — deliberately does NOT call computeStatus(), so the
 * "exactly once" assertion compares the classifier against an outside
 * source of truth rather than against itself.
 */
function independentWorkspaceDirs(root = REPO_ROOT) {
  const yaml = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const globs = [...yaml.matchAll(/^\s*-\s*["']([^"']+)["']/gm)].map(
    (m) => m[1],
  );
  assert.ok(globs.length > 0, "pnpm-workspace.yaml declared no package globs");
  const dirs = [];
  for (const glob of globs) {
    const parentRel = path.posix.dirname(glob);
    const parent = path.join(root, parentRel);
    let entries;
    try {
      entries = readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirRel = path.posix.join(parentRel, entry.name);
      try {
        readFileSync(path.join(root, dirRel, "package.json"));
        dirs.push(dirRel);
      } catch {
        // no package.json — not a workspace package
      }
    }
  }
  return dirs.sort();
}

test("every workspace package is classified exactly once", () => {
  const expectedDirs = independentWorkspaceDirs();
  assert.ok(expectedDirs.length > 0, "independent walk found no packages");
  const entries = computeStatus(REPO_ROOT);
  assert.equal(
    entries.length,
    expectedDirs.length,
    `computeStatus returned ${entries.length} entries; pnpm-workspace.yaml globs cover ${expectedDirs.length} package.json files`,
  );
  const seenDirs = new Set();
  const seenNames = new Set();
  for (const e of entries) {
    assert.ok(!seenDirs.has(e.dir), `duplicate entry for dir ${e.dir}`);
    assert.ok(!seenNames.has(e.name), `duplicate entry for name ${e.name}`);
    seenDirs.add(e.dir);
    seenNames.add(e.name);
  }
  assert.deepStrictEqual([...seenDirs].sort(), expectedDirs);
});

test("computeStatus(root) reads packages under root, not process.cwd()", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "gen-status-root-"));
  try {
    mkdirSync(path.join(tmp, "packages", "fake-pkg"), { recursive: true });
    writeFileSync(
      path.join(tmp, "packages", "fake-pkg", "package.json"),
      JSON.stringify({
        name: "@agentproto/fake-pkg",
        version: "9.9.9",
        dependencies: {},
      }),
    );
    mkdirSync(path.join(tmp, "adapters", "fake-adapter"), {
      recursive: true,
    });
    writeFileSync(
      path.join(tmp, "adapters", "fake-adapter", "package.json"),
      JSON.stringify({ name: "@agentproto/fake-adapter", version: "1.0.0" }),
    );
    // On a tree where workspaceDirs() ignored `root`, this would either
    // throw ENOENT (reading the real repo's packages under tmp) or return
    // the real repo's 156 packages instead of the 2 fixtures.
    const entries = computeStatus(tmp);
    const byName = new Map(entries.map((e) => [e.name, e]));
    assert.equal(entries.length, 2);
    assert.equal(byName.get("@agentproto/fake-pkg").tier, "core");
    assert.equal(byName.get("@agentproto/fake-pkg").version, "9.9.9");
    assert.equal(byName.get("@agentproto/fake-adapter").tier, "adapters");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("both doctype package names seed the spec-reference closure", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "gen-status-doctype-seed-"));
  try {
    mkdirSync(path.join(tmp, "packages", "doctype"), { recursive: true });
    writeFileSync(
      path.join(tmp, "packages", "doctype", "package.json"),
      JSON.stringify({
        name: "@agentproto/doctype",
        version: "0.1.4",
        devDependencies: { "@agentproto/tooling": "workspace:*" },
      }),
    );
    mkdirSync(path.join(tmp, "packages", "consumer"), { recursive: true });
    writeFileSync(
      path.join(tmp, "packages", "consumer", "package.json"),
      JSON.stringify({
        name: "@agentproto/consumer",
        version: "1.0.0",
        dependencies: { "@agentproto/doctype": "workspace:*" },
      }),
    );
    const byName = new Map(
      computeStatus(tmp).map((e) => [e.name, e]),
    );
    assert.equal(byName.get("@agentproto/doctype").tier, "spec-reference");
    assert.equal(byName.get("@agentproto/consumer").tier, "spec-reference");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("tier is one of the four canonical tiers", () => {
  for (const e of computeStatus(REPO_ROOT)) {
    assert.ok(
      ["core", "adapters", "spec-reference", "archived"].includes(e.tier),
      `bad tier ${e.tier} for ${e.dir}`,
    );
  }
});

test("archived override packages remain zero-dependent", () => {
  const entries = computeStatus(REPO_ROOT); // throws if any archived pkg has dependents
  const archived = entries.filter((e) => e.tier === "archived");
  assert.deepStrictEqual(
    archived.map((e) => e.name).sort(),
    [
      "@agentproto/adapter-ai-sdk",
      "@agentproto/adapter-mastra",
      "@agentproto/catalog",
      "@agentproto/driver-sdk",
      "@agentproto/egress",
      "@agentproto/identity",
      "@agentproto/role-catalog",
      "@agentproto/workflow-ai-sdk",
    ],
  );
});

test("documented rule order: archived override wins over adapters/** path", () => {
  const entries = computeStatus(REPO_ROOT);
  const byName = new Map(entries.map((e) => [e.name, e]));
  // Two override-list packages live under adapters/; the documented order
  // (archived first) must classify them archived, not adapters.
  assert.equal(byName.get("@agentproto/adapter-ai-sdk").tier, "archived");
  assert.equal(byName.get("@agentproto/adapter-mastra").tier, "archived");
  for (const e of entries) {
    if (!e.dir.startsWith("adapters/")) continue;
    if (e.tier === "archived") {
      assert.ok(
        ["@agentproto/adapter-ai-sdk", "@agentproto/adapter-mastra"].includes(
          e.name,
        ),
        `${e.name} (${e.dir}) is under adapters/ but neither on the override list nor tier adapters`,
      );
    } else {
      assert.equal(
        e.tier,
        "adapters",
        `${e.dir} is under adapters/ and not archived; expected tier adapters, got ${e.tier}`,
      );
    }
  }
});

test("status table has exactly one row per package in STATUS.md", () => {
  const entries = computeStatus(REPO_ROOT);
  const md = readFileSync(STATUS_PATH, "utf8");
  // Package-table rows: `name | `dir` | tier | reason |`
  // (names are usually @agentproto/… but four first-party packages are bare.)
  const rowRe = /^([^\s|`]+) \| `([^`]+)` \| ([^\s|]+) \| (.+) \|$/gm;
  const rows = [];
  for (const m of md.matchAll(rowRe)) {
    rows.push({ name: m[1], dir: m[2], tier: m[3] });
  }
  assert.ok(rows.length > 0, "STATUS.md package table is empty/unparseable");
  assert.equal(
    rows.length,
    entries.length,
    `STATUS.md has ${rows.length} package rows; computeStatus returned ${entries.length}`,
  );
  const fromMd = new Map(rows.map((r) => [r.dir, r]));
  assert.equal(fromMd.size, rows.length, "duplicate dir rows in STATUS.md");
  for (const e of entries) {
    const row = fromMd.get(e.dir);
    assert.ok(row, `STATUS.md is missing a row for ${e.dir}`);
    assert.equal(row.name, e.name, `name mismatch for ${e.dir}`);
    assert.equal(row.tier, e.tier, `tier mismatch for ${e.dir}`);
  }
});

test("bumping a package version leaves the generated STATUS.md unchanged", () => {
  // Releases bump package.json versions without regenerating STATUS.md.
  // If the table carried versions, every Version PR would leave main red.
  const tmp = mkdtempSync(path.join(tmpdir(), "gen-status-version-bump-"));
  try {
    const pkgDir = path.join(tmp, "packages", "fake-pkg");
    mkdirSync(pkgDir, { recursive: true });
    const writePkg = (version) =>
      writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({
          name: "@agentproto/fake-pkg",
          version,
          dependencies: {},
        }),
      );
    writePkg("1.0.0");
    const before = generateStatusFile(computeStatus(tmp));
    writePkg("2.0.0");
    const after = generateStatusFile(computeStatus(tmp));
    assert.equal(after, before);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("adding a package changes STATUS.md by exactly one added table row", () => {
  // Two PRs that each add a package must merge into a correct STATUS.md.
  // That only holds if no line depends on the whole package set (totals,
  // tier counts): each PR then contributes one row and git merges them.
  const entries = computeStatus(REPO_ROOT);
  const extra = {
    name: "@agentproto/zz-fake",
    dir: "packages/zz-fake",
    version: "0.0.0",
    tier: "core",
    reason: "product runtime package consumed by the runtime/cli",
  };
  const before = generateStatusFile(entries).split("\n");
  const after = generateStatusFile([...entries, extra]).split("\n");
  assert.equal(after.length, before.length + 1);
  const removed = before.filter((line) => !after.includes(line));
  const added = after.filter((line) => !before.includes(line));
  assert.deepStrictEqual(removed, []);
  assert.deepStrictEqual(added, [
    "@agentproto/zz-fake | `packages/zz-fake` | core | product runtime package consumed by the runtime/cli |",
  ]);
});

test("generateStatusFile output matches committed STATUS.md (no drift)", () => {
  const entries = computeStatus(REPO_ROOT);
  const expected = generateStatusFile(entries);
  const actual = readFileSync(STATUS_PATH, "utf8");
  assert.equal(
    actual,
    expected,
    "STATUS.md is out of date — run: node scripts/gen-status.mjs",
  );
});
