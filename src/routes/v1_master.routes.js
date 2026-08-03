'use strict';

/**
 * /api/v1/master — read-only master data for machine callers.
 *
 * Every route is GET and every route carries its own scope. There is no
 * blanket router-level guard: a scope declared next to the handler it protects
 * cannot drift away from it, and adding a route without thinking about access
 * is then impossible rather than merely discouraged.
 *
 * No requireAuth anywhere here. These are key-authenticated system callers,
 * never logged-in humans — see middleware/apiKey.middleware.js.
 */

const express = require('express');
const { requireApiScope } = require('../middleware/apiKey.middleware');
const c = require('../controllers/v1_master.controller');

const router = express.Router();

// Self-description, so an integrator can see what a key can reach without
// reading our docs — and without it revealing anything: it echoes only the
// scopes the presented key already holds.
router.get('/', requireApiScope('services:read'), (req, res) => {
  res.json({
    version: 'v1',
    key: req.apiKey.name,
    scopes: req.apiKey.scopes,
    endpoints: {
      services:    'GET /api/v1/master/services',
      categories:  'GET /api/v1/master/service-categories',
      parts:       'GET /api/v1/master/parts',
      vehicles:    `GET /api/v1/master/vehicles/{${Object.keys(c.VEHICLE_SETS).join('|')}}`,
      discounts:   'GET /api/v1/master/discounts',
      hubs:        'GET /api/v1/master/hubs',
      price:       'GET /api/v1/master/price?service_id=&make_id=&model_id=…',
    },
    paging: { default_per_page: c.DEF_PER_PAGE, max_per_page: c.MAX_PER_PAGE },
  });
});

router.get('/services',           requireApiScope('services:read'),  c.listServices);
router.get('/service-categories', requireApiScope('services:read'),  c.listCategories);
router.get('/parts',              requireApiScope('parts:read'),     c.listParts);
router.get('/vehicles/:set',      requireApiScope('vehicles:read'),  c.listVehicleSet);
router.get('/discounts',          requireApiScope('discounts:read'), c.listDiscounts);
router.get('/hubs',               requireApiScope('hubs:read'),      c.listHubs);

// Needs BOTH: a resolved price is a service and its price. A key holding only
// services:read can list the catalogue but not read what anyone is charged.
router.get('/price', requireApiScope('services:read', 'pricing:read'), c.getPrice);

module.exports = router;
