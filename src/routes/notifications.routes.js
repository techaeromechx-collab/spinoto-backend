const router = require('express').Router();
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const {
  listNotifications, unreadCount, markRead, markAllRead, clearAll,
} = require('../controllers/notifications.controller');

// All routes below require authentication.
// Own-notification routes are open to every logged-in user (results are
// always filtered to req.user.id in the controller, so no data leaks).
// VIEW_ALL_NOTIFICATIONS is reserved for a future admin/team-wide view.
router.use(requireAuth);

router.get('/',              listNotifications);
router.get('/unread-count',  unreadCount);
router.patch('/read-all',    markAllRead);
router.delete('/',           clearAll);
router.patch('/:id/read',    markRead);

module.exports = router;
