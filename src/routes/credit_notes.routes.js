const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/credit_notes.controller');

const router = express.Router();

/* MANAGE_CREDIT_NOTE is granted to NO role by default (migration 185).
   Issuing a credit note reduces revenue and tax liability, so who may do it is
   a decision for the business rather than a default chosen by a migration.
   Assign it in the roles screen; super admins bypass permissions already.

   requirePermission, deliberately NOT requirePermissionOrHub: a hub must not
   be able to reduce what it owes or what it is owed, and the controller
   refuses hub logins a second time in case this route is ever copied. */
const canManage = [requireAuth, requirePermission('MANAGE_CREDIT_NOTE')];

/* Reading is tied to seeing invoices — anyone who can see what was billed
   should be able to see what was credited against it. A list of credits with
   no way to see them is how a reversal goes unnoticed. */
const canView = [requireAuth, requirePermission('MANAGE_CREDIT_NOTE', 'VIEW_INVOICE')];

router.get('/',          canView,   c.listCreditNotes);
router.get('/:id',       canView,   c.getCreditNote);
router.post('/',         canManage, c.createCreditNote);
router.post('/:id/cancel', canManage, c.cancelCreditNote);

module.exports = router;
