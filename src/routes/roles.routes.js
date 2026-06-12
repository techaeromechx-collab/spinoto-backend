const express       = require('express');
const { requireAuth, requireSuperAdmin, requirePermission } = require('../middleware/auth.middleware');
const c             = require('../controllers/roles.controller');

const router = express.Router();

// Read: MANAGE_USERS may list/view roles (needed for the role dropdown on the
// Users page — it was silently empty for non-super-admin managers before).
// requirePermission always passes super admins automatically.
router.get   ('/',                          requireAuth, requirePermission('MANAGE_USERS'), c.listRoles);
router.get   ('/:id',                       requireAuth, requirePermission('MANAGE_USERS'), c.getRole);

// Writes: super admin only
router.post  ('/',                          requireAuth, requireSuperAdmin, c.createRole);
router.put   ('/:id',                       requireAuth, requireSuperAdmin, c.updateRole);
router.delete('/:id',                       requireAuth, requireSuperAdmin, c.deleteRole);

// Apply a role's permissions to a specific user (super admin only)
router.post  ('/:id/apply/:userId',         requireAuth, requireSuperAdmin, c.applyRoleToUser);

module.exports = router;
