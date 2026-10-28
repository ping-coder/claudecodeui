# peace-cc Custom CI/CD & Atomic Release/Rollback Guide

This repository (`ping-coder/claudecodeui`) is configured with an automated GitHub Actions pipeline and an atomic symlink release manager (`cloudcli-ctl`) targeting `peace-cc`.

## 1. Directory Layout on `peace-cc`
- `/home/peacehe/apps/cloudcli/repo` — Git repository & cached `node_modules`
- `/home/peacehe/apps/cloudcli/bin/cloudcli-ctl` — Installed release manager (refreshed by every deploy run, see below)
- `/home/peacehe/apps/cloudcli/shared/.env` — Persistent environment configuration (`127.0.0.1:3001`)
- `/home/peacehe/.cloudcli/auth.db` — Persistent SQLite database (users, tokens, sessions); the path is the `DATABASE_PATH=` line in `shared/.env`
- `/home/peacehe/apps/cloudcli/shared/db-backups/auth-<release_id>.db` — Pre-deploy database backups (retains latest 8)
- `/home/peacehe/apps/cloudcli/releases/<YYYYMMDD-HHMMSS>-<sha>` — Immutable build snapshots (retains latest 8)
- `/home/peacehe/apps/cloudcli/current` — Atomic symlink pointing to the active release

## 2. CI/CD Workflows
- **Auto Deploy (`.github/workflows/deploy-peace-cc.yml`)**: Triggers automatically on every `git push origin main` (or manually via `workflow_dispatch`). Builds on the `peace-cc-arm64` self-hosted runner, creates a release snapshot, backs up the database, switches `current`, restarts `cloudcli.service`, and verifies `http://127.0.0.1:3001/health` (auto-rolling back if unhealthy).
- **cloudcli-ctl self-update**: the first step of each deploy job installs `deploy/peace-cc/cloudcli-ctl` from the commit the workflow runs for (`github.sha`, never the `ref` input, so deploying an old ref cannot downgrade the tool). It fetches in `~/apps/cloudcli/repo`, checks the file exists at that commit (`git cat-file -e`), writes it to `bin/cloudcli-ctl.new`, checks it with `bash -n`, makes it executable and moves it over `bin/cloudcli-ctl` in one rename. If the repo has not been cloned yet the step only warns, and the installed copy clones it. The rollback workflow uses the installed copy as it is.
- **One-Click Rollback (`.github/workflows/rollback-peace-cc.yml`)**: Trigger manually from GitHub Actions UI/Mobile (`Rollback peace-cc` -> `Run workflow`) or via CLI (`ccui rollback` / `ccui rollback-ci`).
- **Ref resolution**: `cloudcli-ctl deploy <branch>` deploys `origin/<branch>`, because `git fetch` never moves the local branches in `repo/`. Tags, commit SHAs and explicit `origin/...` refs resolve as given.

## 3. Local Mac CLI (`~/.local/bin/ccui`)
```bash
ccui open          # Ensure SSH tunnel (:3001) & open http://localhost:3001
ccui status        # Check service health & active release
ccui list          # List all historical releases ([CURRENT] / [PREVIOUS])
ccui deploy [ref]  # Trigger GitHub Actions deployment
ccui rollback      # Instant (<1s) rollback to previous release
ccui sync          # Fetch & merge upstream siteboon/claudecodeui/main
```

### Other computers (`cctunnel`)
`deploy/peace-cc/cctunnel/` is the `ccui open` tunnel as a standalone folder: `cctunnel` and `ccopen` for macOS, Linux and WSL, `windows/` for Windows. Copy it into a folder of its own and put that folder on PATH.

Windows, in PowerShell (`ssh peace-cc` must already work without a prompt):
```powershell
New-Item -ItemType Directory -Force $HOME\cctunnel | Out-Null
scp -p "peace-cc:projects/github/claudecodeui/deploy/peace-cc/cctunnel/windows/*" $HOME\cctunnel
& $HOME\cctunnel\cctunnel.cmd install   # adds the folder to the user PATH
```
Then open a new terminal (restart Windows Terminal if `ccopen` is still not found) and run `ccopen`.

macOS, Linux, WSL:
```bash
mkdir -p ~/cctunnel
scp -p 'peace-cc:projects/github/claudecodeui/deploy/peace-cc/cctunnel/cc*' ~/cctunnel/
echo 'export PATH="$HOME/cctunnel:$PATH"' >> ~/.zshrc   # bash: ~/.bashrc; then open a new terminal
```
A computer that cannot log in to peace-cc yet gets `cctunnel` and `ccopen` from GitHub instead (`chmod +x` both) and runs `cctunnel setup <peace-cc external IP>`: it creates a key, adds `Host peace-cc` to `~/.ssh/config` and tests the login. If peace-cc does not know the key, it prints an `echo '<key>' >> ~/.ssh/authorized_keys` line to run on peace-cc from a session that already works (cloudcli's shell will do); the Google guest agent only manages the lines it added.

Same commands everywhere:
```
ccopen                  # start the tunnel if needed, open http://127.0.0.1:3001
cctunnel status         # tunnel state and cloudcli health
cctunnel down           # stop it
cctunnel fwd 5173       # also forward a dev server; unfwd 5173 stops it
cctunnel watch          # foreground, restarts the tunnel after sleep or network changes
```
- If 3001 is taken locally, set `CCTUNNEL_PORT=13001` for good (`export` in the shell rc; `setx CCTUNNEL_PORT 13001` and a new terminal on Windows): every command finds the tunnel by its port. `cctunnel help` lists the other settings.
- The Windows version and `watch`'s reconnects log in without a prompt, so a key with a passphrase must be in ssh-agent (`ssh-add`). Windows ships the agent disabled; start it once in an admin PowerShell: `Get-Service ssh-agent | Set-Service -StartupType Automatic; Start-Service ssh-agent`.
- On Windows, Ctrl-C in `cctunnel watch` stops the tunnel, then cmd asks "Terminate batch job (Y/N)?"; either answer is fine.
- WSL can shut the distro down, tunnel included, soon after its last window closes; keep one open.
- If peace-cc's IP changes, fix `HostName` under `Host peace-cc` in `~/.ssh/config`.

## 4. Database Backups
Every `cloudcli-ctl deploy` backs up the database after building the release and before switching `current`, so a backup always predates the new release's migrations. It is stored as `shared/db-backups/auth-<release_id>.db` and holds the database exactly as the previous release left it. The newest 8 are kept. They contain password hashes, the JWT secret and API/GitHub tokens, so the files are `0600` in a `0700` directory.

The database is the first `DATABASE_PATH=` line of `shared/.env`, which must be an absolute path, or `~/.cloudcli/auth.db` when there is none. If that file does not exist yet, the backup is skipped. The copy is made with SQLite's online backup API through the repo's `better-sqlite3`, so it stays consistent while the service writes, and it must pass `PRAGMA integrity_check` before it is kept.

If the backup fails, the deploy stops before switching `current`: the running release and its database are untouched, and the half-made snapshot is removed. The error `attempt to write a readonly database` means a crash left a hot journal next to the database; start or restart `cloudcli.service` (its first read rolls the journal back), then deploy again.

Rollbacks, automatic or `cloudcli-ctl rollback`, switch code only and never restore a database. Schema changes stay backward compatible, so an older release runs on a migrated database; the backups are for disaster recovery.

To restore a backup (`ls -t ~/apps/cloudcli/shared/db-backups` lists them newest first):
```bash
DB=$(grep -m1 '^DATABASE_PATH=' ~/apps/cloudcli/shared/.env | cut -d= -f2-)
DB=${DB:-$HOME/.cloudcli/auth.db}
BACKUP=~/apps/cloudcli/shared/db-backups/auth-<release_id>.db

systemctl --user stop cloudcli.service
cp -p "$DB" "$DB.before-restore-$(date +%Y%m%d-%H%M%S)"  # optional: keep the database being replaced
cp "$BACKUP" "$DB"
rm -f "$DB-journal" "$DB-wal" "$DB-shm"                  # a leftover journal would be replayed onto the restored file
systemctl --user start cloudcli.service
```
`auth-<release_id>.db` is the database as it was just before `<release_id>` went live. To also run the code that wrote it, run `cloudcli-ctl rollback <release>` before the final `start`, naming the release that was current before `<release_id>` (see `cloudcli-ctl list`). Keep the final `systemctl --user start cloudcli.service` in every case: when that release is already current (for example after a failed deploy rolled back automatically), the rollback only prints "Already running release" and does not start the stopped service. To check a backup before restoring it, run `cd ~/apps/cloudcli/repo && node -e "const D = require('better-sqlite3'); console.log(new D(process.argv[1], { readonly: true }).pragma('integrity_check', { simple: true }))" "$BACKUP"`; it prints `ok` for a sound file.
