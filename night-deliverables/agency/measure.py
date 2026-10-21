#!/usr/bin/env python3
"""Prototype mesureur de la boucle d'auto-amelioration (nuits agentproto).

Mesure, a partir de plans de nuit locaux (NIGHT-PLAN.md) et d'un log de PR
passe en argument :
  - les heures-homme livrees, par PM et par nuit ;
  - le taux de livrables acceptes ;
  - le cout par livrable.

Python stdlib uniquement. Aucune dependance, aucun appel reseau.

Usage :
    python3 measure.py --plans ./exemple/plans --pr-log ./exemple/prs.jsonl
    python3 measure.py --plan ./exemple/plans/2026-10-21/NIGHT-PLAN.md \
        --pr-log ./exemple/prs.jsonl --json

Format NIGHT-PLAN.md (en-tete "cle: valeur" puis tableau de taches) :

    # NIGHT-PLAN
    night: 2026-10-21
    pm: alice
    repo: agentproto/ts

    ## Tasks
    | id | pm | title | deliverable | est_hours | cost_usd | pr |
    |----|----|-------|-------------|-----------|----------|-----|
    | T1 | alice | Rapport | rapports/x.md | 6.0 | 1.20 | 412 |

Format du log de PR : JSONL (un objet JSON par ligne) ou TSV avec en-tete
contenant une colonne "pr". Champs reconnus : pr, pm, night, title, pr_url,
merged, accepted, status, cost_usd (ou costUsd), task (id de tache du plan),
repo.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

PLAN_FILENAME = "night-plan.md"
KEY_RE = re.compile(r"^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$")
SEP_RE = re.compile(r"^:?-{2,}:?$")
ACCEPTED_WORDS = {"accepted", "accepte", "accepte", "merged", "ok", "done", "livre", "shipped"}
REJECTED_WORDS = {"rejected", "rejete", "refused", "closed", "abandoned", "echec", "failed"}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def to_float(value, default=0.0):
    if value is None:
        return default
    text = str(value).strip().replace(",", ".")
    if not text or text in {"-", "n/a", "N/A", "null", "None"}:
        return default
    try:
        return float(text)
    except ValueError:
        return default


def to_int(value):
    if value is None:
        return None
    text = str(value).strip()
    if not text or text in {"-", "n/a", "N/A"}:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def split_row(line):
    cells = line.strip().strip("|").split("|")
    return [c.strip() for c in cells]


def is_separator(cells):
    return bool(cells) and all(SEP_RE.match(c.replace(" ", "")) for c in cells if c != "")


# --------------------------------------------------------------------------
# NIGHT-PLAN.md
# --------------------------------------------------------------------------


def parse_plan(path):
    """Retourne (meta, tasks) pour un fichier NIGHT-PLAN.md."""
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()

    meta = {}
    tasks = []
    i = 0
    in_meta = True
    while i < len(lines):
        line = lines[i].strip()
        if line.startswith("#"):
            i += 1
            continue
        if in_meta and line.startswith("|"):
            in_meta = False
        if in_meta:
            m = KEY_RE.match(line)
            if m:
                key = m.group(1).lower().replace("-", "_")
                meta.setdefault(key, m.group(2).strip())
            elif line:
                in_meta = False
            i += 1
            continue
        i += 1

    # tableaux markdown : on cherche un en-tete contenant id et est_hours
    header = None
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        if line.startswith("|") and "|" in line[1:]:
            cells = split_row(line)
            low = [c.lower() for c in cells]
            if "est_hours" in low or ("id" in low and "pm" in low):
                header = low
                index += 1
                continue
            if header is not None:
                if not is_separator(cells):
                    row = dict(zip(header, cells))
                    tasks.append(row)
                index += 1
                continue
        elif line and not line.startswith("|"):
            header = None
        index += 1

    default_pm = meta.get("pm", "")
    default_night = meta.get("night", meta.get("date", ""))
    parsed = []
    for row in tasks:
        task = {
            "id": row.get("id", ""),
            "pm": (row.get("pm") or default_pm or "").strip(),
            "title": row.get("title", ""),
            "deliverable": row.get("deliverable", row.get("path", "")),
            "est_hours": to_float(row.get("est_hours", row.get("hours"))),
            "cost_usd": to_float(row.get("cost_usd", row.get("cost"))),
            "pr": to_int(row.get("pr", row.get("pr_number"))),
            "status": (row.get("status") or "").strip().lower(),
            "night": (row.get("night") or default_night or "").strip(),
            "source": str(path),
        }
        parsed.append(task)
    return meta, parsed


def discover_plans(paths):
    files = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            files.extend(sorted(q for q in p.rglob("*.md") if q.name.lower() == PLAN_FILENAME))
        elif p.is_file():
            files.append(p)
    seen = set()
    out = []
    for f in files:
        key = str(f.resolve())
        if key not in seen:
            seen.add(key)
            out.append(f)
    return out


# --------------------------------------------------------------------------
# log de PR
# --------------------------------------------------------------------------


def parse_pr_log(path):
    """Retourne une liste de dicts PR normalises."""
    if path is None:
        return []
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    lines = [l for l in text.splitlines() if l.strip() and not l.strip().startswith("#")]
    if not lines:
        return []

    records = []
    if any(l.strip().startswith("{") for l in lines):
        for line in lines:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                records.append(obj)
    else:
        delimiter = "\t" if "\t" in lines[0] else ","
        reader = csv.DictReader(lines, delimiter=delimiter)
        for obj in reader:
            records.append({k: v for k, v in obj.items() if k})

    prs = []
    for rec in records:
        number = to_int(rec.get("pr", rec.get("number", rec.get("pr_number"))))
        cost = rec.get("cost_usd", rec.get("costUsd", rec.get("cost")))
        merged = rec.get("merged")
        if isinstance(merged, str):
            merged = merged.strip().lower() in {"true", "yes", "1"}
        status = str(rec.get("status", "")).strip().lower()
        accepted = rec.get("accepted")
        if isinstance(accepted, str):
            accepted = accepted.strip().lower() in {"true", "yes", "1"}
        if accepted is None:
            if merged is not None:
                accepted = bool(merged)
            elif status:
                accepted = status in ACCEPTED_WORDS
            else:
                accepted = False
        prs.append(
            {
                "pr": number,
                "pm": str(rec.get("pm", rec.get("owner", ""))).strip(),
                "night": str(rec.get("night", rec.get("date", ""))).strip(),
                "title": str(rec.get("title", "")),
                "task": str(rec.get("task", rec.get("task_id", ""))).strip(),
                "cost_usd": to_float(cost),
                "accepted": bool(accepted),
                "merged": merged,
                "status": status,
                "repo": str(rec.get("repo", "")).strip(),
            }
        )
    return prs


# --------------------------------------------------------------------------
# metriques
# --------------------------------------------------------------------------


class Bucket:
    """Cumul par PM ou par nuit."""

    def __init__(self):
        self.deliverables = 0
        self.accepted = 0
        self.hours_delivered = 0.0
        self.cost = 0.0
        self.unplanned = 0
        self.accepted_unplanned = 0

    def as_row(self):
        rate = (self.accepted / self.deliverables * 100.0) if self.deliverables else 0.0
        cost_per = (self.cost / self.accepted) if self.accepted else 0.0
        return {
            "livrables": self.deliverables,
            "acceptes": self.accepted,
            "taux_acceptation_pct": round(rate, 1),
            "heures_homme_livrees": round(self.hours_delivered, 2),
            "cout_usd": round(self.cost, 4),
            "cout_par_livrable_usd": round(cost_per, 4),
            "livrables_hors_plan": self.unplanned,
        }


def compute(tasks, prs):
    pr_by_number = {}
    pr_by_task = {}
    for pr in prs:
        if pr["pr"] is not None:
            pr_by_number[pr["pr"]] = pr
        if pr["task"]:
            pr_by_task.setdefault(pr["task"], pr)

    matched_pr_numbers = set()
    pm = {}
    night = {}

    def bucket(store, key):
        if key not in store:
            store[key] = Bucket()
        return store[key]

    # 1. taches du plan
    for task in tasks:
        pr = pr_by_number.get(task["pr"]) if task["pr"] is not None else None
        if pr is None and task["id"]:
            pr = pr_by_task.get(task["id"])
        if pr is not None and pr["pr"] is not None:
            matched_pr_numbers.add(pr["pr"])

        if pr is not None:
            accepted = pr["accepted"]
            cost = pr["cost_usd"]
            task_night = pr["night"] or task["night"]
            task_pm = pr["pm"] or task["pm"]
        else:
            accepted = task["status"] in ACCEPTED_WORDS
            cost = task["cost_usd"]
            task_night = task["night"]
            task_pm = task["pm"]

        b_pm = bucket(pm, task_pm or "(non affecte)")
        b_night = bucket(night, task_night or "(non date)")
        for b in (b_pm, b_night):
            b.deliverables += 1
            b.cost += cost
            if accepted:
                b.accepted += 1
                b.hours_delivered += task["est_hours"]

    # 2. PR sans tache de plan correspondante
    for pr in prs:
        if pr["pr"] is not None and pr["pr"] in matched_pr_numbers:
            continue
        if pr["task"] and pr["task"] in {t["id"] for t in tasks}:
            continue
        b_pm = bucket(pm, pr["pm"] or "(non affecte)")
        b_night = bucket(night, pr["night"] or "(non date)")
        for b in (b_pm, b_night):
            b.deliverables += 1
            b.unplanned += 1
            b.cost += pr["cost_usd"]
            if pr["accepted"]:
                b.accepted += 1
                b.accepted_unplanned += 1

    global_bucket = Bucket()
    for b in pm.values():
        global_bucket.deliverables += b.deliverables
        global_bucket.accepted += b.accepted
        global_bucket.hours_delivered += b.hours_delivered
        global_bucket.cost += b.cost
        global_bucket.unplanned += b.unplanned
        global_bucket.accepted_unplanned += b.accepted_unplanned

    return pm, night, global_bucket


# --------------------------------------------------------------------------
# rendu
# --------------------------------------------------------------------------


def render_table(headers, rows, aligns=None):
    cols = len(headers)
    aligns = aligns or ["l"] * cols
    widths = [len(str(h)) for h in headers]
    for row in rows:
        for i in range(cols):
            widths[i] = max(widths[i], len(str(row[i])))

    def fmt_row(cells):
        out = []
        for i, cell in enumerate(cells):
            cell = str(cell)
            if aligns[i] == "r":
                out.append(cell.rjust(widths[i]))
            else:
                out.append(cell.ljust(widths[i]))
        return " | ".join(out)

    sep = "-+-".join("-" * w for w in widths)
    return "\n".join([fmt_row(headers), sep] + [fmt_row(r) for r in rows])


def money(value):
    return f"{value:.2f}"


def report(pm, night, glob, nights_count):
    lines = []
    lines.append("")
    lines.append("METRIQUES PAR PM")
    lines.append(render_table(
        ["PM", "livrables", "acceptes", "taux %", "h-h livrees", "cout $", "cout/livrable $"],
        [
            [
                name,
                b.deliverables,
                b.accepted,
                f"{(b.accepted / b.deliverables * 100.0) if b.deliverables else 0.0:.1f}",
                f"{b.hours_delivered:.2f}",
                money(b.cost),
                money((b.cost / b.accepted) if b.accepted else 0.0),
            ]
            for name, b in sorted(pm.items())
        ],
        ["l", "r", "r", "r", "r", "r", "r"],
    ))

    lines.append("")
    lines.append("METRIQUES PAR NUIT")
    lines.append(render_table(
        ["nuit", "livrables", "acceptes", "taux %", "h-h livrees", "cout $", "cout/livrable $"],
        [
            [
                name,
                b.deliverables,
                b.accepted,
                f"{(b.accepted / b.deliverables * 100.0) if b.deliverables else 0.0:.1f}",
                f"{b.hours_delivered:.2f}",
                money(b.cost),
                money((b.cost / b.accepted) if b.accepted else 0.0),
            ]
            for name, b in sorted(night.items())
        ],
        ["l", "r", "r", "r", "r", "r", "r"],
    ))

    rate = (glob.accepted / glob.deliverables * 100.0) if glob.deliverables else 0.0
    cost_per_deliverable = (glob.cost / glob.accepted) if glob.accepted else 0.0
    cost_per_hour = (glob.cost / glob.hours_delivered) if glob.hours_delivered else 0.0
    nights = nights_count or len(night) or 1
    lines.append("")
    lines.append("TOTAL")
    lines.append(render_table(
        ["indicateur", "valeur"],
        [
            ["nuits mesurees", nights],
            ["livrables (total)", glob.deliverables],
            ["livrables acceptes", glob.accepted],
            ["livrables hors plan", glob.unplanned],
            ["taux d'acceptation %", f"{rate:.1f}"],
            ["heures-homme livrees", f"{glob.hours_delivered:.2f}"],
            ["cout total $", money(glob.cost)],
            ["cout par livrable accepte $", money(cost_per_deliverable)],
            ["cout par heure-homme livree $", money(cost_per_hour)],
            ["livrables acceptes par nuit", f"{glob.accepted / nights:.2f}"],
            ["heures-homme livrees par nuit", f"{glob.hours_delivered / nights:.2f}"],
        ],
        ["l", "r"],
    ))
    lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------


def main(argv=None):
    ap = argparse.ArgumentParser(description="Mesure de la boucle d'auto-amelioration (nuits).")
    ap.add_argument("--plans", action="append", default=[], help="repertoire(s) de plans de nuit")
    ap.add_argument("--plan", action="append", default=[], help="fichier(s) NIGHT-PLAN.md")
    ap.add_argument("--pr-log", default=None, help="log de PR (JSONL ou TSV)")
    ap.add_argument("--json", action="store_true", help="sortie JSON au lieu des tableaux")
    args = ap.parse_args(argv)

    plan_files = discover_plans(list(args.plans) + list(args.plan))
    tasks = []
    for f in plan_files:
        _, parsed = parse_plan(f)
        tasks.extend(parsed)
    prs = parse_pr_log(args.pr_log)

    pm, night, glob = compute(tasks, prs)
    nights = len({t["night"] for t in tasks if t["night"]})

    if args.json:
        payload = {
            "plans": [str(f) for f in plan_files],
            "prs": len(prs),
            "par_pm": {k: v.as_row() for k, v in sorted(pm.items())},
            "par_nuit": {k: v.as_row() for k, v in sorted(night.items())},
            "total": glob.as_row(),
            "nuits": nights,
        }
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0

    if not plan_files and not prs:
        print("aucun plan de nuit ni log de PR : rien a mesurer", file=sys.stderr)
        return 2

    print(report(pm, night, glob, nights))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
