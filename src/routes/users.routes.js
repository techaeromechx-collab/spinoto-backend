const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/users.controller');

const router = express.Router();

// Catalog of permission codes — used by the frontend permission picker.
// Available to anyone with MANAGE_USERS so the page can render.
router.get('/permissions', requireAuth, requirePermission('MANAGE_USERS'), c.listCatalog);

// Write operations — MANAGE_USERS only.
const canManage = [requireAuth, requirePermission('MANAGE_USERS')];

// Read operations — MANAGE_USERS gets all users; VIEW_TEAM_LEADS gets own team only.
const canRead = [requireAuth, requirePermission('MANAGE_USERS', 'VIEW_TEAM_LEADS')];

// Lightweight assignable list — any user who can touch leads or manage hubs can see this.
// Returns only {id, name}, no permissions or sensitive data.
const canAssign = [requireAuth, requirePermission(
  'MANAGE_USERS', 'VIEW_TEAM_LEADS', 'VIEW_LEAD', 'VIEW_OWN_LEADS',
  'CREATE_LEAD', 'EDIT_LEAD', 'ASSIGN_LEAD',
  'CREATE_HUB', 'EDIT_HUB', 'MANAGE_HUBS',
)];
router.get('/assignable', canAssign, c.listAssignableUsers);

router.get   ('/',    canRead,   c.listUsers);
router.post  ('/',    canManage, c.createUser);
router.get   ('/:id', canRead,   c.getUser);
router.patch ('/:id', canManage, c.updateUser);
router.delete('/:id', canManage, c.deleteUser);

// MANAGE_USERS = full access; MANAGE_TEAM_PERMISSIONS = scoped to own team only (enforced in controller)
router.put   ('/:id/permissions', requireAuth, requirePermission('MANAGE_USERS', 'MANAGE_TEAM_PERMISSIONS'), c.setUserPermissions);

module.exports = router;
