const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c  = require('../controllers/leads.controller');
const cl = require('../controllers/call_logs.controller');

const router = express.Router();

// price-lookup — open to anyone who can view or create leads
router.post('/price-lookup', requireAuth, requirePermission('VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS', 'CREATE_LEAD'), c.lookupPrice);

// export — must have EXPORT_LEADS; must be before /:id route
router.get('/export', requireAuth, requirePermission('EXPORT_LEADS'), c.exportLeads);

// stage conversion stats — before /:id
router.get('/stage-stats', requireAuth, requirePermission('VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS'), c.getStageStats);

// duplicate mobile check — before /:id
router.get('/check-mobile', requireAuth, requirePermission('VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS', 'CREATE_LEAD'), c.checkMobile);

// Call log summary — must be before /:id
router.get('/calls/summary', requireAuth, requirePermission('VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS'), cl.getCallSummary);

// LIST: any of the three view-level permissions grants access; filtering happens inside the controller
router.get ('/',     requireAuth, requirePermission('VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS'), c.listLeads);
router.post('/',    requireAuth, requirePermission('CREATE_LEAD'), c.createLead);
router.post('/bulk-assign',  requireAuth, requirePermission('EDIT_LEAD'),   c.bulkAssign);
// Same permission as a single status change (PATCH /:id below) — doing it to
// fifty leads at once is the same act, not a more privileged one.
router.post('/bulk-status',  requireAuth, requirePermission('EDIT_LEAD'),   c.bulkStatus);
router.post('/bulk-delete',  requireAuth, requirePermission('DELETE_LEAD'), c.bulkDelete);
// by-token — resolves a shareable-URL token to a lead; must be before /:id
router.get ('/by-token/:token', requireAuth, requirePermission('VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS'), c.getLeadByToken);
router.get ('/:id', requireAuth, requirePermission('VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS'), c.getLead);
router.patch('/:id', requireAuth, requirePermission('EDIT_LEAD'),  c.updateLead);
router.delete('/:id', requireAuth, requirePermission('DELETE_LEAD'), c.deleteLead);

// Call logs per lead
router.get ('/:id/calls', requireAuth, requirePermission('VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS'), cl.getLeadCallLogs);
router.post('/:id/calls', requireAuth, requirePermission('EDIT_LEAD'), cl.createCallLog);

module.exports = router;
