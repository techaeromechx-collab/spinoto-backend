'use strict';

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/settings.controller');

const router = express.Router();

// Readable by anyone who generates or views invoices/estimates (needed for PDF header)
router.get('/company', requireAuth, requirePermission('MANAGE_MASTER_DATA','VIEW_INVOICE','CREATE_INVOICE','EDIT_INVOICE','VIEW_ESTIMATE','CREATE_ESTIMATE','EDIT_ESTIMATE'), c.getCompany);

// Only users with MANAGE_MASTER_DATA (or super admin) can write company settings
router.put('/company', requireAuth, requirePermission('MANAGE_MASTER_DATA'), c.upsertCompany);

// Alert threshold settings — super admin only (controller enforces this)
router.get('/alert', requireAuth, c.getAlertSettings);
router.put('/alert', requireAuth, c.upsertAlertSettings);

module.exports = router;
