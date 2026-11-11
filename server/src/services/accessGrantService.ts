import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

export interface AccessGrant {
  id: string;
  grantor_user_id: string;
  grantee_user_id: string;
  status: 'active' | 'revoked';
  created_by: string;
  note: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  grantor_username?: string;
  grantee_username?: string;
  created_by_username?: string;
}

export class AccessGrantService {
  constructor(private db: Database.Database) {}

  private mapRow(row: any): AccessGrant {
    return {
      id: row.id,
      grantor_user_id: row.grantor_user_id,
      grantee_user_id: row.grantee_user_id,
      status: row.status,
      created_by: row.created_by,
      note: row.note ?? null,
      created_at: row.created_at,
      revoked_at: row.revoked_at ?? null,
      revoked_by: row.revoked_by ?? null,
      grantor_username: row.grantor_username,
      grantee_username: row.grantee_username,
      created_by_username: row.created_by_username,
    };
  }

  private withUsernamesSql(extraWhere = '1=1'): string {
    return `
      SELECT g.*,
        ug.username AS grantor_username,
        ue.username AS grantee_username,
        uc.username AS created_by_username
      FROM data_access_grants g
      LEFT JOIN users ug ON ug.id = g.grantor_user_id
      LEFT JOIN users ue ON ue.id = g.grantee_user_id
      LEFT JOIN users uc ON uc.id = g.created_by
      WHERE ${extraWhere}
    `;
  }

  getById(id: string): AccessGrant | null {
    const row = this.db.prepare(this.withUsernamesSql('g.id = ?')).get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  hasActiveGrant(grantorUserId: string, granteeUserId: string): boolean {
    if (!grantorUserId || !granteeUserId || grantorUserId === granteeUserId) return false;
    const row = this.db.prepare(`
      SELECT id FROM data_access_grants
      WHERE grantor_user_id = ? AND grantee_user_id = ? AND status = 'active'
      LIMIT 1
    `).get(grantorUserId, granteeUserId);
    return !!row;
  }

  /** Active grantors who shared their data with this grantee */
  listActiveGrantorIds(granteeUserId: string): string[] {
    const rows = this.db.prepare(`
      SELECT grantor_user_id FROM data_access_grants
      WHERE grantee_user_id = ? AND status = 'active'
    `).all(granteeUserId) as Array<{ grantor_user_id: string }>;
    return rows.map((r) => r.grantor_user_id);
  }

  listForUser(userId: string): { granted: AccessGrant[]; received: AccessGrant[] } {
    const grantedRows = this.db.prepare(
      this.withUsernamesSql("g.grantor_user_id = ? AND g.status = 'active'") + ' ORDER BY g.created_at DESC',
    ).all(userId) as any[];
    const receivedRows = this.db.prepare(
      this.withUsernamesSql("g.grantee_user_id = ? AND g.status = 'active'") + ' ORDER BY g.created_at DESC',
    ).all(userId) as any[];
    return {
      granted: grantedRows.map((r) => this.mapRow(r)),
      received: receivedRows.map((r) => this.mapRow(r)),
    };
  }

  listAdmin(filters: { grantorUserId?: string; granteeUserId?: string; status?: string } = {}): AccessGrant[] {
    const where: string[] = ['1=1'];
    const params: any[] = [];
    if (filters.grantorUserId) {
      where.push('g.grantor_user_id = ?');
      params.push(filters.grantorUserId);
    }
    if (filters.granteeUserId) {
      where.push('g.grantee_user_id = ?');
      params.push(filters.granteeUserId);
    }
    if (filters.status) {
      where.push('g.status = ?');
      params.push(filters.status);
    } else {
      where.push("g.status = 'active'");
    }
    const rows = this.db.prepare(
      this.withUsernamesSql(where.join(' AND ')) + ' ORDER BY g.created_at DESC',
    ).all(...params) as any[];
    return rows.map((r) => this.mapRow(r));
  }

  private resolveActiveUserByUsername(username: string): { id: string; username: string; status: string } | null {
    const row = this.db.prepare(
      'SELECT id, username, status FROM users WHERE username = ?',
    ).get(username.trim()) as any;
    return row || null;
  }

  private resolveActiveUserById(id: string): { id: string; username: string; status: string } | null {
    const row = this.db.prepare(
      'SELECT id, username, status FROM users WHERE id = ?',
    ).get(id) as any;
    return row || null;
  }

  createGrant(input: {
    grantorUserId: string;
    granteeUsername: string;
    createdBy: string;
    note?: string | null;
  }): AccessGrant {
    const grantor = this.resolveActiveUserById(input.grantorUserId);
    if (!grantor) throw new Error('授权人不存在');
    if (grantor.status !== 'active') throw new Error('授权人账号未启用');

    const grantee = this.resolveActiveUserByUsername(input.granteeUsername);
    if (!grantee) throw new Error('被授权用户不存在');
    if (grantee.status !== 'active') throw new Error('被授权用户账号未启用');
    if (grantee.id === grantor.id) throw new Error('不能授权给自己');

    if (this.hasActiveGrant(grantor.id, grantee.id)) {
      throw new Error('已存在对该用户的有效授权');
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO data_access_grants (
        id, grantor_user_id, grantee_user_id, status, created_by, note, created_at, revoked_at, revoked_by
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, NULL, NULL)
    `).run(id, grantor.id, grantee.id, input.createdBy, input.note?.trim() || null, now);

    return this.getById(id)!;
  }

  revokeGrant(id: string, revokedBy: string, allowAsAdmin = false): AccessGrant {
    const grant = this.getById(id);
    if (!grant) throw new Error('授权记录不存在');
    if (grant.status !== 'active') throw new Error('授权已撤销');

    if (!allowAsAdmin && grant.grantor_user_id !== revokedBy) {
      throw new Error('无权撤销该授权');
    }

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE data_access_grants
      SET status = 'revoked', revoked_at = ?, revoked_by = ?
      WHERE id = ?
    `).run(now, revokedBy, id);

    return this.getById(id)!;
  }
}
