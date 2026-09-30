'use strict';

const express = require('express');
const { requireAuth, requirePermissionOrHub } = require('../middleware/auth.middleware');
const c = require('../controllers/technicians.controller');

const router = express.Router();

/* requirePermissionOrHub, unlike the checklist routes — and the difference is
   the point. A hub DESIGNS no checklists, but it is the only party that knows
   who works on its floor this week. So a hub login manages its own staff, and
   the controller pins every read and write to req.user.hub_id so "its own" is
   enforced in SQL rather than trusted from the request. */
const canManage = [requireAuth, requirePermissionOrHub(
  'MANAGE_MASTER_DATA', 'MANAGE_HUBS', 'EDIT_HUB',
)];

/* ── READING THE ROSTER IS NOT MANAGING IT ───────────────────────────────────
   The list is gated more widely than the writes, because two different jobs
   need it. Editing the roster is master data. READING it is what every job
   card does — assigning a technician, naming who did the work, picking the QC
   signer — and those screens belong to people with appointment permissions,
   not master-data ones.

   Without this split, a service advisor opened a job card, the dropdown came
   back 403, the page swallowed the error, and the screen told them the hub had
   no technicians. It has them; the advisor just could not read the list. Found
   by driving the page in a browser as a user who was not a super admin.

   The controller still pins a hub login to its own hub in SQL, so widening who
   may read widens nothing about WHAT they may read. */
const canRead = [requireAuth, requirePermissionOrHub(
  'MANAGE_MASTER_DATA', 'MANAGE_HUBS', 'EDIT_HUB',
  'VIEW_APPOINTMENT', 'CREATE_APPOINTMENT', 'EDIT_APPOINTMENT',
)];

router.get   ('/',    canRead,   c.listTechnicians);
router.post  ('/',    canManage, c.createTechnician);
router.patch ('/:id', canManage, c.updateTechnician);
router.delete('/:id', canManage, c.deleteTechnician);

module.exports = router;
