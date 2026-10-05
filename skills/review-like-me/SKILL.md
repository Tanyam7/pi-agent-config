---
name: review-like-me
description: >-
  Review every staged, unstaged, and untracked repository change for correctness,
  consistency, reuse, minimality, maintainability, and over-engineering. Use when
  asked for a full diff review, change audit, or a fix-and-review pass.
---

# Review Like Me

Review the complete uncommitted change set, not only the first visible diff.
Read `AGENTS.md` and the repository's referenced instructions first. Include
untracked files, trace changed behavior to its callers, and compare each change
with the closest existing implementation before judging it.

For every changed file and meaningful line, apply this order:

1. Confirm the change has a concrete purpose and is required for the requested
   behavior. Remove speculative, duplicate, or cosmetic work.
2. Search the repository for an existing helper, type, pattern, configuration
   shape, error path, test style, and package architecture. Reuse the closest
   match exactly, changing only what the requirement needs.
3. Follow Ponytail's ladder: question whether the code is needed; prefer an
   existing repository solution, then the standard library, native platform
   behavior, or an installed dependency. Add a new abstraction only when the
   existing options cannot satisfy the requirement.
4. Prefer the smallest safe, non-disruptive diff. Do not rename, reorganize, or
   refactor unrelated code. Keep new packages shaped like their nearest sibling.
5. Check that names, control flow, errors, validation, security boundaries,
   configuration, logging, and tests are self-explanatory and follow local
   conventions. Reject clever or exciting handling when boring reuse works.
6. Trace cross-package contracts end to end. A shared guard or helper must not
   break any caller; inspect every caller before proposing a fix. When new
   behavior diverges from an established contract, adapt the new behavior to
   the existing contract instead of propagating new configuration or headers
   through every caller.

Report findings first, with severity (`blocker`, `high`, `medium`, or `low`),
file and line, evidence, impact, and the minimal concrete fix. Do not report a
preference without a correctness, maintenance, consistency, or complexity
reason. Note intentional omissions when they are safe and explain what future
signal would justify adding them.

After fixes, run the narrowest meaningful checks for each affected package plus
format/lint and `git diff --check`. Keep tests proportional: every non-trivial
branch, loop, parser, security path, or data mutation needs a runnable check;
trivial wiring does not need a new test. Re-check the final full diff and status.

Do not invent dependencies, duplicate helpers, speculative flexibility, broad
architecture changes, or unrelated cleanup. Do not mutate external systems,
commit, or hide changes unless explicitly requested. When editing files, use the
repository's normal patch workflow and preserve unrelated user work.
