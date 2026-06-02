const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/locations.controller');

const router = express.Router();

// Reads — any authenticated user (callers need them for the lead form).
router.get('/states', requireAuth, c.listStates);
router.get('/cities', requireAuth, c.listCities);
router.get('/areas',  requireAuth, c.listAreas);

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
