'use strict';
const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/competitors.controller');

const router = express.Router();

// Read — the lost-reason popup offers this list, so anyone working a lead needs it.
router.get('/', requireAuth, requirePermission('VIEW_LEAD', 'CREATE_LEAD', 'EDIT_LEAD', 'MANAGE_MASTER_DATA'), c.listCompetitors);

// Manage — master data admins only.
router.post('/reorder', requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.reorderCompetitors);
router.post('/',        requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.createCompetitor);
router.patch('/:id',    requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.updateCompetitor);
router.delete('/:id',   requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.deleteCompetitor);

module.exports = router;
