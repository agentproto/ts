#!/usr/bin/env python3
"""Measure supervision coverage on real ~/.agentproto data.

Window: sessions in the live registry (/tmp/sessions.json, = `agentproto sessions --json`).
"Attention point" = a turn-end after which the session sat idle (no new prompt
or message within IDLE_S) -> someone has to look at it.
Pushed = the session itself sent a typed message (message_parent/...) during that turn,
         or a crash notice reached its parent.
Observed = first of: next prompt/message INTO the session, or any daemon session's
           tool-call whose arguments mention the session id, after the turn-end.
"""
import json, os, re, glob, collections, datetime, statistics, sys

HOME = os.path.expanduser('~/.agentproto/sessions')
IDLE_S = 60
NOW = datetime.datetime.now(datetime.timezone.utc)

def ts(s):
    return datetime.datetime.fromisoformat(s.replace('Z', '+00:00'))

# input: `agentproto sessions --json > /tmp/sessions.json` (the live registry)
REG = sys.argv[1] if len(sys.argv) > 1 else '/tmp/sessions.json'
reg = {s['id']: s for s in json.load(open(REG))}
since = min(ts(s['startedAt']) for s in reg.values())
SID = re.compile(r'sess_[0-9a-f]{8}')

# 1) scan every events.jsonl touched in the window
events = {}
refs = collections.defaultdict(list)       # sid -> [(ts, by_session)]
inbound = collections.defaultdict(list)    # sid -> [ts of prompt/message into it]
msg_delay = []                              # (delay_s, kind, relation)
for f in glob.glob(f'{HOME}/sess_*/events.jsonl'):
    if os.path.getmtime(f) < since.timestamp():
        continue
    sid = f.split('/')[-2]
    evs = []
    for line in open(f, errors='ignore'):
        try:
            e = json.loads(line)
        except Exception:
            continue
        k = e.get('kind')
        if k == 'tool-call':
            for m in set(SID.findall(json.dumps(e.get('arguments', {})))):
                if m != sid:
                    refs[m].append((ts(e['ts']), sid))
        if k in ('user-prompt', 'session-message', 'turn-end', 'session-message-sent', 'notice', 'error'):
            evs.append(e)
        if k == 'session-message':
            m = e['message']
            d = (ts(e['ts']) - ts(m['ts'])).total_seconds()
            msg_delay.append((d, m.get('kind'), m.get('from', {}).get('relation'), sid))
    if sid in reg:
        events[sid] = evs
    for e in evs:
        if e['kind'] in ('user-prompt', 'session-message'):
            inbound[sid].append(ts(e['ts']))

def cls(s):
    o = s.get('origin') or ''
    if o == 'review': return 'review'
    if o.startswith('cron:'): return 'cron'
    return 'child' if s.get('parentSessionId') else 'root'

rows = []
for sid, evs in events.items():
    s = reg[sid]
    c = cls(s)
    turn_start = None
    sent_in_turn = False
    for i, e in enumerate(evs):
        k = e['kind']
        if k in ('user-prompt', 'session-message'):
            if turn_start is None:
                turn_start = ts(e['ts']); sent_in_turn = False
        elif k == 'session-message-sent':
            sent_in_turn = True
        elif k == 'turn-end':
            t = ts(e['ts'])
            nxt = [x for x in inbound[sid] if x > t]
            nxt_in = min(nxt) if nxt else None
            if nxt_in and (nxt_in - t).total_seconds() <= IDLE_S:
                turn_start = None
                continue  # chained turn (queue drain etc.), not an attention point
            obs = [x for x, by in refs[sid] if x > t]
            cands = [x for x in [nxt_in, min(obs) if obs else None] if x]
            first = min(cands) if cands else None
            rows.append(dict(sid=sid, cls=c, reason=e.get('reason'), t=t, pushed=sent_in_turn,
                             observed=first, delay=(first - t).total_seconds() if first else None,
                             label=s.get('label') or s.get('title') or '', parent=s.get('parentSessionId'),
                             origin=s.get('origin')))
            turn_start = None

def pct(xs, p):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else None

print(f'window: {since.isoformat()[:16]} -> {NOW.isoformat()[:16]}; registry sessions={len(reg)}, with events={len(events)}')
print('sessions by class:', collections.Counter(cls(s) for s in reg.values()))
print('root origins:', collections.Counter((s.get('origin') or '-') for s in reg.values() if cls(s) == 'root').most_common(8))
print()
print('attention points (idle turn-ends) by class:')
for c in ('root', 'child', 'review', 'cron'):
    R = [r for r in rows if r['cls'] == c]
    if not R: continue
    pushed = sum(r['pushed'] for r in R)
    never = [r for r in R if r['observed'] is None]
    d = [r['delay'] for r in R if r['delay'] is not None]
    late = [x for x in d if x > 600]
    print(f'  {c:6} n={len(R):4}  pushed={pushed:4} ({100*pushed/len(R):.0f}%)  '
          f'never-observed={len(never):4} ({100*len(never)/len(R):.0f}%)  '
          f'observed>10min={len(late):4}  p50={pct(d,.5) and round(pct(d,.5))}s p90={pct(d,.9) and round(pct(d,.9))}s')
print()
R = [r for r in rows if r['cls'] in ('root', 'child')]
print('root+child, unpushed attention points by turn-end reason:',
      collections.Counter(r['reason'] for r in R if not r['pushed']).most_common())
print('root+child, NEVER observed, by reason:',
      collections.Counter(r['reason'] for r in R if r['observed'] is None).most_common())
# final turn per session never observed
last = {}
for r in R:
    if r['sid'] not in last or r['t'] > last[r['sid']]['t']: last[r['sid']] = r
fin_never = [r for r in last.values() if r['observed'] is None]
print(f'sessions whose LAST turn-end was never followed up: {len(fin_never)}/{len(last)}')
print('  of which error/aborted:', sum(1 for r in fin_never if r['reason'] != 'completed'))
print()
print('typed-message delivery delay (msg.ts -> injected into a turn):')
for rel in ('system', 'child', 'parent', 'human'):
    D = [d for d, k, r, _ in msg_delay if r == rel]
    if D:
        print(f'  from {rel:6} n={len(D):4} p50={pct(D,.5):.0f}s p90={pct(D,.9):.0f}s max={max(D):.0f}s  >60s={sum(1 for x in D if x>60)}  >10min={sum(1 for x in D if x>600)}')
json.dump([{**r, 't': r['t'].isoformat(), 'observed': r['observed'] and r['observed'].isoformat()} for r in rows],
          open(os.environ.get('OUT', '/tmp/attention-points.json'), 'w'), indent=1)
