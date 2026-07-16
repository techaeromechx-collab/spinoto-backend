const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/locations.controller');
const { cacheGet } = require('../utils/responseCache');

const router = express.Router();

// Reads — any authenticated user (callers need them for the lead form).
// Shared reference data, cached — invalidated on Master Data edits.
router.get('/states', requireAuth, cacheGet('locations'), c.listStates);
router.get('/cities', requireAuth, cacheGet('locations'), c.listCities);
router.get('/areas',  requireAuth, cacheGet('locations'), c.listAreas);

// Writes — anyone with MANAGE_MASTER_DATA.
const canManage = [requireAuth, requirePermission('MANAGE_MASTER_DATA')];

router.post  ('/states',     canManage, c.createState);
router.patch ('/states/:id', canManage, c.updateState);
router.delete('/states/:id', canManage, c.deleteState);

router.post  ('/cities',     canManage, c.createCity);
router.patch ('/cities/:id', canManage, c.updateCity);
router.delete('/cities/:id', canManage, c.deleteCity);

router.post  ('/areas',     canManage, c.createArea);
router.patch ('/areas/:id', canManage, c.updateArea);
router.delete('/areas/:id', canManage, c.deleteArea);

module.exports = router;
