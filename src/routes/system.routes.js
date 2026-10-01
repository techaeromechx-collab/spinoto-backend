'use strict';

/**
 * Settings → System Health.
 *
 * Super admin only, and that is the whole access rule. This page names
 * migration files, the Node version and the environment, which tell an attacker
 * which release is running and therefore which bugs it still has — and no
 * advisor has any use for them. Same bar as Print Settings and Super Admins.
 *
 * requireSuperAdmin rather than a permission code, deliberately: a permission
 * would need its own migration to exist, and this page cannot depend on a
 * migration having run when its entire job is reporting that migrations have
 * not run.
 */

const { Router } = require('express');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/system.controller');

const router = Router();

router.get('/health', requireAuth, requireSuperAdmin, ctrl.getHealth);

module.exports = router;
