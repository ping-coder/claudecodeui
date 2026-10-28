# Repository guidance

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Frontend code

For every task that creates, modifies, refactors, or reviews frontend code under `src/`, load and follow `$frontend-module-standards` from `.agents/skills/frontend-module-standards/SKILL.md`. Apply it only to frontend code; do not impose those architecture rules on the backend.

## Running tests

- Wrap every test command in `timeout`: `timeout 120 npx vitest run <files>` for a few files, `timeout 900 npm run test:client` for the whole client suite, `timeout 600 npm test` for the server suite.
- `vitest.memory-guard.ts` kills any test worker that passes 4 GB of memory. If you see `[memory-guard]`, a test is stuck in a loop: find it instead of rerunning the same command.
- For mutation or before/after checks, put a `timeout` on every iteration and restore the original files in a `trap` or from git. Never keep the only backup in `/tmp`; it is wiped on reboot.
- If a tool timeout moves a test command to the background, kill that run before going on.

