'use strict';

/**
 * Integrations controller — inbound sync from external systems.
 *
 * POST /api/integrations/booking-orders
 *   Called by an external booking backend's outbox worker when a PAID order
 *   is created (contract: booking/API_CONTRACT.md + BOOKING_WEBHOOK_CONTRACT.md).
 *
 * All the work now lives in services/bookingAppointment.service.js, which is
 * shared with POST /api/public/booking/verify-payment. That is on purpose:
 * an online booking must produce an identical appointment whichever door it
 * came through, and a fix to the matching logic must land in both at once.
 */

const { createBookingAppointment } = require('../services/bookingAppointment.service');

function bookingOrders(req, res, next) {
  Promise.resolve()
    .then(() => createBookingAppointment(req.body))
    .then((result) => {
      // Replay → 200 (nothing was created). First delivery → 201.
      res.status(result.replay ? 200 : 201).json({
        ok: true,
        ...(result.replay ? { replay: true } : {}),
        appointment_id: result.appointment_id,
        appointment_code: result.appointment_code,
        ...(result.replay ? {} : { matched: result.matched, unmatched: result.unmatched }),
      });
    })
    .catch((err) => {
      if (err.name === 'ZodError') {
        return res.status(400).json({
          error: err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; '),
        });
      }
      next(err);
    });
}

module.exports = { bookingOrders };
