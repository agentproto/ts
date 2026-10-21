# Exemple sur donnees factices

Donnees simulees pour valider le contrat de mesure, sans aucun appel reseau.

- `plans/2026-10-20/NIGHT-PLAN.md` : nuit d'alice, 3 taches, 2 PR acceptees sur 3.
- `plans/2026-10-21/NIGHT-PLAN.md` : nuit de bob, 2 taches, plus une PR hors plan.

Lancer :

```sh
python3 ../measure.py --plans ./plans --pr-log ./prs.jsonl
```

Le tableau produit est dans `mesures.txt` (sortie enregistree). Variante JSON :

```sh
python3 ../measure.py --plans ./plans --pr-log ./prs.jsonl --json
```
