const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/opening_balances.controller');

const router = express.Router();

/* MANAGE_OPENING_BALANCE is granted to no role by default (migration 186),
   like MANAGE_CREDIT_NOTE. Both are the same class of power — changing what a
   party appears to owe without an invoice behind it — but they are separate
   permissions on purpose, so a business that wants one person raising credit
   notes and a different person setting opening balances can have that.

   requirePermission, not requirePermissionOrHub: a zero-permission hub login
   would otherwise be waved straight through. The controller refuses hub users
   again in case this route is ever copied. */
const canManage = [requireAuth, requirePermission('MANAGE_OPENING_BALANCE')];
const canView   = [requireAuth, requirePermission('MANAGE_OPENING_BALANCE', 'VIEW_INVOICE')];

router.get('/',            canView,   c.getOpeningBalance);
router.get('/candidates',  canView,   c.listCandidates);
router.put('/',            canManage, c.setOpeningBalance);
router.delete('/:party_type/:party_key', canManage, c.clearOpeningBalance);

module.exports = router;
