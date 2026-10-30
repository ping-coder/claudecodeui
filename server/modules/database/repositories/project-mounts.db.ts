import { getConnection } from '@/modules/database/connection.js';
import type { ProjectMountRecord } from '@/shared/types.js';

type ProjectMountRow = {
  mount_id: string;
  project_id: string;
  name: string;
  target_path: string;
  created_at: string;
};

const COLUMNS = 'mount_id, project_id, name, target_path, created_at';

function toRecord(row: ProjectMountRow): ProjectMountRecord {
  return {
    mountId: row.mount_id,
    projectId: row.project_id,
    name: row.name,
    targetPath: row.target_path,
    createdAt: row.created_at,
  };
}

export const projectMountsDb = {
  /** The project's mounts, by name. */
  listByProject(projectId: string): ProjectMountRecord[] {
    const db = getConnection();
    const rows = db.prepare(`
      SELECT ${COLUMNS}
      FROM project_mounts
      WHERE project_id = ?
      ORDER BY name
    `).all(projectId) as ProjectMountRow[];
    return rows.map(toRecord);
  },

  getById(mountId: string): ProjectMountRecord | null {
    const db = getConnection();
    const row = db.prepare(`
      SELECT ${COLUMNS}
      FROM project_mounts
      WHERE mount_id = ?
    `).get(mountId) as ProjectMountRow | undefined;
    return row ? toRecord(row) : null;
  },

  getByName(projectId: string, name: string): ProjectMountRecord | null {
    const db = getConnection();
    const row = db.prepare(`
      SELECT ${COLUMNS}
      FROM project_mounts
      WHERE project_id = ? AND name = ?
    `).get(projectId, name) as ProjectMountRow | undefined;
    return row ? toRecord(row) : null;
  },

  /** Inserts a row; throws on a name the project already uses (UNIQUE(project_id, name)). */
  create(record: ProjectMountRecord): ProjectMountRecord {
    const db = getConnection();
    db.prepare(`
      INSERT INTO project_mounts (mount_id, project_id, name, target_path, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(record.mountId, record.projectId, record.name, record.targetPath, record.createdAt);
    return record;
  },

  /** Whether a row was removed. */
  delete(mountId: string): boolean {
    const db = getConnection();
    return db.prepare('DELETE FROM project_mounts WHERE mount_id = ?').run(mountId).changes > 0;
  },

  /** Removes every mount of the project; returns how many there were. */
  deleteByProject(projectId: string): number {
    const db = getConnection();
    return db.prepare('DELETE FROM project_mounts WHERE project_id = ?').run(projectId).changes;
  },
};
