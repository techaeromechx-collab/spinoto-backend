const express       = require('express');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth.middleware');
const c             = require('../controllers/roles.controller');

const router = express.Router();

// All role endpoints require super admin
router.get   ('/',                          requireAuth, requireSuperAdmin, c.listRoles);
router.get   ('/:id',                       requireAuth, requireSuperAdmin, c.getRole);
router.post  ('/',                          requireAuth, requireSuperAdmin, c.createRole);
router.put   ('/:id',                       requireAuth, requireSuperAdmin, c.updateRole);
router.delete('/:id',                       requireAuth, requireSuperAdmin, c.deleteRole);

// Apply a role's permissions to a specific user (super admin only)
router.post  ('/:id/apply/:userId',         requireAuth, requireSuperAdmin, c.applyRoleToUser);

module.exports = router;
