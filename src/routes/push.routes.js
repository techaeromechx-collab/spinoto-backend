const router = require('express').Router();
const { requireAuth } = require('../middleware/auth.middleware');
const {
  subscribe, unsubscribe, adminStats, adminTest, vapidPublicKey,
} = require('../controllers/push.controller');

// Public — frontend needs this before user logs in to subscribe
router.get('/vapid-public-key', vapidPublicKey);

// All routes below require authentication
router.use(requireAuth);

router.post('/subscribe',   subscribe);
router.delete('/subscribe', unsubscribe);

// Super admin routes
router.get('/admin/stats',  adminStats);
router.post('/admin/test',  adminTest);

module.exports = router;
