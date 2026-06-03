'use strict';

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/parts.controller');

const router = express.Router();

const canRead   = [requireAuth, requirePermission('MANAGE_PARTS', 'CREATE_PART', 'EDIT_PART', 'DELETE_PART', 'MANAGE_MASTER_DATA','VIEW_ESTIMATE','CREATE_ESTIMATE','EDIT_ESTIMATE','VIEW_INVOICE','CREATE_INVOICE','EDIT_INVOICE')];
const canCreate = [requireAuth, requirePermission('CREATE_PART', 'MANAGE_PARTS', 'MANAGE_MASTER_DATA')];
const canEdit   = [requireAuth, requirePermission('EDIT_PART',   'MANAGE_PARTS', 'MANAGE_MASTER_DATA')];
const canDelete = [requireAuth, requirePermission('DELETE_PART', 'MANAGE_PARTS', 'MANAGE_MASTER_DATA')];

router.get('/',       canRead,   c.listParts);
router.post('/',      canCreate, c.createPart);
router.patch('/:id',  canEdit,   c.updatePart);
router.delete('/:id', canDelete, c.deletePart);

module.exports = router;
