import { Request } from 'express';
import { AccessGrantService } from './accessGrantService';

export type AccessActor = {
  id: string;
  username?: string;
  role?: string;
};

/**
 * Central access helper for owner-scoped resources.
 * - Owner and admin always pass.
 * - Active data_access_grants allow grantee to view/operate grantor's existing data.
 * - CREATE paths must still write actor.id (no act-as).
 */
export class AccessControl {
  constructor(private grants: AccessGrantService) {}

  static actorFromRequest(req: Request): AccessActor | null {
    const u = (req as any).user;
    if (!u?.id) return null;
    return { id: String(u.id), username: u.username, role: u.role };
  }

  canAccessOwner(actor: AccessActor | null | undefined, ownerId: string | null | undefined): boolean {
    if (!actor?.id) return false;
    if (!ownerId) return false;
    if (actor.id === ownerId) return true;
    if (actor.role === 'admin') return true;
    return this.grants.hasActiveGrant(ownerId, actor.id);
  }

  /**
   * Owner ids whose data the actor may list/operate.
   * Admin is NOT expanded to all users here — modules keep their own ?all=1 / isAdmin list paths.
   */
  listAccessibleOwnerIds(actor: AccessActor | null | undefined): string[] {
    if (!actor?.id) return [];
    const ids = new Set<string>([actor.id]);
    for (const grantorId of this.grants.listActiveGrantorIds(actor.id)) {
      ids.add(grantorId);
    }
    return Array.from(ids);
  }

  /** Whether actor may access a resource owned by ownerId (null owner treated as inaccessible to grantees; admin still ok). */
  canAccessResource(actor: AccessActor | null | undefined, ownerId: string | null | undefined): boolean {
    if (!actor?.id) return false;
    if (actor.role === 'admin') return true;
    if (!ownerId) return actor.id === ownerId; // only empty match — typically deny
    return this.canAccessOwner(actor, ownerId);
  }
}

/** Build SQL IN placeholders for owner id lists. */
export function ownerInClause(ownerIds: string[]): { sql: string; params: string[] } {
  if (!ownerIds.length) {
    return { sql: '0', params: [] };
  }
  return {
    sql: ownerIds.map(() => '?').join(', '),
    params: [...ownerIds],
  };
}

export type AccessOpts = {
  access: AccessControl;
  actor: AccessActor;
};

/** Shared ownership check used by getOwned helpers. */
export function ownsOrGranted(
  ownerId: string | null | undefined,
  userId: string,
  opts?: AccessOpts,
): boolean {
  if (opts?.access && opts?.actor) {
    return opts.access.canAccessOwner(opts.actor, ownerId);
  }
  return !!ownerId && ownerId === userId;
}
