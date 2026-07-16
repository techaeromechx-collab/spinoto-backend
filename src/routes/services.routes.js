const express = require('express');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const c = require('../controllers/services.controller');
const { cacheGet } = require('../utils/responseCache');

const router = express.Router();

// ── Reads — authenticated users with VIEW_SERVICE or MANAGE_MASTER_DATA ───────
// Hub users also need read access for estimate creation — accept estimate permissions as implicit VIEW_SERVICE
const canView    = [requireAuth, requirePermissionOrHub('VIEW_SERVICE', 'MANAGE_MASTER_DATA', 'MANAGE_PRICING', 'VIEW_ESTIMATE', 'CREATE_ESTIMATE', 'EDIT_ESTIMATE')];
const canCreate  = [requireAuth, requirePermission('CREATE_SERVICE', 'MANAGE_MASTER_DATA')];
const canUpdate  = [requireAuth, requirePermission('UPDATE_SERVICE', 'MANAGE_MASTER_DATA')];
const canDestroy = [requireAuth, requirePermission('DELETE_SERVICE', 'MANAGE_MASTER_DATA')];
// Assign/unassign a service to a hub mutates hub_service_mappings — gate with the
// same permissions as the Hub page's own "Manage Services" endpoint.
const canManageHub = [requireAuth, requirePermission('EDIT_HUB', 'MANAGE_HUBS')];

// Categories
// Shared/non-per-user reference data, changes only via Master Data edits —
// cached and invalidated the same way as vehicles (see vehicles.routes.js).
router.get   ('/categories',          canView,    cacheGet('services'), c.listCategories);
router.post  ('/categories',          canCreate,  c.createCategory);
router.post  ('/categories/reorder',  canUpdate,  c.reorderCategories);
router.patch ('/categories/:id',      canUpdate,  c.updateCategory);
router.delete('/categories/:id',      canDestroy, c.deleteCategory);
router.get   ('/categories/:id/hubs', canView,      c.getCategoryHubs);
router.post  ('/categories/:id/hubs', canManageHub, c.assignCategoryToHub);
router.delete('/categories/:id/hubs/:hubId', canManageHub, c.unassignCategoryFromHub);

// Services
router.get   ('/services',          canView,    cacheGet('services'), c.listServices);
router.get   ('/services/:id',      canView,    c.getService);
router.get   ('/services/:id/hubs', canView,      c.getServiceHubs);
router.post  ('/services/:id/hubs', canManageHub, c.assignServiceToHub);
router.delete('/services/:id/hubs/:hubId', canManageHub, c.unassignServiceFromHub);
router.post  ('/services',          canCreate,  c.createService);
router.post  ('/services/reorder',  canUpdate,  c.reorderServices);
router.patch ('/services/:id',      canUpdate,  c.updateService);
router.delete('/services/:id',      canDestroy, c.deleteService);

module.exports = router;
