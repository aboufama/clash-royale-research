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

## Completion

Run checks appropriate to the changes. Report what became demonstrably possible,
what remains unresolved, and the next concrete experiment. Do not claim an exact
simulator without evidence from the original engine.
