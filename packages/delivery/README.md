# @agentproto/delivery

The pure core of the delivery kernel. No I/O and no producer knowledge (nothing here
mentions GitHub, sessions or cron).

- `Envelope`: the one event shape every producer emits, with the delivery fields
  `floor`, `levelHint`, `repeatKey` and `about`.
- `Level` (`3` blocking, `2` actionable, `1` info, `0` noise) and `levelToTier`
  (`3 -> steer`, `2 -> next-turn`, `1 -> fyi`, `0 -> drop`).
- `computeLevel(env, classifierResult, cap)`:
  `level = floor ? 3 : min(classifierResult ?? levelHint ?? 2, cap)`. `terminal` ends a
  subscription and never changes the level.
- `createClassifierRegistry()`: constructed, never module-global. First registered match
  wins; registering an existing id replaces it in place.
- `RecentKeys`: the bounded repeat-window map, moved here from `@agentproto/sentinel`.
