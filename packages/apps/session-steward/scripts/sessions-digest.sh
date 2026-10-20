#!/usr/bin/env bash
# Digest of the last N hours of agent sessions: what closed, what is in
# progress, what needs the operator's attention. Data comes from the daemon —
# never hand-edited.
#
# Usage: ./scripts/sessions-digest.sh [out.md] [hours]
#   default out: data/digest-latest.md, default hours: 24

set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app_root="$(dirname "$here")"
out="${1:-$app_root/data/digest-latest.md}"
hours="${2:-24}"
mkdir -p "$(dirname "$out")"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -sf http://127.0.0.1:18790/sessions -o "$tmp/sessions.json"

node -e '
const fs = require("fs");
const [out, hours, dir] = process.argv.slice(1);
const now = Date.now();
const since = now - Number(hours) * 3600_000;
const all = JSON.parse(fs.readFileSync(dir + "/sessions.json", "utf8")).sessions;

const ts = (s) => Date.parse(s.lastActivityAt || s.endedAt || s.lastOutputAt || s.startedAt || 0) || 0;
const ago = (t) => {
  const m = Math.round((now - t) / 60000);
  return m < 60 ? m + " min" : m < 1440 ? Math.round(m / 60) + " h" : Math.round(m / 1440) + " j";
};
const one = (v, n = 160) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const alive = (s) => s.status === "running" || s.status === "starting";
const tokensOut = (s) => s.tokensOut ?? s.outcome?.cost?.tokensOut ?? 0;
const origin = (s) => s.origin || (s.parentSessionId ? "sous-agent" : "manuel");
// Noise: scheduled/automated runs are summarised as counts, not listed.
const isAuto = (s) => /^(cron:|gate$|review$|fanout-recon)/.test(s.origin || "");
const name = (s) => one(s.label || s.title || s.id, 70);
const prs = (s) => {
  const refs = new Set();
  for (const a of s.outcome?.artifacts ?? []) if (a.type === "pr" && a.ref) refs.add(a.ref);
  for (const p of s.openedPrs ?? []) refs.add(typeof p === "string" ? p : p.url || p.ref);
  return [...refs].filter(Boolean);
};

const recent = all.filter((s) => s.kind === "agent-cli" && ts(s) >= since);
// Sub-agents roll up under their root; only roots are listed.
const byId = new Map(all.map((s) => [s.id, s]));
const rootOf = (s) => {
  let cur = s;
  for (let i = 0; i < 10 && cur.parentSessionId && byId.has(cur.parentSessionId); i++) cur = byId.get(cur.parentSessionId);
  return cur;
};
const children = new Map();
for (const s of recent) {
  const r = rootOf(s);
  if (r.id !== s.id) children.set(r.id, (children.get(r.id) ?? 0) + 1);
}
// A relaunched chat keeps its label: keep only the newest row per label.
const newest = new Map();
for (const s of recent.filter((s) => !isAuto(s) && rootOf(s).id === s.id)) {
  const k = (s.label || s.id) + "|" + (s.origin || "");
  if (!newest.has(k) || ts(newest.get(k)) < ts(s)) newest.set(k, s);
}
const human = [...newest.values()].sort((a, b) => ts(b) - ts(a));

const attention = [];
const progress = [];
const closed = [];
const dead = [];

for (const s of human) {
  const reasons = [];
  if (s.wrapupFlag) reasons.push("steward: " + s.wrapupFlag.verdict + (s.wrapupFlag.note ? " — " + one(s.wrapupFlag.note, 100) : ""));
  if (alive(s) && s.awaitingInput) reasons.push("attend ta réponse");
  if (alive(s) && s.permissionHold) reasons.push("permission en attente");
  if (alive(s) && s.blockedOn && s.blockedOn !== "command" && s.blockedOn?.kind !== "command") reasons.push("bloquée: " + one(JSON.stringify(s.blockedOn), 80));
  if (alive(s) && s.stalledSinceMs) reasons.push("tour figé depuis " + ago(s.stalledSinceMs));
  if (alive(s) && s.lastTurnErroredAt && (!s.lastActivityAt || s.lastTurnErroredAt >= s.lastActivityAt))
    reasons.push("dernier tour en erreur: " + one(s.lastTurnErrorMessage || "?", 100));
  if (!alive(s) && !s.continuedTo && (s.interrupted || s.interruptedAtBoot || s.outcome?.termination?.midTurn) && s.outcome?.status !== "produced")
    reasons.push("coupée en plein tour sans résultat (" + (s.outcome?.termination?.reason || "restart daemon") + ")");
  const lastText = String(s.activitySummary?.text ?? "").trim();
  if (alive(s) && !s.busy && lastText.slice(-300).includes("?")) reasons.push("finit sur une question");

  if (reasons.length) attention.push({ s, reasons });
  else if (alive(s) && s.busy) progress.push(s);
  else if (alive(s)) progress.push(s);
  else if (s.outcome?.status === "produced" || prs(s).length) closed.push(s);
  else dead.push(s);
}

const row = (s, extra) =>
  "- **" + name(s) + "** `" + s.id + "` · " + (s.adapterSlug || "?") + " · " + origin(s) + " · il y a " + ago(ts(s)) +
  (children.get(s.id) ? " · " + children.get(s.id) + " sous-agents" : "") +
  (extra ? "\n  " + extra : "");
const summary = (s) => one(s.outcome?.summary || s.activitySummary?.text, 220);

const auto = {};
for (const s of recent.filter(isAuto)) {
  const k = s.origin;
  auto[k] ??= { runs: 0, empty: 0, last: 0 };
  auto[k].runs++;
  if (tokensOut(s) === 0 && !alive(s)) auto[k].empty++;
  auto[k].last = Math.max(auto[k].last, ts(s));
}

const md = [
  "# Bilan des " + hours + " dernières heures — " + new Date(now).toISOString(),
  "",
  "Généré par scripts/sessions-digest.sh — ne pas éditer à la main.",
  "",
  "## 🔴 Nécessite ton attention (" + attention.length + ")",
  "",
  ...(attention.length ? attention.map(({ s, reasons }) => row(s, reasons.join(" · ") + (summary(s) ? "\n  > " + summary(s) : ""))) : ["Rien."]),
  "",
  "## 🟡 En cours (" + progress.length + ")",
  "",
  ...(progress.length ? progress.map((s) => row(s, (s.busy ? "en train de travailler" : "au repos") + (summary(s) ? " — " + summary(s) : ""))) : ["Rien."]),
  "",
  "## 🟢 Clôturées avec résultat (" + closed.length + ")",
  "",
  ...(closed.length ? closed.map((s) => row(s, [summary(s), prs(s).join(" ")].filter(Boolean).join("\n  "))) : ["Rien."]),
  "",
  "## ⚪ Terminées sans résultat (" + dead.length + ")",
  "",
  ...(dead.length ? dead.map((s) => "- " + name(s) + " `" + s.id + "` · " + (s.outcome?.termination?.reason || s.endedReason || s.status)) : ["Rien."]),
  "",
  "## ⚙️ Automatique (crons, reviews)",
  "",
  ...(Object.keys(auto).length
    ? Object.entries(auto).map(([k, v]) => "- `" + k + "` · " + v.runs + " runs · " + v.empty + " vides · dernier il y a " + ago(v.last))
    : ["Rien."]),
  "",
].join("\n");
fs.writeFileSync(out, md);
console.log("wrote", out, "attention=" + attention.length, "progress=" + progress.length, "closed=" + closed.length, "dead=" + dead.length);
' "$out" "$hours" "$tmp"
