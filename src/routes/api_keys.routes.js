'use strict';

/**
 * /api/api-keys — the admin side of master-data API access.
 *
 * requireAuth + MANAGE_API_KEYS on every route. Not requirePermissionOrHub:
 * a hub user has no business minting credentials that read the whole price
 * list, and the "OrHub" variants exist for operational reads, not for this.
 */

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/api_keys.controller');

const router = express.Router();

const canManage = [requireAuth, requirePermission('MANAGE_API_KEYS')];

router.get('/',            canManage, c.listApiKeys);
router.post('/',           canManage, c.createApiKey);
// DELETE, but it is a revoke: the row stays so a cut-off partner remains
// auditable. See the controller.
router.delete('/:id',      canManage, c.revokeApiKey);

module.exports = router;
