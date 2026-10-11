> **Paused reference track (2026-10-11).** These were the agent rules for the exact native-engine goal. Active rules are in [../AGENTS.md](../AGENTS.md). The per-push chart review requirement is retired; update the native chart only when native research changes.

# Mandatory agent rules

## Update the decompilation chart on EVERY push

This is a hard user requirement. Before any agent pushes any branch:

1. Review the latest evidence and update `research/status.json`. Record a fresh
   review and describe the changes or checks since the last push. If no native
   decompilation milestone advanced, explicitly say so; do not invent progress.
2. Run `python scripts/progress.py render --review "Describe the evidence reviewed"`
   to increment the review sequence and update the generated status chart
   in `README.md`. Never manually edit the generated section.
3. Commit BOTH `research/status.json` and `README.md` in the range being pushed.
   An uncommitted update does not satisfy the rule. Initial pushes must contain
   a valid, synchronized committed chart.
4. Run `python scripts/progress.py check`, the relevant tests, and
   `python scripts/check_public_tree.py`. Install and use the pre-push hook:
   `git config core.hooksPath .githooks`.
5. Do not bypass the hook, skip CI, or weaken these checks to make a push pass.
   Repair the chart or evidence instead. Branch deletions and tag-only pushes
   do not publish a new development snapshot and are excluded by the hook.

## Evidence and research

- HARD USER REQUIREMENT: troop interactions, attacks, projectiles, and towers
  must be byte/bit identical to the original pinned simulation under identical
  inputs. No approximate mechanics, numerical tolerances, visual matching, or
  learned substitutes satisfy the goal. Preserve original simulation code and
  gameplay data. See `EXACT_ENGINE_GOAL.md` for the full acceptance criteria.
- Keep exactness and policy training behind the engine-validation gate. A
  constructor returning under mocked OS calls is a recovery milestone only.
  No approximation or unsupported mechanic may be silently promoted to
  recovered, equivalent, or complete.
- Complete state capture must include every field affecting future simulation
  and exact ordered events. Do not drop fields or normalize discrepancies
  merely to make traces agree. Matching a finite corpus does not prove all-state
  equivalence; original code/data/runtime preservation must also be established.

- Distinguish observed behavior, static-analysis results, hypotheses, and
  approximations. Do not mark movement or battle equivalence recovered because
  a loader runs, a function decompiles, or a replay looks plausible.
- Pin the exact APK version, hashes, ABI, asset set, and runtime assumptions.
  New builds get separate records. State every mocked operation in emulators.
- Preserve reproducible scripts and small summarized results. Store large
  inputs and generated artifacts under ignored `work/` paths.
- Keep original APKs, native binaries, protected assets, raw memory dumps,
  copied game implementation, credentials, and local absolute paths out of Git.
- Use isolated emulation for foreign native code. Do not silently turn modeled
  system calls into host operations or interact with a game account.
- Use parallel agents for independent reverse-engineering, validation, and
  tooling work when available. Assign distinct files/projects and share concrete
  findings. The integrating agent must verify claims before publishing them.
- The next requested visual demo is a full original-engine match with troop
  placement and interactions. Report isolated recovery milestones in text until
  that is executable; do not substitute another synthetic component animation.

## Completion

Run checks appropriate to the changes. Report what became demonstrably possible,
what remains unresolved, and the next concrete experiment. Do not claim an exact
simulator without evidence from the original engine.
