import type { Queryable } from '../database/database.service';

// The caller supplies its transaction so the audit commits with the protected mutation.
export async function recordAdminAudit(
  database: Queryable,
  accessedUserId: string,
  adminId: string,
  adminRole: 'admin' | 'superadmin',
  action: 'view_profile' | 'admin_ban' | 'admin_unban' | 'admin_reconcile_photo',
  reason: string,
): Promise<void> {
  await database.query(`
    INSERT INTO data_access_log (
      accessed_user_id, accessor_id, accessor_role, action, reason
    ) VALUES ($1, $2, $3, $4, $5)
  `, [accessedUserId, adminId, adminRole, action, reason]);
}
