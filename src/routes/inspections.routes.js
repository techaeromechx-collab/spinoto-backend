'use strict';

/**
 * The inspection QUEUE — every sheet across every job card.
 *
 * ══ WHY A ROUTE FILE OF ITS OWN ════════════════════════════════════════════
 *
 * Everything else about an inspection is nested under its card, because
 * nothing about it means anything without one. The queue is the exception: it
 * is deliberately card-less, and the question it answers — "what is half
 * finished on the floor right now" — cannot be asked of a single card.
 *
 * It could have been mounted as `/api/job-cards/inspections`, above `/:id` the
 * way `/settings` is. That would work and it would read as a lie: it is not a
 * property of a job card, and the next person adding a route would have to
 * learn the ordering rule to avoid breaking it.
 *
 * ══ PERMISSIONS ════════════════════════════════════════════════════════════
 *
 * Read-only, and the audience is a SHEET's — VIEW_INSPECTION, no longer the
 * appointment's codes. There is nothing to write here: starting, answering and
 * completing an inspection all happen on the card, where the hub-ownership
 * check lives.
 *
 * EDIT_INSPECTION is accepted as well. Somebody who may fill sheets in but was
 * never given the read code is a configuration nobody means to create, and
 * refusing them this queue would hide the very list of work they are there to
 * do. Migration 203 grants the pair together anyway.
 */

const express = require('express');
const { requireAuth, requirePermissionOrHub } = require('../middleware/auth.middleware');
const i = require('../controllers/job_card_inspections.controller');

const router = express.Router();

const canView = [requireAuth, requirePermissionOrHub(
  'VIEW_INSPECTION', 'EDIT_INSPECTION')];

router.get('/', canView, i.listAllInspections);

module.exports = router;
