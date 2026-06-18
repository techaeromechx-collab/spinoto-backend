const express = require('express');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const c = require('../controllers/services.controller');

const router = express.Router();

// ── Reads — authenticated users with VIEW_SERVICE or MANAGE_MASTER_DATA ───────
// Hub users also need read access for estimate creation — accept estimate permissions as implicit VIEW_SERVICE
const canView    = [requireAuth, requirePermissionOrHub('VIEW_SERVICE', 'MANAGE_MASTER_DATA', 'MANAGE_PRICING', 'VIEW_ESTIMATE', 'CREATE_ESTIMATE', 'EDIT_ESTIMATE')];
const canCreate  = [requireAuth, requirePermission('CREATE_SERVICE', 'MANAGE_MASTER_DATA')];
const canUpdate  = [requireAuth, requirePermission('UPDATE_SERVICE', 'MANAGE_MASTER_DATA')];
const canDestroy = [requireAuth, requirePermission('DELETE_SERVICE', 'MANAGE_MASTER_DATA')];

// Categories
router.get   ('/categories',          canView,    c.listCategories);
router.post  ('/categories',          canCreate,  c.createCategory);
router.post  ('/categories/reorder',  canUpdate,  c.reorderCategories);
router.patch ('/categories/:id',      canUpdate,  c.updateCategory);
router.delete('/categories/:id',      canDestroy, c.deleteCategory);

// Services
router.get   ('/services',          canView,    c.listServices);
router.get   ('/services/:id',      canView,    c.getService);
router.post  ('/services',          canCreate,  c.createService);
router.post  ('/services/reorder',  canUpdate,  c.reorderServices);
router.patch ('/services/:id',      canUpdate,  c.updateService);
router.delete('/services/:id',      canDestroy, c.deleteService);

module.exports = router;
