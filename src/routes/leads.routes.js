const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/leads.controller');

const router = express.Router();

// price-lookup — open to anyone who can view or create leads
router.post('/price-lookup', requireAuth, requirePermission('VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS', 'CREATE_LEAD'), c.lookupPrice);

// export — must have EXPORT_LEADS; must be before /:id route
router.get('/export', requireAuth, requirePermission('EXPORT_LEADS'), c.exportLeads);

// stage conversion stats — before /:id
router.get('/stage-stats', requireAuth, requirePermission('VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS'), c.getStageStats);

// duplicate mobile check — before /:id
router.get('/check-mobile', requireAuth, requirePermission('VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS', 'CREATE_LEAD'), c.checkMobile);

// LIST: any of the three view-level permissions grants access; filtering happens inside the controller
router.get ('/',     requireAuth, requirePermission('VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS'), c.listLeads);
router.post('/',    requireAuth, requirePermission('CREATE_LEAD'), c.createLead);
router.post('/bulk-assign',  requireAuth, requirePermission('EDIT_LEAD'),   c.bulkAssign);
router.post('/bulk-delete',  requireAuth, requirePermission('DELETE_LEAD'), c.bulkDelete);
router.get ('/:id', requireAuth, requirePermission('VIEW_LEAD', 'VIEW_TEAM_LEADS', 'VIEW_OWN_LEADS'), c.getLead);
router.patch('/:id', requireAuth, requirePermission('EDIT_LEAD'),  c.updateLead);
router.delete('/:id', requireAuth, requirePermission('DELETE_LEAD'), c.deleteLead);

module.exports = router;
