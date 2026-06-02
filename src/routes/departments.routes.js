const express = require('express');
const router  = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const {
  listDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
} = require('../controllers/departments.controller');

// Readable by anyone who works with leads, appointments, or master data
router.get('/',     requireAuth, requirePermission('CREATE_LEAD','VIEW_LEAD','VIEW_TEAM_LEADS','VIEW_OWN_LEADS','VIEW_APPOINTMENT','CREATE_APPOINTMENT','EDIT_APPOINTMENT','MANAGE_MASTER_DATA'), listDepartments);

// Write operations require MANAGE_MASTER_DATA
router.post('/',    requireAuth, requirePermission('MANAGE_MASTER_DATA'), createDepartment);
router.patch('/:id', requireAuth, requirePermission('MANAGE_MASTER_DATA'), updateDepartment);
router.delete('/:id', requireAuth, requirePermission('MANAGE_MASTER_DATA'), deleteDepartment);

module.exports = router;
