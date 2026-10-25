/**
 * Dry-runs this build's schema and migrations against a copy of a real
 * database, then prints `PRAGMA integrity_check` and the row count of every
 * table before and after.
 *
 * Usage, from the repository root:
 *
 *   env -u CLAUDE_CLI_PATH npx tsx --tsconfig server/tsconfig.json \
 *     server/modules/database/tests/helpers/check-database-copy.ts <copy-of-auth.db> [--keep]
 *
 * The file given is only ever opened read-only: SQLite's online backup copies
 * it into a fresh temp directory and the migrations run on that working copy,
 * which is deleted afterwards unless `--keep` is passed. The live database
 * (`~/.cloudcli/auth.db`, or whatever DATABASE_PATH names) is refused outright.
 * Exits 1 when a check fails and 2 on usage errors or refusals.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { runMigrations } from '@/modules/database/migrations.js';
import { INIT_SCHEMA_SQL, PROVIDER_MODELS_ALLOWED_PROVIDERS } from '@/modules/database/schema.js';

type TableSummary = {
  rows: number;
  digest: string;
};

type DatabaseSnapshot = {
  integrity: string;
  foreignKeyViolations: number;
  tables: Record<string, TableSummary>;
  providerCheck: string[] | null;
  providerSequence: number | null;
  providerRows: Array<Record<string, unknown>>;
};

type DatabaseCopyReport = {
  sourcePath: string;
  workingCopyPath: string;
  workingCopyKept: boolean;
  sqliteVersion: string;
  before: DatabaseSnapshot;
  after: DatabaseSnapshot;
  agyInsertAccepted: boolean;
  problems: string[];
};

/** Raised for inputs the helper refuses to touch; the CLI maps it to exit code 2. */
class RefusedDatabaseError extends Error {}

const sameFile = (left: string, right: string): boolean => {
  if (path.resolve(left) === path.resolve(right)) {
    return true;
  }
  try {
    const leftStat = fs.statSync(left);
    const rightStat = fs.statSync(right);
    // Catches symlinks and hard links to the same database file.
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
};

const assertNotLiveDatabase = (sourcePath: string): void => {
  const liveDatabasePaths = [
    path.join(os.homedir(), '.cloudcli', 'auth.db'),
    process.env.DATABASE_PATH,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const livePath of liveDatabasePaths) {
    if (sameFile(sourcePath, livePath)) {
      throw new RefusedDatabaseError(
        `Refusing to run against the live database ${livePath}; copy it first and pass the copy.`,
      );
    }
  }
};

const readProviderCheck = (db: Database.Database): string[] | null => {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'provider_models'")
    .get() as { sql: string } | undefined;
  const match = /CHECK\s*\(\s*["`[]?provider["`\]]?\s+IN\s*\(([^)]*)\)\s*\)/i.exec(row?.sql ?? '');
  return match
    ? Array.from(match[1].matchAll(/'((?:[^']|'')*)'/g), (literal) => literal[1].replaceAll("''", "'"))
    : null;
};

const takeSnapshot = (db: Database.Database): DatabaseSnapshot => {
  const tableNames = (db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>)
    .map((table) => table.name);

  const tables: Record<string, TableSummary> = {};
  for (const name of tableNames) {
    const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
    // Order-independent digest, so a rebuilt table with the same rows compares equal.
    const serializedRows = rows.map((row) => JSON.stringify(row)).sort();
    tables[name] = {
      rows: rows.length,
      digest: createHash('sha256').update(serializedRows.join('\n')).digest('hex'),
    };
  }

  const hasProviderModels = tableNames.includes('provider_models');
  const providerSequence = tableNames.includes('sqlite_sequence')
    ? (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'provider_models'").get() as
      | { seq: number }
      | undefined)?.seq ?? null
    : null;

  return {
    integrity: (db.pragma('integrity_check') as Array<{ integrity_check: string }>)
      .map((row) => row.integrity_check)
      .join('; '),
    foreignKeyViolations: (db.pragma('foreign_key_check') as unknown[]).length,
    tables,
    providerCheck: hasProviderModels ? readProviderCheck(db) : null,
    providerSequence,
    providerRows: hasProviderModels
      ? db.prepare('SELECT * FROM provider_models ORDER BY id').all() as Array<Record<string, unknown>>
      : [],
  };
};

/** Inserts an agy custom model inside a transaction that is always rolled back. */
const probeAgyInsert = (db: Database.Database): boolean => {
  db.exec('BEGIN');
  try {
    db.prepare("INSERT INTO provider_models (provider, model_id, model_name) VALUES ('agy', ?, 'probe')")
      .run(`check-database-copy-${randomUUID()}`);
    return true;
  } catch {
    return false;
  } finally {
    db.exec('ROLLBACK');
  }
};

/**
 * True when every provider_models row keeps its id and the value of every
 * column it had before; columns the migrations added are ignored.
 */
const providerRowsPreserved = (before: DatabaseSnapshot, after: DatabaseSnapshot): boolean =>
  before.providerRows.length === after.providerRows.length
  && before.providerRows.every((row, index) => {
    const migratedRow = after.providerRows[index];
    return Object.entries(row).every(([column, value]) => migratedRow?.[column] === value);
  });

const findProblems = (before: DatabaseSnapshot, after: DatabaseSnapshot, agyInsertAccepted: boolean): string[] => {
  const problems: string[] = [];
  if (after.integrity !== 'ok') {
    problems.push(`integrity_check after migrations: ${after.integrity}`);
  }
  if (after.foreignKeyViolations > before.foreignKeyViolations) {
    problems.push(
      `foreign key violations grew from ${before.foreignKeyViolations} to ${after.foreignKeyViolations}`,
    );
  }
  const missingProviders = after.providerCheck
    ? PROVIDER_MODELS_ALLOWED_PROVIDERS.filter((provider) => !after.providerCheck?.includes(provider))
    : [];
  if (missingProviders.length > 0) {
    problems.push(`provider_models check still lacks ${missingProviders.join(', ')}`);
  }
  if (!providerRowsPreserved(before, after)) {
    problems.push('provider_models rows changed during the migrations');
  }
  if (!agyInsertAccepted) {
    problems.push('inserting an agy custom model failed');
  }
  for (const [name, summary] of Object.entries(before.tables)) {
    const afterSummary = after.tables[name];
    if (afterSummary && afterSummary.rows < summary.rows) {
      problems.push(`${name} lost rows (${summary.rows} -> ${afterSummary.rows})`);
    }
  }
  return problems;
};

/**
 * Copies `sourcePath` (opened read-only) into a temp directory, runs
 * `INIT_SCHEMA_SQL` and `runMigrations` on the copy exactly as server start-up
 * does, and reports what changed. Consumed by this file's CLI and by
 * check-database-copy.test.ts, which covers the refusal and read-only guarantees.
 */
export async function checkDatabaseCopy(
  sourcePath: string,
  options: { keepCopy?: boolean } = {},
): Promise<DatabaseCopyReport> {
  const resolvedSource = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isFile()) {
    throw new RefusedDatabaseError(`No database file at ${resolvedSource}.`);
  }
  assertNotLiveDatabase(resolvedSource);

  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli-db-check-'));
  const workingCopyPath = path.join(workingDirectory, 'auth.db');
  try {
    const source = new Database(resolvedSource, { readonly: true, fileMustExist: true, timeout: 5000 });
    try {
      await source.backup(workingCopyPath);
    } finally {
      source.close();
    }
    // The copy holds password hashes and tokens.
    fs.chmodSync(workingCopyPath, 0o600);

    const db = new Database(workingCopyPath);
    try {
      const before = takeSnapshot(db);
      db.exec(INIT_SCHEMA_SQL);
      runMigrations(db);
      const after = takeSnapshot(db);
      const agyInsertAccepted = probeAgyInsert(db);

      return {
        sourcePath: resolvedSource,
        workingCopyPath,
        workingCopyKept: Boolean(options.keepCopy),
        sqliteVersion: (db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version,
        before,
        after,
        agyInsertAccepted,
        problems: findProblems(before, after, agyInsertAccepted),
      };
    } finally {
      db.close();
    }
  } finally {
    if (!options.keepCopy) {
      fs.rmSync(workingDirectory, { recursive: true, force: true });
    }
  }
}

const formatReport = (report: DatabaseCopyReport): string => {
  const { before, after } = report;
  const formatList = (list: string[] | null): string => (list ? list.join(', ') : '(no provider check)');
  const lines = [
    '',
    'Database copy check',
    `  source:        ${report.sourcePath} (opened read-only, unchanged)`,
    `  working copy:  ${report.workingCopyPath} (${report.workingCopyKept ? 'kept' : 'deleted'})`,
    `  sqlite:        ${report.sqliteVersion}`,
    '',
    `  integrity_check          before: ${before.integrity}    after: ${after.integrity}`,
    `  foreign key violations   before: ${before.foreignKeyViolations}    after: ${after.foreignKeyViolations}`,
    `  provider_models check    before: ${formatList(before.providerCheck)}`,
    `                           after:  ${formatList(after.providerCheck)}`,
    `  provider_models seq      before: ${before.providerSequence ?? '(none)'}    after: ${after.providerSequence ?? '(none)'}`,
    `  agy insert (rolled back) ${report.agyInsertAccepted ? 'accepted' : 'REJECTED'}`,
    '',
    `  ${'table'.padEnd(36)}${'rows before'.padStart(12)}${'rows after'.padStart(12)}  content`,
  ];

  const tableNames = [...new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])].sort();
  for (const name of tableNames) {
    const beforeTable = before.tables[name];
    const afterTable = after.tables[name];
    const content = !beforeTable
      ? 'created'
      : !afterTable
        ? 'dropped'
        : beforeTable.digest === afterTable.digest
          ? 'unchanged'
          : 'changed';
    lines.push(
      `  ${name.padEnd(36)}${String(beforeTable?.rows ?? '-').padStart(12)}${String(afterTable?.rows ?? '-').padStart(12)}  ${content}`,
    );
  }

  lines.push('');
  lines.push(report.problems.length === 0 ? 'Result: OK' : `Result: FAILED\n  - ${report.problems.join('\n  - ')}`);
  return lines.join('\n');
};

const runCli = async (args: string[]): Promise<number> => {
  const keepCopy = args.includes('--keep');
  const positional = args.filter((arg) => arg !== '--keep');
  if (positional.length !== 1 || positional[0].startsWith('-')) {
    console.error('Usage: check-database-copy.ts <copy-of-auth.db> [--keep]');
    return 2;
  }

  try {
    const report = await checkDatabaseCopy(positional[0], { keepCopy });
    console.log(formatReport(report));
    return report.problems.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof RefusedDatabaseError ? 2 : 1;
  }
};

/** True when this file is the script node was started with, not a module imported by a test. */
const isCliEntryPoint = (): boolean => {
  const invokedPath = process.argv[1];
  if (!invokedPath) {
    return false;
  }
  try {
    return fs.realpathSync(invokedPath) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isCliEntryPoint()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
