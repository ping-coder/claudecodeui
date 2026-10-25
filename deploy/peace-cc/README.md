# peace-cc Custom CI/CD & Atomic Release/Rollback Guide

This repository (`ping-coder/claudecodeui`) is configured with an automated GitHub Actions pipeline and an atomic symlink release manager (`cloudcli-ctl`) targeting `peace-cc`.

## 1. Directory Layout on `peace-cc`
- `/home/peacehe/apps/cloudcli/repo` — Git repository & cached `node_modules`
- `/home/peacehe/apps/cloudcli/shared/.env` — Persistent environment configuration (`127.0.0.1:3001`)
- `/home/peacehe/.cloudcli/auth.db` — Persistent SQLite database (users, tokens, sessions)
- `/home/peacehe/apps/cloudcli/releases/<YYYYMMDD-HHMMSS>-<sha>` — Immutable build snapshots (retains latest 8)
- `/home/peacehe/apps/cloudcli/current` — Atomic symlink pointing to the active release

## 2. CI/CD Workflows
- **Auto Deploy (`.github/workflows/deploy-peace-cc.yml`)**: Triggers automatically on every `git push origin main` (or manually via `workflow_dispatch`). Builds on the `peace-cc-arm64` self-hosted runner, creates a release snapshot, switches `current`, restarts `cloudcli.service`, and verifies `http://127.0.0.1:3001/health` (auto-rolling back if unhealthy).
- **One-Click Rollback (`.github/workflows/rollback-peace-cc.yml`)**: Trigger manually from GitHub Actions UI/Mobile (`Rollback peace-cc` -> `Run workflow`) or via CLI (`ccui rollback` / `ccui rollback-ci`).

## 3. Local Mac CLI (`~/.local/bin/ccui`)
```bash
ccui open          # Ensure SSH tunnel (:3001) & open http://localhost:3001
ccui status        # Check service health & active release
ccui list          # List all historical releases ([CURRENT] / [PREVIOUS])
ccui deploy [ref]  # Trigger GitHub Actions deployment
ccui rollback      # Instant (<1s) rollback to previous release
ccui sync          # Fetch & merge upstream siteboon/claudecodeui/main
```
