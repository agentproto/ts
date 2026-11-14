import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  generateSpecPackagesDoc,
  specPackageRows,
} from "./gen-spec-packages-doc.mjs";

function writePkg(root, dir, pj, schemaTs) {
  mkdirSync(path.join(root, dir, "src"), { recursive: true });
  writeFileSync(path.join(root, dir, "package.json"), JSON.stringify(pj));
  if (schemaTs !== undefined) {
    writeFileSync(path.join(root, dir, "src", "schema.ts"), schemaTs);
  }
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "gen-spec-doc-"));
  const dt = { "@agentproto/doctype": "workspace:*" };
  writePkg(root, "packages/doctype", {
    name: "@agentproto/doctype",
    version: "0.1.0",
    description: "Doctype meta-factory.",
    keywords: ["aip-56", "aip-70"],
  });
  writePkg(
    root,
    "packages/alpha",
    {
      name: "@agentproto/alpha",
      version: "1.2.3",
      description: "Alpha format. Second sentence is dropped.",
      keywords: ["aip-99"],
      dependencies: dt,
    },
    "/**\n * Generated from `resources/aip-7/draft/ALPHA.schema.json` via\n * json-schema-to-zod.\n */\n",
  );
  writePkg(root, "packages/beta", {
    name: "@agentproto/beta",
    version: "0.4.0",
    description: "Beta | format.",
    keywords: ["aip-8", "agentic"],
    dependencies: dt,
  });
  writePkg(root, "packages/gamma", {
    name: "@agentproto/gamma",
    version: "0.0.1",
    description: "Mentions AIP-5 and AIP-6 only in prose.",
    keywords: ["agentic"],
    dependencies: dt,
  });
  writePkg(root, "packages/delta", {
    name: "@agentproto/delta",
    version: "0.0.2",
    keywords: ["aip-1", "aip-2"],
    dependencies: dt,
  });
  writePkg(root, "packages/runtime-ish", {
    name: "@agentproto/runtime-ish",
    version: "5.0.0",
    description: "Runtime package.",
    keywords: ["aip-3"],
    dependencies: { ...dt, "@agentproto/not-a-doctype": "workspace:*" },
  });
  writePkg(root, "packages/not-a-doctype", {
    name: "@agentproto/not-a-doctype",
    version: "1.0.0",
  });
  writePkg(root, "adapters/some-adapter", {
    name: "@agentproto/some-adapter",
    version: "1.0.0",
    keywords: ["aip-45"],
    dependencies: dt,
  });
  return root;
}

test("lists only spec-reference packages", () => {
  const root = fixture();
  try {
    const names = specPackageRows(root).map((r) => r.name);
    assert.deepStrictEqual(names, [
      "@agentproto/alpha",
      "@agentproto/beta",
      "@agentproto/delta",
      "@agentproto/doctype",
      "@agentproto/gamma",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AIP comes from the schema header, then a single keyword, else blank", () => {
  const root = fixture();
  try {
    const byName = new Map(specPackageRows(root).map((r) => [r.name, r]));
    // schema.ts header wins over a disagreeing keyword
    assert.equal(byName.get("@agentproto/alpha").aip, "AIP-7");
    // no schema.ts: the single aip keyword
    assert.equal(byName.get("@agentproto/beta").aip, "AIP-8");
    // prose mentions are never used
    assert.equal(byName.get("@agentproto/gamma").aip, "");
    // two aip keywords are ambiguous, so blank
    assert.equal(byName.get("@agentproto/delta").aip, "");
    assert.equal(byName.get("@agentproto/doctype").aip, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rendered table has one row per package, first sentence, escaped pipes", () => {
  const root = fixture();
  try {
    const doc = generateSpecPackagesDoc(specPackageRows(root));
    const rows = doc.split("\n").filter((l) => l.startsWith("| @agentproto/"));
    assert.equal(rows.length, 5);
    assert.ok(
      rows.includes(
        "| @agentproto/alpha | `packages/alpha` | AIP-7 | 1.2.3 | Alpha format. |",
      ),
    );
    assert.ok(
      rows.includes(
        "| @agentproto/beta | `packages/beta` | AIP-8 | 0.4.0 | Beta \\| format. |",
      ),
    );
    assert.ok(
      rows.includes("| @agentproto/delta | `packages/delta` |  | 0.0.2 |  |"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
