#!/usr/bin/env python3
"""PR-watch (AIP-60 sentinel) coverage, lifecycle and noise on real data.

Inputs: ~/.agentproto/sentinels.json, ~/.agentproto/sentinels-parked.jsonl,
the live registry dump (`agentproto sessions --json > /tmp/sessions.json`),
and the sessions' events.jsonl. With `--gh`, also asks GitHub for the real
state of every still-`active` watch (needs an authenticated `gh`).
"""
import json, os, sys, glob, collections, subprocess

HOME = os.path.expanduser('~/.agentproto')
REG = next((a for a in sys.argv[1:] if not a.startswith('--')), '/tmp/sessions.json')
reg = {s['id']: s for s in json.load(open(REG))}
sentinels = list(json.load(open(f'{HOME}/sentinels.json')).values())

by_subject = collections.defaultdict(list)
for s in sentinels:
    for m in s['spec']['match']:
        by_subject[m['subject']].append(s)

prs = []
for s in reg.values():
    for p in s.get('openedPrs') or []:
        repo = '/'.join(p['url'].split('/')[3:5])
        prs.append((s['id'], f"github:{repo}#{p['number']}"))
print('PRs opened by daemon sessions:', len(prs))
print('  without any watch:', sum(1 for _, subj in prs if not by_subject.get(subj)))
print('  watchers per PR:', sorted(collections.Counter(len(by_subject.get(subj, [])) for _, subj in prs).items()))
rel = collections.Counter()
for sid, subj in prs:
    for s in by_subject.get(subj, []):
        t = s['spec']['target'].get('sessionId')
        rel['author' if t == sid else 'other'] += 1
print('  watch target relation:', dict(rel))

print('watch status:', collections.Counter(s['status'] for s in sentinels))
active = [s for s in sentinels if s['status'] == 'active']
stuck = 0
for s in active:
    st = s['handle'].get('state', {})
    snap = json.loads(s['handle'].get('cursor') or '{}').get('snapshot', {})
    real = ''
    if '--gh' in sys.argv:
        real = subprocess.run(['gh', 'pr', 'view', str(st['number']), '-R', st['repo'], '--json', 'state', '-q', '.state'],
                              capture_output=True, text=True).stdout.strip()
    if snap.get('state') in ('merged', 'closed'):
        stuck += 1
    print(f"  active {st.get('repo')}#{st.get('number')} poller-sees={snap.get('state')} github={real or '?'} events={s.get('eventCount')}")
print(f'active watches whose own poller already sees the PR closed/merged: {stuck}/{len(active)}')

parked = [json.loads(l) for l in open(f'{HOME}/sentinels-parked.jsonl')]
print('parked (undelivered) events, lifetime:', len(parked))

per = collections.Counter()
success = 0
for f in glob.glob(f'{HOME}/sessions/sess_*/events.jsonl'):
    if os.path.basename(os.path.dirname(f)) not in reg:
        continue
    for line in open(f, errors='ignore'):
        if '"correlationId":"sentinel:' not in line:
            continue
        e = json.loads(line)
        if e.get('kind') != 'session-message':
            continue
        m = e['message']
        per[m['correlationId']] += 1
        success += 'Check suite success' in (m.get('text') or '')
v = sorted(per.values())
if v:
    print(f'watch notices delivered: {sum(v)} over {len(v)} PRs (p50 {v[len(v)//2]}/PR, max {v[-1]}); '
          f'"check suite success": {success} ({100*success//sum(v)}%)')
