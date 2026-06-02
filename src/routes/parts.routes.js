'use strict';

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/parts.controller');

const router = express.Router();

const canRead   = [requireAuth, requirePermission('MANAGE_PARTS', 'MANAGE_MASTER_DATA','VIEW_ESTIMATE','CREATE_ESTIMATE','EDIT_ESTIMATE','VIEW_INVOICE','CREATE_INVOICE','EDIT_INVOICE')];
const canWrite  = [requireAuth, requirePermission('MANAGE_PARTS', 'MANAGE_MASTER_DATA')];

router.get('/',    canRead,  c.listParts);
router.post('/',   canWrite, c.createPart);
router.patch('/:id', canWrite, c.updatePart);
router.delete('/:id', canWrite, c.deletePart);

module.exports = router;
