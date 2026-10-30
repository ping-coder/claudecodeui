import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, getConnection, initializeDatabase, projectMountsDb, projectsDb } from '@/modules/database/index.js';

async function withDatabase(
  prepare: ((databasePath: string) => void) | null,
  run: () => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'project-mounts-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  prepare?.(databasePath);

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await run();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function mountRecord(projectId: string, name: string) {
  return {
    mountId: `${projectId}-${name}`,
    projectId,
    name,
    targetPath: `/data/${name}`,
    createdAt: '2026-10-30T01:02:03.000Z',
  };
}

function assertMountsWorkAndCascade(): void {
  const project = projectsDb.createProjectPath('/workspace/with-mounts').project;
  const other = projectsDb.createProjectPath('/workspace/other').project;
  assert.ok(project && other);

  projectMountsDb.create(mountRecord(project.project_id, 'videos'));
  projectMountsDb.create(mountRecord(project.project_id, 'audio'));
  projectMountsDb.create(mountRecord(other.project_id, 'videos'));

  assert.deepEqual(projectMountsDb.listByProject(project.project_id).map((record) => record.name), ['audio', 'videos']);
  assert.deepEqual(projectMountsDb.getByName(project.project_id, 'videos'), mountRecord(project.project_id, 'videos'));
  assert.throws(
    () => projectMountsDb.create({ ...mountRecord(project.project_id, 'videos'), mountId: 'duplicate' }),
    (error: unknown) => (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE',
  );
  // A mount needs its project.
  assert.throws(
    () => projectMountsDb.create(mountRecord('no-such-project', 'videos')),
    (error: unknown) => (error as { code?: string }).code === 'SQLITE_CONSTRAINT_FOREIGNKEY',
  );

  projectsDb.deleteProjectById(project.project_id);
  assert.deepEqual(projectMountsDb.listByProject(project.project_id), []);
  assert.equal(projectMountsDb.listByProject(other.project_id).length, 1);

  assert.equal(projectMountsDb.delete(`${other.project_id}-videos`), true);
  assert.equal(projectMountsDb.delete(`${other.project_id}-videos`), false);
  assert.deepEqual(getConnection().pragma('foreign_key_check'), []);
}

test('a fresh database stores mounts per project and drops them with their project', async () => {
  await withDatabase(null, assertMountsWorkAndCascade);
});

test('an upgraded database whose projects table predates project_id gets a working mounts table', async () => {
  await withDatabase((databasePath) => {
    const legacyDb = new Database(databasePath);
    legacyDb.exec(`
      CREATE TABLE projects (
        project_path TEXT NOT NULL UNIQUE,
        custom_project_name TEXT DEFAULT NULL,
        isStarred BOOLEAN DEFAULT 0
      );
      INSERT INTO projects (project_path, custom_project_name, isStarred) VALUES ('/workspace/legacy', 'Legacy', 1);
    `);
    legacyDb.close();
  }, () => {
    const legacy = projectsDb.getProjectPath('/workspace/legacy');
    assert.ok(legacy?.project_id);
    projectMountsDb.create(mountRecord(legacy.project_id, 'archive'));
    assert.equal(projectMountsDb.listByProject(legacy.project_id).length, 1);

    assertMountsWorkAndCascade();
  });
});
