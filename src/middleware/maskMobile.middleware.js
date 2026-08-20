'use strict';
/**
 * Masks customer contact numbers in every JSON response on a router, for hub
 * sessions only.
 *
 * WHY A WRAPPER RATHER THAN EDITING EACH HANDLER
 * ──────────────────────────────────────────────
 * The four routers this is mounted on have 40+ res.json() sites between them —
 * lists, single records, every mutation that echoes the updated row back,
 * timelines, payment arrays. Masking them one at a time means one missed call
 * site leaks the whole list, and the miss is invisible until someone reads a
 * production response. Wrapping res.json instead makes the safe behaviour the
 * DEFAULT: a handler added next year is covered without its author knowing this
 * file exists.
 *
 * It deliberately does NOT wrap res.send, so the CSV exports are untouched
 * here — those build a string and are masked at source in their own handlers,
 * where the column can be seen next to its header.
 *
 * Mount AFTER requireAuth: it reads req.user to decide whether to do anything.
 */
const { isHubUser } = require('../utils/hubScope');
const { scrubMobiles } = require('../utils/maskMobile');

function maskCustomerContact(req, res, next) {
  // Staff and super admins keep the real numbers, so the wrapper is not even
  // installed for them — no cost on the path that runs most often.
  if (!isHubUser(req)) return next();

  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(scrubMobiles(req, body));
  next();
}

module.exports = { maskCustomerContact };
