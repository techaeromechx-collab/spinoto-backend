'use strict';

/**
 * /api/whatsapp — template registry (Settings → WhatsApp).
 *
 * MANAGE_WHATSAPP_TEMPLATES on every route, including the reads. The list
 * response carries the variable mapping and the enable/auto state, which is
 * configuration rather than operational data — and the test-send route is a
 * write in everything but HTTP verb, since each call costs a real WhatsApp
 * conversation.
 *
 * SEND_WHATSAPP is a separate, wider permission that gates sending an approved
 * template to a CUSTOMER from a record. It deliberately does not grant access
 * here: being trusted to message a customer is not the same as being trusted to
 * change what every future message says.
 */

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const r = require('../controllers/whatsapp.routing.controller');
const inbox = require('../controllers/whatsapp.inbox.controller');
const { rateLimit } = require('../middleware/rateLimit.middleware');
const c = require('../controllers/whatsapp.controller');
const wh = require('../controllers/whatsapp.webhook.controller');
const m = require('../controllers/whatsapp.messages.controller');
const a = require('../controllers/whatsapp.automations.controller');

const router = express.Router();

/**
 * UNAUTHENTICATED — Interakt's delivery-status and inbound feed.
 *
 * Declared FIRST so no auth middleware added later to this router can
 * accidentally shadow it. Its own authentication is the HMAC signature over the
 * raw body; there is no session and there cannot be one.
 *
 * Deliberately NOT rate limited. Interakt treats any non-200 as a failure, and
 * five failures in ten minutes disables the webhook permanently until a human
 * re-enables it — so a 429 during a burst would cost far more than the burst.
 * The signature check is the gate; an unsigned flood is rejected at 401 without
 * touching the database.
 */
router.post('/webhook', wh.receiveWebhook);

const canManage = [requireAuth, requirePermission('MANAGE_WHATSAPP_TEMPLATES')];

/**
 * Every test send is a BILLED WhatsApp conversation, and the endpoint can
 * target any Indian mobile. Authentication is not a spend control: a wedged
 * retry loop in a browser tab, or a frustrated admin clicking through a
 * misconfiguration, both cost real money.
 *
 * The limiter keys on req.route.path, which here is the static
 * '/templates/:id/test' pattern rather than the substituted URL — so this is
 * one bucket per IP across all five templates, which is the intent. (That is
 * only true since the fix in rateLimit.middleware.js; it used to key on the
 * substituted path, giving a fresh allowance per template id.)
 *
 * 20 per 15 minutes: verifying five templates, twice each, with room to redo
 * one after a fix.
 */
const testLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

router.get('/templates',           canManage, c.listTemplates);
// Registers an already-approved Interakt template. Same permission as editing
// one: whoever may change what every future message says may also add a new
// one to say it. It arrives disabled either way.
router.post('/templates',          canManage, c.createTemplate);
router.patch('/templates/:id',     canManage, c.updateTemplate);
// Hard-deletes a template that never sent anything, soft-retires one that did.
// DELETE, not another PATCH flag, because the outcome differs by history and a
// caller should not have to know which they are getting.
router.delete('/templates/:id',    canManage, c.deleteTemplate);
router.post('/templates/:id/test', canManage, testLimit, c.testTemplate);

// ── Connection: API key / webhook secret / test number (migration 152) ─────
//
// Same permission as the registry. The GET returns {configured, last4} per
// key — the values themselves never leave the backend.
router.get('/provider-settings', canManage, c.getProviderSettings);
router.put('/provider-settings', canManage, c.saveProviderSettings);

// ── Automations: "when X happens, send Y" (migration 151) ───────────────────
//
// Same permission as the registry. An automation decides WHEN customers hear
// from the business; the mapping decides WHAT they hear — separating the two
// trusts would let someone re-point a message they may not edit.
router.get('/automations',        canManage, a.listAutomations);
router.post('/automations',       canManage, a.createAutomation);
router.patch('/automations/:id',  canManage, a.updateAutomation);
router.delete('/automations/:id', canManage, a.deleteAutomation);

// ── Per-record history and manual send ──────────────────────────────────────
//
// SEND_WHATSAPP, not MANAGE_WHATSAPP_TEMPLATES. An advisor sending an approved
// template to their own customer is an operational act; changing the mapping
// that every future message uses is not, and bundling them would make the
// second the price of the first.
//
// Reads accept VIEW_WHATSAPP_LOGS as well, so a supervisor can see what went
// out without being able to send anything.
const canSend = [requireAuth, requirePermission('SEND_WHATSAPP')];
const canRead = [requireAuth, requirePermission('SEND_WHATSAPP', 'VIEW_WHATSAPP_LOGS')];

// Same reasoning as the test endpoint: every send is a billed conversation.
// Looser, because this is the real workflow rather than a verification step.
const sendLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });

// The Settings screen's overview numbers and its global recent-message log.
// MANAGE_WHATSAPP_TEMPLATES is accepted alongside the read permissions
// because the person configuring automations needs to see whether they work,
// without also being granted the ability to send.
const canOverview = [requireAuth,
  requirePermission('MANAGE_WHATSAPP_TEMPLATES', 'SEND_WHATSAPP', 'VIEW_WHATSAPP_LOGS')];
router.get('/stats',               canOverview, m.getStats);
router.get('/messages/recent',     canOverview, m.listRecent);

// Clearing the skipped list is canManage, NOT canOverview. Reading why a
// message did not send and being able to erase that record are different
// rights — the advisor who benefits from the panel should not be able to empty
// it, deliberately or by mis-clicking.
//
// Declared before '/messages' so the literal path cannot be shadowed by a
// parameterised route added later.
router.delete('/messages/skips',     canManage, m.clearSkips);
router.delete('/messages/skips/:id', canManage, m.clearSkip);

// Clearing the SENT log destroys the audit record of real, billed messages and
// with it the unique row that stops a repeat send — see clearLog's header.
// canManage for the same reason as above, and because this one is genuinely
// destructive rather than merely tidy.
//
// '/messages/log' is a literal segment, kept distinct from '/messages/:id'
// shapes so no future route can capture it.
router.delete('/messages/log',       canManage, m.clearLog);
router.delete('/messages/log/:id',   canManage, m.clearLogEntry);

// The conversation with one number, and replying to it.
//
// canRead, not canOverview: a thread is one customer's words, which is a
// narrower thing to expose than aggregate counts. Replying needs canSend for
// the same reason every other send does — it costs money and reaches a person.
//
// Declared before '/messages' so neither literal path can be shadowed.
// ── The topbar WhatsApp badge ────────────────────────────────────────────────
//
// canRead, the same as the thread these rows link to: the dropdown shows one
// line of a customer's words, so it is exactly as sensitive as the panel it
// opens. Marking read is a per-user bookmark rather than a change to anybody's
// data, so it needs nothing beyond that.
router.get('/inbox/unread-count', canRead, inbox.unreadCount);
router.get('/inbox',              canRead, inbox.listInbox);
router.post('/inbox/read',        canRead, inbox.markRead);
router.post('/inbox/read-all',    canRead, inbox.markAllRead);
// Clearing is a per-user bookmark too, not a delete: the thread on the lead
// and every other user's view are untouched. Same permission as reading it.
router.post('/inbox/dismiss',     canRead, inbox.dismiss);
router.post('/inbox/dismiss-all', canRead, inbox.dismissAll);

router.get('/messages/thread',     canRead, m.listThread);
router.post('/messages/reply',     canSend, sendLimit, m.sendReply);

router.get('/messages',            canRead, m.listMessages);
router.get('/messages/preview',    canRead, m.preview);
router.post('/messages/send',      canSend, sendLimit, m.sendManual);
router.post('/messages/:id/retry', canSend, sendLimit, m.retryMessage);

// ── Routing rota ────────────────────────────────────────────────────────────
// Who receives an inbound WhatsApp lead. canManage on the READ as well as the
// write: this screen lists every user and what they handle, which is staffing
// information, not something an advisor needs in order to reply to a customer.
router.get('/routing',                canManage, r.listRota);
router.put('/routing',                canManage, r.saveRota);
router.put('/routing/all-owner',      canManage, r.setAllOwner);
router.put('/routing/unrouted-owner', canManage, r.setUnroutedOwner);
router.post('/routing/categories',    canManage, r.createCategory);
router.delete('/routing/categories/:id', canManage, r.deleteCategory);

module.exports = router;
