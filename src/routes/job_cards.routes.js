'use strict';

const express = require('express');
const { requireAuth, requirePermission, requirePermissionOrHub } = require('../middleware/auth.middleware');
const c = require('../controllers/job_cards.controller');
const i = require('../controllers/job_card_inspections.controller');
const g = require('../controllers/job_card_gates.controller');
const p = require('../controllers/job_card_parts.controller');

const router = express.Router();

/* ── WHICH PERMISSION ────────────────────────────────────────────────────────
   This file used to argue that no job-card permission should exist, on the
   grounds that a job card IS the appointment, worked. That reasoning was right
   about the data and wrong about the people. The workshop floor and the call
   centre are not the same audience: an agent who books and reschedules has no
   business opening the card, and a QC inspector has no business editing parts
   or labour. Neither can be expressed while both screens share one permission.

   So there are now four codes — see the block in utils/permissions.js — and
   the appointment codes are NOT accepted here any more. That is the whole
   point: a gate that still honours EDIT_APPOINTMENT can only ever ADD access,
   never withhold it, so the separation would be decorative.

   Migration 203 does the day-one grant this file used to object to, in both
   places that hold a permission set: user_permissions and roles.permissions.
   Nobody loses access on deploy; from then on the boxes mean something.

   requirePermissionOrHub throughout, unchanged, and unlike the checklist
   routes: the hub floor IS the audience for this screen. A hub login with
   nothing ticked keeps working exactly as it does today; one that has ANY
   permission set already had to hold the specific code, and now that code is
   the job-card one. Every handler pins reads and writes to req.user.hub_id in
   SQL, so "its own" is enforced there rather than trusted from the request. */
const canView  = [requireAuth, requirePermissionOrHub('VIEW_JOB_CARD', 'EDIT_JOB_CARD')];
const canEdit  = [requireAuth, requirePermissionOrHub('EDIT_JOB_CARD')];
const canAdmin = [requireAuth, requirePermission('MANAGE_MASTER_DATA')];

/* ── And the sheet, separately ───────────────────────────────────────────────
   A QC inspector holds VIEW_JOB_CARD (a sheet is opened from its card, so the
   card has to load) plus these two, and nothing else. They can answer and
   complete a 44-point checklist and cannot touch a single part or labour row.

   canSign takes EITHER, deliberately. job_card_signatures has a NULLABLE
   inspection_id: the same endpoint serves a signature ON a sheet and a
   card-level sign-off at intake or delivery. Refusing the inspector here would
   mean they could complete a sheet but not sign it off, which is not a
   restriction, it is a dead end. The handler already verifies that a supplied
   inspection_id belongs to this card, and deleting a signature is gated again
   inside the handler to super admin only. */
const canViewInsp = [requireAuth, requirePermissionOrHub('VIEW_INSPECTION', 'EDIT_INSPECTION')];
const canEditInsp = [requireAuth, requirePermissionOrHub('EDIT_INSPECTION')];
const canSign     = [requireAuth, requirePermissionOrHub('EDIT_INSPECTION', 'EDIT_JOB_CARD')];

/* ── ORDER IS LOAD-BEARING ───────────────────────────────────────────────────
   Express matches top to bottom. '/settings' and '/by-appointment/:x' must sit
   above '/:id' or '/:id' swallows them — ':id' happily matches the literal
   string 'settings' and the request dies in the Zod coercion with a 400 that
   says nothing useful about why. */
/* Reading the toggles is for everyone who opens a card; CHANGING them is
   master data — a hub switching off "items in vehicle" changes what the
   business can prove, so it is not the hub's decision to make alone.

   MANAGE_MASTER_DATA is accepted on the READ as well. Without it the person who
   administers these settings can write them and not see them, which was true
   before this change too and is a trap either way: nobody should have to hold a
   second permission to read back what they are allowed to set. */
router.get   ('/settings', [requireAuth, requirePermissionOrHub(
  'VIEW_JOB_CARD', 'EDIT_JOB_CARD', 'MANAGE_MASTER_DATA')], c.getSettings);
router.patch ('/settings', canAdmin, c.updateSettings);

router.get   ('/by-appointment/:appointmentId', canView, c.getByAppointment);
/* Above '/:id' for the same reason '/settings' is: ':id' matches the literal
   string 'counts' and the request dies in Zod with a 400 about nothing. */
router.get   ('/counts', canView, c.listJobCardCounts);

router.get   ('/',    canView, c.listJobCards);
router.post  ('/',    canEdit, c.openJobCard);
router.get   ('/:id', canView, c.getJobCard);
router.patch ('/:id', canEdit, c.updateJobCard);
router.delete('/:id', canEdit, c.deleteJobCard);

router.patch ('/:id/status', canEdit, c.setStatus);
router.post  ('/:id/notes',  canEdit, c.addNote);
/* The card's history, paged. Read-only and canView, because seeing what was
   done to a vehicle is not a privilege above seeing the vehicle. */
router.get   ('/:id/activities', canView, c.listActivities);

router.post  ('/:id/complaints',              canEdit, c.addComplaint);
router.patch ('/:id/complaints/:complaintId', canEdit, c.updateComplaint);
router.delete('/:id/complaints/:complaintId', canEdit, c.deleteComplaint);

router.post  ('/:id/technicians',        canEdit, c.addTechnician);
router.patch ('/:id/technicians/:rowId', canEdit, c.updateTechnicianRow);
router.delete('/:id/technicians/:rowId', canEdit, c.removeTechnician);

router.put   ('/:id/items', canEdit, c.replaceItems);

router.post  ('/:id/media',          canEdit, c.addMedia);
router.delete('/:id/media/:mediaId', canEdit, c.deleteMedia);

/* ── Inspections, signatures and the body diagram ────────────────────────────
   All nested under a card because all of them are meaningless without one, and
   because nesting is what lets every handler start from loadCard — the single
   hub-ownership check in this module.

   '/inspection-templates' sits above '/inspections/:inspectionId' for the same
   reason '/settings' sits above '/:id': Express matches in order, and a
   literal segment placed below a parameter is a segment that never matches. */
router.get   ('/:id/inspection-templates', canViewInsp, i.listTemplatesForCard);

router.get   ('/:id/inspections',     canViewInsp, i.listInspections);
router.post  ('/:id/inspections',     canEditInsp, i.startInspection);
router.get   ('/:id/inspections/:inspectionId',         canViewInsp, i.getInspection);
router.patch ('/:id/inspections/:inspectionId',         canEditInsp, i.updateInspection);
router.delete('/:id/inspections/:inspectionId',         canEditInsp, i.deleteInspection);
router.put   ('/:id/inspections/:inspectionId/results', canEditInsp, i.saveResults);
router.post  ('/:id/inspections/:inspectionId/complete',canEditInsp, i.completeInspection);
router.post  ('/:id/inspections/:inspectionId/reopen',  canEditInsp, i.reopenInspection);

router.post  ('/:id/signatures',              canSign, i.addSignature);
/* Removing one is gated again inside the handler, to super admin only: anyone
   who can delete a signature can delete the proof that they signed. */
router.delete('/:id/signatures/:signatureId', canSign, i.deleteSignature);

/* The body diagram stays on the CARD's permission, not the sheet's, because
   that is where it lives: job_card_damage_marks is keyed on (job_card_id,
   stage) and has no inspection_id column at all. Gating it on EDIT_INSPECTION
   would be gating a card-level record on a sheet-level permission, which reads
   fine in a route table and is wrong. */
router.put   ('/:id/damage', canEdit, i.replaceDamage);

/* ── Compliance gates and the gate pass ──────────────────────────────────────
   '/gate-pass' before '/gates/:gate' is not strictly required — they differ in
   the first segment — but the group is kept in one block so the next person
   adding a route here sees the whole surface at once rather than scattering it.

   Overriding a gate is gated again INSIDE the handler, to super admin only.
   Putting that in the route would make it look like an ordinary permission;
   it is the safety valve on every other check in this module. */
router.get   ('/:id/gates',                 canView, g.getGates);
router.post  ('/:id/gates/:gate',           canEdit, g.confirmGate);
router.post  ('/:id/gates/:gate/override',  canEdit, g.overrideGate);
router.delete('/:id/gates/:gate',           canEdit, g.clearGate);

router.post  ('/:id/gate-pass',   canEdit, g.issueGatePass);
router.delete('/:id/gate-pass',   canEdit, g.revokeGatePass);

/* ── Parts issued from the store, and the time log ───────────────────────────
   canEdit, not a new permission, for the same reason the rest of this file
   gives: issuing a part IS working on the appointment. The storekeeper and the
   service advisor are the same login at most of these hubs.

   '/parts/:rowId/return' sits below '/parts/:rowId' only because Express
   matches on segment count first — they cannot collide. Kept adjacent so the
   whole parts surface reads in one block. */
router.get   ('/:id/parts',                 canView, p.listParts);
router.post  ('/:id/parts',                 canEdit, p.addPart);
router.patch ('/:id/parts/:rowId',          canEdit, p.updatePart);
router.post  ('/:id/parts/:rowId/return',   canEdit, p.returnPart);
router.delete('/:id/parts/:rowId',          canEdit, p.deletePart);

router.get   ('/:id/labour',                canView, p.listLabour);
router.post  ('/:id/labour',                canEdit, p.addLabour);
router.patch ('/:id/labour/:rowId',         canEdit, p.updateLabour);
router.delete('/:id/labour/:rowId',         canEdit, p.deleteLabour);

module.exports = router;
