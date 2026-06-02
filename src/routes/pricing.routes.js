const express = require('express');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const c = require('../controllers/pricing.controller');

const router = express.Router();

// ── Permission sets ───────────────────────────────────────────────────────────
// Hub users need read access so the hub portal Services & Pricing tab can display prices.
// requirePermissionOrHub passes if the user has the permission OR is a hub user (has hub_id).
const canView    = [requireAuth, requirePermissionOrHub('VIEW_PRICING_RULE', 'MANAGE_PRICING', 'MANAGE_MASTER_DATA')];
const canCreate  = [requireAuth, requirePermission('CREATE_PRICING_RULE', 'MANAGE_PRICING', 'MANAGE_MASTER_DATA')];
const canUpdate  = [requireAuth, requirePermission('UPDATE_PRICING_RULE', 'MANAGE_PRICING', 'MANAGE_MASTER_DATA')];
const canToggle  = [requireAuth, requirePermission('TOGGLE_PRICING_STATUS', 'UPDATE_PRICING_RULE', 'MANAGE_PRICING', 'MANAGE_MASTER_DATA')];
const canDestroy = [requireAuth, requirePermission('DELETE_PRICING_RULE', 'MANAGE_PRICING', 'MANAGE_MASTER_DATA')];

router.get   ('/',            canView,    c.listPricing);
router.get   ('/lookup',      canView,    c.lookupPrice);   // must be before /:id
router.post  ('/',            canCreate,  c.createPricing);
router.patch ('/:id',         canUpdate,  c.updatePricing);
router.patch ('/:id/status',  canToggle,  c.togglePricingStatus);
router.delete('/:id',         canDestroy, c.deletePricing);

module.exports = router;
