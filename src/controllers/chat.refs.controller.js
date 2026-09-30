'use strict';

/**
 * chat.refs.controller.js — POST /api/chat/refs/resolve
 *
 * Takes the pointers on the thread page the reader is looking at and answers,
 * for each one: may you see this, does it still exist, and what does it say.
 *
 * ══ THE HOLE THIS CLOSES, WHICH THE FIRST DESIGN HAD ═══════════════════════
 *
 * The obvious version of this endpoint takes whatever (ref_type, ref_id) pairs
 * the client sends and resolves them. That is an ENUMERATION ORACLE, and a good
 * one: the three answers are distinguishable, so
 *
 *     POST { refs: [{estimate, 1}, {estimate, 2}, ... {estimate, 5000}] }
 *
 * tells the caller exactly which estimate ids exist, and `allowed:false` versus
 * `exists:false` separates "real but not yours" from "never existed". Somebody
 * holding no estimate permission at all learns nothing about contents but can
 * still count the business — how many invoices, how many leads, how fast they
 * are growing. Nothing in the resolver prevents that, because the resolver is
 * answering the question it was asked.
 *
 * So the pairs are FILTERED FIRST, against messages in conversations this user
 * is actually a participant of. What this endpoint can tell you is bounded by
 * what somebody chose to send you. An id nobody shared comes back `allowed:
 * false` and is indistinguishable from one you have no permission for — which
 * is the honest answer, because from here those really are the same thing.
 *
 * ══ WHY NOT JUST PASS A conversation_id ════════════════════════════════════
 *
 * Because the thread is paginated, and "resolve everything in conversation 12"
 * would resolve refs from pages the reader has not loaded and may never load.
 * Sending the pairs the page actually holds keeps the work proportional to what
 * is on screen. The membership filter is what makes that safe.
 */

const { z } = require('zod');
const { pool } = require('../config/db');
const { resolveRefs, REF_TYPES } = require('../services/chatRefs.service');

function handle(req, res, next, fn) {
  Promise.resolve().then(fn).catch((err) => {
    if (err?.name === 'ZodError') {
      return res.status(400).json({ error: err.errors.map((e) => e.message).join('; ') });
    }
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  });
}

/* 120 is two thread pages' worth with room to spare, and small enough that the
   membership filter below stays one indexed query. A client asking for more than
   that is not rendering a page. */
const bodySchema = z.object({
  /* Required, not optional-defaulting-to-[]. A request with no refs is a caller
     bug, and answering it with an empty list would hide that bug behind a 200
     forever. An explicitly empty array is different and is allowed — that is a
     page with no shared records on it, which is most pages. */
  refs: z.array(z.object({
    ref_type: z.string().max(40),
    ref_id: z.coerce.number().int().positive(),
  }), { required_error: 'refs is required — send an empty array for a page with no shared records' })
    .max(120, 'Too many refs in one request; a thread page holds at most a hundred or so'),
});

/**
 * Which of these pairs were genuinely shared with this user?
 *
 * One query, and the DISTINCT matters: the same job card shared in four messages
 * is one thing to resolve, not four.
 *
 * `left_at IS NULL` — somebody removed from a group stops being able to resolve
 * its pointers, the same way they stop being able to read its messages. Without
 * it, leaving a group would keep a permanent licence to ask about everything
 * that was ever shared in it.
 *
 * `deleted_at IS NULL` — a withdrawn message's pointer is not resolvable either.
 * (198 and chat.controller.js both null the ref on delete, so this is the belt to
 * that braces: a row that somehow kept its ref while deleted still will not
 * resolve.)
 */
async function sharedWithMe(userId, refs) {
  if (!refs.length) return new Set();
  const types = refs.map((r) => r.ref_type);
  const ids = refs.map((r) => Number(r.ref_id));

  const { rows } = await pool.query(
    `SELECT DISTINCT m.ref_type, m.ref_id
       FROM chat_messages m
       JOIN chat_participants p
         ON p.conversation_id = m.conversation_id
        AND p.user_id = $1
        AND p.left_at IS NULL
      WHERE m.deleted_at IS NULL
        AND m.ref_type IS NOT NULL
        AND (m.ref_type, m.ref_id) IN (
              SELECT t, i FROM UNNEST($2::text[], $3::int[]) AS u(t, i)
            )`,
    [userId, types, ids]
  );
  return new Set(rows.map((r) => `${r.ref_type}:${r.ref_id}`));
}

/**
 * POST /api/chat/refs/resolve
 * body: { refs: [{ ref_type, ref_id }, ...] }
 * → { items: [ ...one entry per requested ref, same order-independent shape ] }
 */
function resolve(req, res, next) {
  handle(req, res, next, async () => {
    const { refs } = bodySchema.parse(req.body || {});
    if (!refs.length) return res.json({ items: [] });

    const allowedPairs = await sharedWithMe(req.user.id, refs);

    /* Split rather than filter, so a pair that was never shared still gets an
       answer. A client that received no entry for something it asked about would
       have to decide for itself what that meant, and the safe interpretation is
       the one this endpoint should be stating out loud. */
    const shared = [];
    const notShared = [];
    for (const r of refs) {
      (allowedPairs.has(`${r.ref_type}:${Number(r.ref_id)}`) ? shared : notShared).push(r);
    }

    const items = await resolveRefs(req.user, req, shared);

    for (const r of notShared) {
      items.push({ ref_type: r.ref_type, ref_id: r.ref_id, allowed: false });
    }

    res.json({ items });
  });
}

/** GET /api/chat/refs/types — what the Share control may offer. */
function listTypes(_req, res) {
  res.json({ items: REF_TYPES });
}

module.exports = { resolve, listTypes };
