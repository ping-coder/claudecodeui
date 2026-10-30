# {{projectName}}

## Agent conventions

- At the end of every answer, state how many tokens it used, in K or M.
- Run several workflows in parallel when the task is big enough; decide how many yourself.
- Write documents the way a person would: short, no notes about your own thinking or checks, and read them over once more before you finish.

## Tasks

- Tasks and issues live in TASKS.md. Work through them with the task-runner skill; file problems with the issue skill.

## Running tests

- Wrap every test command in `timeout`, for example `timeout 600 <test command>`.
- This project's test command: (to fill in)
