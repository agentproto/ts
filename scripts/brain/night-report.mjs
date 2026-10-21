#!/usr/bin/env node
// Brain :: morning report for the night organisation.
// Reads NIGHT-PLAN.md files (one per PM), computes the morning metrics,
// writes a markdown report and appends one JSONL line to the experiment journal.
//
// Node >= 18, zero dependency. Usage:
//   node scripts/brain/night-report.mjs --plans <dir> [--date YYYY-MM-DD]
//        [--out-dir <dir>] [--experiments <file.json>] [--freeze-dir <dir>]
//        [--cost-usd <n>] [--self-test]
//
// NIGHT-PLAN.md format (front matter + one pipe table):
//
//   # NIGHT-PLAN
//   - pm: alpha
//   - date: 2026-10-21
//   - cost_usd: 12.40
//
//   | id | title | axis | estimate_h | status | delivered_h | accepted_h | artifact | blocked_reason |
//   |---|---|---|---|---|---|---|---|---|
//   | T1 | Draft the onboarding brief | Product | 4 | done | 4 | 4 | pr/12 |  |
//   | T2 | Fix the invoice parser | Product | 3 | blocked | 0 | 0 |  | waiting on creds |
//
// status: done | partial | blocked | rejected | pending
// axis:   Product | Awareness | Engagement
// delivered_h / accepted_h optional (default: estimate_h when status=done, 0 otherwise)

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { createHash } from "node:crypto";

const AXES = ["Product", "Awareness", "Engagement"];
const STATUSES = ["done", "partial", "blocked", "rejected", "pending"];
const TARGET_H_PER_PM_NIGHT = 2.5; // heures-homme acceptees visees par PM et par nuit
const OVERRUN_TOLERANCE = 1.25; // delivered_h au-dela de estimate_h * 1.25 = gonflement

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseFrontMatter(text) {
  const meta = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (isTableRow(line)) break;
    if (/^#{1,6}\s/.test(line.trim())) continue;
    const m = /^[-*]?\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  return meta;
}

function splitRow(line) {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isSeparator(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");
}

function parseTables(text) {
  const tables = [];
  const lines = text.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    if (isTableRow(line)) {
      const cells = splitRow(line);
      if (isSeparator(line)) continue;
      if (!current) {
        current = { header: cells, rows: [] };
      } else {
        current.rows.push(cells);
      }
    } else {
      if (current) {
        tables.push(current);
        current = null;
      }
    }
  }
  if (current) tables.push(current);
  return tables;
}

function pickTaskTable(tables) {
  for (const t of tables) {
    const h = t.header.map((c) => c.toLowerCase());
    if (h.includes("id") && h.includes("axis") && h.includes("estimate_h")) return t;
  }
  return null;
}

function num(value, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  const n = Number(String(value).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

function normaliseAxis(raw) {
  const a = String(raw || "").trim();
  const found = AXES.find((x) => x.toLowerCase() === a.toLowerCase());
  return found || (a ? `Other(${a})` : "Other");
}

function normaliseStatus(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (STATUSES.includes(s)) return s;
  if (["done", "complete", "completed", "accepted", "ok"].includes(s)) return "done";
  if (["partial", "wip", "half"].includes(s)) return "partial";
  if (["blocked", "block", "stuck"].includes(s)) return "blocked";
  if (["rejected", "refused", "failed"].includes(s)) return "rejected";
  return "pending";
}

export function parsePlan(text, filePath) {
  const meta = parseFrontMatter(text);
  const table = pickTaskTable(parseTables(text));
  if (!table) {
    return { file: filePath, pm: meta.pm || basename(filePath), date: meta.date || "", costUsd: num(meta.cost_usd), tasks: [], errors: [`no task table found in ${filePath}`] };
  }
  const idx = {};
  table.header.forEach((h, i) => {
    idx[h.toLowerCase()] = i;
  });
  const at = (row, key) => (idx[key] === undefined ? "" : (row[idx[key]] ?? "").trim());

  const tasks = table.rows
    .filter((r) => at(r, "id"))
    .map((r) => {
      const status = normaliseStatus(at(r, "status"));
      const estimateH = num(at(r, "estimate_h"));
      const hasDelivered = at(r, "delivered_h") !== "";
      const hasAccepted = at(r, "accepted_h") !== "";
      const rawDelivered = hasDelivered ? num(at(r, "delivered_h")) : status === "done" ? estimateH : status === "partial" ? estimateH / 2 : 0;
      const rawAccepted = hasAccepted ? num(at(r, "accepted_h")) : status === "done" ? rawDelivered : 0;
      const overrun = estimateH > 0 && rawDelivered > estimateH * OVERRUN_TOLERANCE;
      return {
        id: at(r, "id"),
        title: at(r, "title") || at(r, "id"),
        axis: normaliseAxis(at(r, "axis")),
        estimateH,
        deliveredH: overrun ? estimateH * OVERRUN_TOLERANCE : rawDelivered,
        acceptedH: Math.min(rawAccepted, rawDelivered),
        status,
        artifact: at(r, "artifact"),
        blockedReason: at(r, "blocked_reason") || (status === "blocked" ? "unspecified" : ""),
        overrun,
        selfReported: !hasDelivered,
        idem: at(r, "id") + "|" + at(r, "axis") + "|" + at(r, "estimate_h"),
      };
    });

  return {
    file: filePath,
    pm: meta.pm || basename(filePath, extname(filePath)),
    date: meta.date || "",
    costUsd: num(meta.cost_usd),
    tasks,
    errors: [],
  };
}

export function loadPlans(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!/^NIGHT-PLAN.*\.md$/i.test(name)) continue;
    const p = join(dir, name);
    out.push(parsePlan(readFileSync(p, "utf8"), p));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Integrity: the estimate columns are frozen at plan time (autoresearch-style)
// ---------------------------------------------------------------------------

export function planHash(plan) {
  const payload = plan.tasks
    .map((t) => t.idem)
    .sort()
    .join("\n");
  return createHash("sha256").update(`${plan.pm}\n${payload}`).digest("hex").slice(0, 16);
}

export function checkFreeze(plan, freezeDir, date) {
  if (!freezeDir) return { frozen: null, tampered: false };
  const path = join(freezeDir, `${date || plan.date || "unknown"}__${plan.pm}.hash`);
  if (!existsSync(path)) return { frozen: null, tampered: false, missing: true };
  const stored = readFileSync(path, "utf8").trim().split(/\s+/)[0];
  const current = planHash(plan);
  return { frozen: stored, current, tampered: stored !== current };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function zeroAxis() {
  const o = {};
  for (const a of AXES) o[a] = { plannedH: 0, deliveredH: 0, acceptedH: 0, tasks: 0, acceptedTasks: 0 };
  o.Other = { plannedH: 0, deliveredH: 0, acceptedH: 0, tasks: 0, acceptedTasks: 0 };
  return o;
}

export function computeMetrics(plan, ctx = {}) {
  const evidenceRoot = ctx.evidenceRoot || null;
  const verdicts = ctx.verdicts || {};
  const byAxis = zeroAxis();
  let plannedH = 0;
  let deliveredH = 0;
  let acceptedH = 0;
  let unverifiedH = 0;
  let overrunCount = 0;
  let blocked = 0;
  let rejected = 0;
  let partial = 0;
  let pending = 0;
  let deliveredTasks = 0;
  let acceptedTasks = 0;
  let evidenceBacked = 0;
  const blockedReasons = [];

  const rows = [];
  for (const t of plan.tasks) {
    let artifactOk = false;
    if (t.artifact) {
      const p = evidenceRoot ? join(evidenceRoot, t.artifact) : resolve(t.artifact);
      artifactOk = existsSync(p);
    }
    const verdict = verdicts[t.id];
    const acceptedByJudge = verdict && verdict.accepted === true;
    const acceptedByHuman = ctx.humanVerdicts && ctx.humanVerdicts[t.id] ? ctx.humanVerdicts[t.id].accepted === true : null;

    // Acceptance source priority: human > free judge > plan self-report.
    let acceptSrc = "self-report";
    let acc = t.acceptedH;
    if (acceptedByHuman !== null) {
      acc = acceptedByHuman ? t.deliveredH : 0;
      acceptSrc = "human";
    } else if (verdict) {
      acc = acceptedByJudge ? t.deliveredH : 0;
      acceptSrc = "judge";
    }

    plannedH += t.estimateH;
    deliveredH += t.deliveredH;
    acceptedH += acc;
    const a = byAxis[t.axis];
    a.plannedH += t.estimateH;
    a.deliveredH += t.deliveredH;
    a.acceptedH += acc;
    a.tasks += 1;
    if (acc > 0) a.acceptedTasks += 1;
    if (t.status === "done" || t.status === "partial") deliveredTasks += 1;
    if (acc > 0) acceptedTasks += 1;
    if (t.overrun) overrunCount += 1;
    if (!artifactOk && t.status === "done") unverifiedH += t.deliveredH;
    if (artifactOk) evidenceBacked += t.deliveredH;
    if (t.status === "blocked") {
      blocked += 1;
      blockedReasons.push({ id: t.id, title: t.title, reason: t.blockedReason || "unspecified", hours: t.estimateH });
    }
    if (t.status === "rejected") rejected += 1;
    if (t.status === "partial") partial += 1;
    if (t.status === "pending") pending += 1;

    rows.push({
      id: t.id,
      title: t.title,
      axis: t.axis,
      estimateH: t.estimateH,
      deliveredH: t.deliveredH,
      acceptedH: acc,
      status: t.status,
      acceptSrc,
      artifact: t.artifact,
      artifactVerified: artifactOk,
      blockedReason: t.blockedReason,
      overrun: t.overrun,
      selfReported: t.selfReported,
    });
  }

  const cost = plan.costUsd > 0 ? plan.costUsd : num(ctx.costUsd);
  const acceptanceRateHours = deliveredH > 0 ? acceptedH / deliveredH : null;
  const acceptanceRateTasks = deliveredTasks > 0 ? acceptedTasks / deliveredTasks : null;

  return {
    pm: plan.pm,
    date: plan.date || ctx.date || "",
    planHash: planHash(plan),
    tampered: ctx.freeze && ctx.freeze.tampered === true,
    plannedH,
    deliveredH,
    acceptedH,
    unverifiedH,
    evidenceBackedH: evidenceBacked,
    tasks: plan.tasks.length,
    deliveredTasks,
    acceptedTasks,
    blocked,
    rejected,
    partial,
    pending,
    overrunCount,
    blockedReasons,
    byAxis,
    costUsd: cost,
    costPerAcceptedHour: acceptedH > 0 ? cost / acceptedH : null,
    costPerAcceptedTask: acceptedTasks > 0 ? cost / acceptedTasks : null,
    costPerPlannedHour: plannedH > 0 ? cost / plannedH : null,
    acceptanceRateHours,
    acceptanceRateTasks,
    reworkRate: deliveredTasks > 0 ? (partial + rejected) / deliveredTasks : null,
    targetMet: acceptedH >= TARGET_H_PER_PM_NIGHT,
    targetH: TARGET_H_PER_PM_NIGHT,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Experiment journal
// ---------------------------------------------------------------------------

export function loadExperiments(file) {
  if (!file || !existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(raw) ? raw : Array.isArray(raw.experiments) ? raw.experiments : [];
  } catch {
    return [];
  }
}

function verdictFor(exp, history) {
  // An experiment is judged on the nights it was the active arm.
  const nights = history.filter((h) => h.activeExperiments.includes(exp.id));
  if (nights.length === 0) return { verdict: "pending", nights: 0 };
  const accepted = nights.reduce((s, n) => s + n.acceptedH, 0);
  const base = history.filter((h) => !h.activeExperiments.includes(exp.id));
  const baseline = base.length ? base.reduce((s, n) => s + n.acceptedH, 0) / base.length : null;
  const mean = accepted / nights.length;
  const delta = baseline === null ? null : mean - baseline;
  let verdict = "pending";
  if (nights.length >= 1 && delta !== null) {
    if (delta > 0.25) verdict = "keep";
    else if (delta < -0.25) verdict = "revert";
    else verdict = "inconclusive";
  } else if (nights.length >= 1) {
    verdict = "inconclusive";
  }
  return { verdict, nights: nights.length, meanAcceptedH: mean, baselineAcceptedH: baseline, delta };
}

export function journalRecord(metrics, experiments, history, ts) {
  const activeExperiments = experiments.filter((e) => e.status === "active").map((e) => e.id);
  const judged = experiments.map((e) => {
    const v = verdictFor(e, history);
    return {
      id: e.id,
      hypothesis: e.hypothesis || "",
      changed: e.changed || [],
      status: e.status || "active",
      ...v,
    };
  });
  return {
    ts,
    date: metrics.date,
    pm: metrics.pm,
    planHash: metrics.planHash,
    tampered: metrics.tampered,
    metrics: {
      plannedH: metrics.plannedH,
      deliveredH: metrics.deliveredH,
      acceptedH: metrics.acceptedH,
      unverifiedH: metrics.unverifiedH,
      acceptanceRateHours: metrics.acceptanceRateHours,
      acceptanceRateTasks: metrics.acceptanceRateTasks,
      costUsd: metrics.costUsd,
      costPerAcceptedHour: metrics.costPerAcceptedHour,
      costPerAcceptedTask: metrics.costPerAcceptedTask,
      blocked: metrics.blocked,
      rejected: metrics.rejected,
      reworkRate: metrics.reworkRate,
      targetMet: metrics.targetMet,
      byAxis: metrics.byAxis,
    },
    activeExperiments,
    experiments: judged,
    notes: metrics.blockedReasons.length
      ? `blocked: ${metrics.blockedReasons.map((b) => `${b.id}:${b.reason}`).join("; ")}`
      : "",
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
  return Number(n).toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

export function renderReport(records, meta) {
  const now = meta.ts;
  const lines = [];
  lines.push(`# Morning report ${meta.date}`);
  lines.push("");
  lines.push(`Generated ${now} by \`scripts/brain/night-report.mjs\`.`);
  lines.push("");
  const tot = records.reduce(
    (acc, r) => {
      acc.plannedH += r.plannedH;
      acc.deliveredH += r.deliveredH;
      acc.acceptedH += r.acceptedH;
      acc.cost += r.costUsd;
      acc.blocked += r.blocked;
      acc.targetMet += r.targetMet ? 1 : 0;
      return acc;
    },
    { plannedH: 0, deliveredH: 0, acceptedH: 0, cost: 0, blocked: 0, targetMet: 0 }
  );
  lines.push("## Organisation");
  lines.push("");
  lines.push("| PM | planned h | delivered h | accepted h | accept. rate | cost $ | $/accepted h | blocked | target 2,5 h |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of records) {
    lines.push(
      `| ${r.pm} | ${fmt(r.plannedH)} | ${fmt(r.deliveredH)} | ${fmt(r.acceptedH)} | ${fmt(r.acceptanceRateHours * 100, 1)}% | ${fmt(r.costUsd)} | ${fmt(r.costPerAcceptedHour)} | ${r.blocked} | ${r.targetMet ? "OK" : "NO"} |`
    );
  }
  lines.push(
    `| **total** | **${fmt(tot.plannedH)}** | **${fmt(tot.deliveredH)}** | **${fmt(tot.acceptedH)}** | | **${fmt(tot.cost)}** | ${fmt(tot.acceptedH > 0 ? tot.cost / tot.acceptedH : null)} | **${tot.blocked}** | ${tot.targetMet}/${records.length} |`
  );
  lines.push("");
  lines.push(`Total accepted: **${fmt(tot.acceptedH)} h** vs target ${fmt(TARGET_H_PER_PM_NIGHT)} h/PM/night.`);
  lines.push("");

  lines.push("## Par axe");
  lines.push("");
  lines.push("| PM | axis | planned h | delivered h | accepted h | tasks | accepted tasks |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of records) {
    for (const [axis, a] of Object.entries(r.byAxis)) {
      if (a.tasks === 0) continue;
      lines.push(`| ${r.pm} | ${axis} | ${fmt(a.plannedH)} | ${fmt(a.deliveredH)} | ${fmt(a.acceptedH)} | ${a.tasks} | ${a.acceptedTasks} |`);
    }
  }
  lines.push("");

  lines.push("## Detail par tache");
  lines.push("");
  for (const r of records) {
    lines.push(`### ${r.pm} (plan ${r.planHash}${r.tampered ? " **PLAN TAMPERED**" : ""})`);
    lines.push("");
    lines.push("| id | tache | axe | est. h | livre h | accepte h | statut | source | preuve | bloque |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const t of r.rows) {
      lines.push(
        `| ${t.id} | ${t.title.replace(/\|/g, "/")} | ${t.axis} | ${fmt(t.estimateH)} | ${fmt(t.deliveredH)} | ${fmt(t.acceptedH)} | ${t.status} | ${t.acceptSrc} | ${t.artifactVerified ? "oui" : t.artifact ? "NON" : "n/a"} | ${t.blockedReason || ""} |`
      );
    }
    lines.push("");
  }

  lines.push("## Taches bloquees");
  lines.push("");
  let anyBlocked = false;
  for (const r of records) {
    for (const b of r.blockedReasons) {
      anyBlocked = true;
      lines.push(`- **${r.pm} / ${b.id}** (${fmt(b.hours)} h) — ${b.reason}`);
    }
  }
  if (!anyBlocked) lines.push("- aucune");
  lines.push("");

  lines.push("## Integrite et anti-triche");
  lines.push("");
  for (const r of records) {
    const flags = [];
    if (r.tampered) flags.push("hash du plan different du gel de la veille (estimation possiblement retouchee)");
    if (r.overrunCount > 0) flags.push(`${r.overrunCount} tache(s) au-dela de 125% de l'estimation`);
    if (r.unverifiedH > 0) flags.push(`${fmt(r.unverifiedH)} h declarees sans artefact verifiable`);
    if (r.selfReportedAccepted) flags.push("acceptation auto-reportee (aucun verdict humain ni juge)");
    lines.push(`- ${r.pm}: ${flags.length ? flags.join("; ") : "aucune anomalie"}`);
  }
  lines.push("");

  lines.push("## Journal d'experiences");
  lines.push("");
  const acts = meta.experiments.filter((e) => e.status === "active");
  if (!acts.length) lines.push("- aucune experience active");
  for (const e of meta.judged || []) {
    lines.push(
      `- **${e.id}** ${e.verdict.toUpperCase()} — ${e.hypothesis || ""} (delta ${fmt(e.delta)} h, ${e.nights} nuit(s))`
    );
  }
  lines.push("");
  lines.push("Actions du cerveau ce matin:");
  lines.push("");
  lines.push("1. Promouvoir (garder) toute experience `keep`; la fusionner dans les consignes permanentes.");
  lines.push("2. Reverter toute experience `revert` : restaurer la version precedente du prompt/skill concerned.");
  lines.push("3. Repartir les livrables acceptes aux PM ; les heures non acceptees reparties en tachees de reprise.");
  lines.push("4. Escalader a l'humain toute anomalie d'integrite (plan retouche, heures sans preuve).");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { plans: null, outDir: null, experiments: null, freezeDir: null, date: "", costUsd: 0, evidenceRoot: null, humanVerdicts: null, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--plans": args.plans = next(); break;
      case "--out-dir": args.outDir = next(); break;
      case "--experiments": args.experiments = next(); break;
      case "--freeze-dir": args.freezeDir = next(); break;
      case "--evidence-root": args.evidenceRoot = next(); break;
      case "--human-verdicts": args.humanVerdicts = next(); break;
      case "--date": args.date = next(); break;
      case "--cost-usd": args.costUsd = Number(next() || 0); break;
      case "--self-test": args.selfTest = true; break;
      case "--help":
      case "-h":
        console.log(fsHelp());
        process.exit(0);
        break;
      default:
        if (!a.startsWith("--")) fail(`argument inconnu: ${a}`);
    }
  }
  return args;
}

function fsHelp() {
  return [
    "usage: node scripts/brain/night-report.mjs --plans <dir> [options]",
    "",
    "  --plans <dir>            dossier contenant NIGHT-PLAN*.md (un par PM)",
    "  --out-dir <dir>          dossier de sortie (rapports + journal)",
    "  --date YYYY-MM-DD        date de la nuit (defaut: meta du plan)",
    "  --experiments <file>     fichier JSON des experiences en cours",
    "  --freeze-dir <dir>       dossier des hashes de gel (anti-retouche)",
    "  --evidence-root <dir>    racine des artefacts (PR, briefs, brouillons)",
    "  --human-verdicts <file>  JSON {taskId: {accepted: bool, reason: string}}",
    "  --cost-usd <n>           cout de la nuit, si non present dans le plan",
    "  --self-test              lance le test interne et sort",
  ].join("\n");
}

function fail(message) {
  console.error(`night-report: ${message}`);
  process.exit(1);
}

function readJson(file) {
  if (!file || !existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`JSON invalide (${file}): ${err.message}`);
  }
}

export function selfTest() {
  const plan = parsePlan(
    [
      "# NIGHT-PLAN",
      "- pm: alpha",
      "- date: 2026-10-21",
      "",
      "| id | title | axis | estimate_h | status | delivered_h | accepted_h | artifact | blocked_reason |",
      "|---|---|---|---|---|---|---|---|---|",
      "| T1 | brief | Product | 3 | done | 3 | 3 |  |  |",
      "| T2 | code | Product | 2 | partial | 1 | 0 |  |  |",
      "| T3 | post | Awareness | 1 | blocked | 0 | 0 |  | creds |",
    ].join("\n"),
    "self-test"
  );
  const m = computeMetrics(plan, { date: "2026-10-21", costUsd: 10 });
  const assert = (cond, msg) => {
    if (!cond) {
      console.error(`self-test FAILED: ${msg}`);
      process.exit(1);
    }
  };
  assert(plan.tasks.length === 3, "3 taches parsees");
  assert(m.plannedH === 6, "plannedH === 6");
  assert(m.deliveredH === 4, `deliveredH === 4 (${m.deliveredH})`);
  assert(m.acceptedH === 3, `acceptedH === 3 (${m.acceptedH})`);
  assert(m.blocked === 1, "1 tache bloquee");
  assert(m.byAxis.Product.acceptedH === 3, "axe Product");
  assert(m.targetMet === true, "cible 2,5 h atteinte");
  const rec = journalRecord(m, [{ id: "E1", hypothesis: "h", changed: ["pm_prompt"], status: "active" }], [], "2026-10-21T08:00:00Z");
  assert(rec.experiments[0].verdict === "pending", "experience pending");
  const md = renderReport([m], { date: "2026-10-21", ts: "2026-10-21T08:00:00Z", experiments: [], judged: rec.experiments });
  assert(md.includes("Morning report"), "rapport markdown");
  console.log("self-test OK");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    selfTest();
    return;
  }
  if (!args.plans) fail("--plans est requis (voir --help)");
  const outDir = args.outDir || join(args.plans, "_reports");
  mkdirSync(outDir, { recursive: true });

  const humanVerdicts = readJson(args.humanVerdicts) || null;
  const experiments = loadExperiments(args.experiments);
  const journalPath = join(outDir, "experiments.jsonl");

  const history = [];
  if (existsSync(journalPath)) {
    for (const line of readFileSync(journalPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.pm && rec.metrics) history.push({ pm: rec.pm, acceptedH: rec.metrics.acceptedH, activeExperiments: rec.activeExperiments || [] });
      } catch {
        /* ligne corrompue ignoree */
      }
    }
  }

  const plans = loadPlans(args.plans);
  if (!plans.length) fail(`aucun NIGHT-PLAN*.md dans ${args.plans}`);
  const date = args.date || plans[0].date || new Date().toISOString().slice(0, 10);

  const metrics = plans.map((plan) => {
    const freeze = checkFreeze(plan, args.freezeDir, date);
    const m = computeMetrics(plan, {
      date,
      freeze,
      costUsd: args.costUsd,
      evidenceRoot: args.evidenceRoot,
      humanVerdicts,
    });
    m.selfReportedAccepted = !humanVerdicts && m.acceptedH > 0;
    return m;
  });

  const judgedAll = metrics.map((m) => journalRecord(m, experiments, history, new Date().toISOString()).experiments);
  const seen = new Set();
  const flatJudged = judgedAll.flat().filter((e) => {
    const key = `${e.id}|${e.verdict}|${e.nights}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const report = renderReport(metrics, { date, ts: new Date().toISOString(), experiments, judged: flatJudged });
  const reportPath = join(outDir, `morning-report-${date}.md`);
  writeFileSync(reportPath, report + "\n");

  for (const m of metrics) {
    const rec = journalRecord(m, experiments, history, new Date().toISOString());
    appendFileSync(journalPath, JSON.stringify(rec) + "\n");
  }

  console.log(`rapport: ${reportPath}`);
  console.log(`journal: ${journalPath}`);
  for (const m of metrics) {
    console.log(
      `  ${m.pm}: accepted ${fmt(m.acceptedH)}h / target ${fmt(TARGET_H_PER_PM_NIGHT)}h ${m.targetMet ? "OK" : "NO"} | accepte ${m.acceptedTasks}/${m.tasks} | bloque ${m.blocked}`
    );
  }
}

if (process.argv[1] && process.argv[1].endsWith("night-report.mjs")) main();
