---
name: task-runner
description: Work through TASKS.md - fix open issues first, then build the "To do" features in order, write the changelog and commit. Use when the user says "continue the tasks" or "work on TASKS.md".
---

# Working through TASKS.md

1. Read the "To do", "Done" and "Issues" sections of TASKS.md and note the latest version.
2. Scope this version: every [open] issue plus the first "To do" item. A feature marked as a major version ships on its own.
3. Build it: understand the code involved first, add tests with the change. Wrap every test command in `timeout`.
4. Review your own change: missed cases, things it breaks elsewhere.
5. Update TASKS.md:
   - Move finished features from "To do" to "Done" under a new `### version (date)` heading, with the feature and a changelog. Write the changelog for users: what changed and how to use it now, not how it was built.
   - Mark fixed issues [fixed] and add the version in the parentheses.
   - File problems you found but did not fix as [open], "reported by the agent".
   - Clean up: keep the last 5 versions; drop older "Done" sections and fixed issues that are more than 7 days old.
6. Commit once per feature with a message that says what changed; push or open a PR when there is a remote. If a task asks for a human check, stop and ask first.
7. If "To do" still has items, go back to step 1.

Follow the project's own version scheme. Without one, start at v0.1.0: bump the minor version for features and the patch version for fixes only.
