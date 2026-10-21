# Tache 8 : recherche agency de nos agents (pour le cerveau)

Livrables de la lecture externe et du prototype de mesure de la boucle
d'auto-amelioration (planificateur, executeur de nuit, mesureur).

- `design.md` : architecture de la boucle, roles, ajustement des consignes,
  garde-fous (pas de deploiement, pas de depense). Francais, sans tiret cadratin.
- `measure.py` : prototype Python stdlib. Mesure heures-homme livrees par PM
  et par nuit, taux de livrables acceptes, cout par livrable, a partir de
  plans `NIGHT-PLAN.md` locaux et d'un log de PR passe en argument.
- `exemple/` : donnees factices (2 plans de nuit, un log de PR) et le tableau de
  metriques produit (`mesures.txt`).

Lancer l'exemple :

```sh
python3 measure.py --plans exemple/plans --pr-log exemple/prs.jsonl
```

Sources etudiees (clones shallow dans `/home/user/work/research/`) :
`github.com/karpathy/autoresearch` et `github.com/google-research/harness2`.
Le rapport `rapports/harness2-et-agents-externes.md` du clone
`projects/agentik-studio` etait absent de la machine, la conclusion s'appuie
donc sur la lecture directe des deux depots.
