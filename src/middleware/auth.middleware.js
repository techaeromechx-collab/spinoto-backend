const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

/**
 * Verifies a Bearer JWT and attaches:
 *   req.user = { id, email, is_super_admin, permissions: Set<string> }
 *
 * Permissions are loaded from the DB on every request rather than baked into
 * the JWT. That way revoking access is instant — no waiting for the token
 * to expire.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  try {
    const r = await pool.query(
      `SELECT u.id, u.name, u.email, u.is_super_admin, u.is_active, u.hub_id,
              COALESCE(ARRAY_AGG(up.permission_code) FILTER (WHERE up.permission_code IS NOT NULL), '{}') AS permissions
       FROM users u
       LEFT JOIN user_permissions up ON up.user_id = u.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [payload.sub]
    );
    if (r.rowCount === 0) return res.status(401).json({ error: 'User no longer exists' });
    const u = r.rows[0];
    if (!u.is_active) return res.status(403).json({ error: 'Account is disabled' });

    req.user = {
      id:             u.id,
      name:           u.name,
      email:          u.email,
      is_super_admin: u.is_super_admin,
      hub_id:         u.hub_id || null,
      permissions:    new Set(u.permissions),
    };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Permission gate. Usage:
 *   router.get('/admin', requireAuth, requirePermission('MANAGE_USERS'), handler)
 *   router.get('/staff', requireAuth, requirePermission('VIEW_LEAD', 'EDIT_LEAD'), handler)
 *
 * Passes if the user has ANY of the listed permissions, OR is a Super Admin.
 */
function requirePermission(...allowed) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.is_super_admin) return next();
    const granted = allowed.some((code) => req.user.permissions.has(code));
    if (!granted) {
      return res.status(403).json({
        error: `Missing permission: ${allowed.join(' or ')}`,
      });
    }
    next();
  };
}

/**
 * Like requirePermission but ALSO passes if the user is a hub user (has hub_id).
 *
 * Hub user behaviour:
 *   - If the hub user has ZERO permissions assigned → full portal access (open/default).
 *   - If the hub user has ANY permissions assigned  → they must have at least one of the
 *     `allowed` codes to pass. This lets admins restrict specific portal features per hub.
 *
 * Staff behaviour: must have at least one of the `allowed` codes (or be super admin).
 */
function requirePermissionOrHub(...allowed) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.is_super_admin) return next();

    // Staff: check explicit permission
    if (!req.user.hub_id) {
      const granted = allowed.some((code) => req.user.permissions.has(code));
      if (!granted) {
        return res.status(403).json({ error: `Missing permission: ${allowed.join(' or ')}` });
      }
      return next();
    }

    // Hub user: if they have zero permissions, allow everything (open / default access)
    if (req.user.permissions.size === 0) return next();

    // Hub user with assigned permissions: must have one of the allowed codes
    const granted = allowed.some((code) => req.user.permissions.has(code));
    if (!granted) {
      return res.status(403).json({ error: `Missing permission: ${allowed.join(' or ')}` });
    }
    next();
  };
}

/** Blocks anyone who is not a super admin. */
function requireSuperAdmin(req, res, next) {
  if (!req.user?.is_super_admin) {
    return res.status(403).json({ error: 'Super admin access required.' });
  }
  next();
}

module.exports = { requireAuth, requirePermission, requirePermissionOrHub, requireSuperAdmin };
