'use strict';

/**
 * chat.routes.js — internal staff messaging.
 *
 * ══ requirePermission, NEVER requirePermissionOrHub ═════════════════════════
 *
 * This is the single most important line in this file and it is a line that
 * isn't here. From auth.middleware.js:
 *
 *   // Hub user: if they have zero permissions, allow everything (open / default access)
 *   if (req.user.permissions.size === 0) return next();
 *
 * requirePermissionOrHub waves through ANY hub account that has no permissions
 * assigned. That is deliberate and correct for the hub portal, where the
 * default is open access — but a chat route using it would hand internal staff
 * messaging to every zero-permission hub login in the system, without anybody
 * granting anything. It would not look like a bug. It would look like the
 * feature working.
 *
 * Plain requirePermission on every route. The date-compliance route is the
 * existing precedent for making exactly this choice.
 *
 * ══ AND NEVER cacheGet ═════════════════════════════════════════════════════
 *
 * utils/responseCache.js keys on `topic:originalUrl` and its own header says it
 * is for endpoints with "no req.user in their queries". Every route here is
 * per-user by definition: two people GET /api/chat/conversations and must get
 * different answers. Caching one of these would serve one colleague's
 * conversation list to another.
 *
 * ══ WHERE THE REAL GATE IS ═════════════════════════════════════════════════
 *
 * USE_CHAT only decides who may use the feature at all. Whether this person may
 * see THIS conversation is decided per request in the controller, which joins
 * chat_participants on req.user.id — including for a super admin and for a
 * MANAGE_CHAT holder. Route permissions are the outer door; membership is the
 * lock on each room.
 */

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth.middleware');
const c = require('../controllers/chat.controller');
const dir = require('../controllers/chat.directory.controller');
const refs = require('../controllers/chat.refs.controller');
const rec = require('../controllers/chat.records.controller');

const router = express.Router();

// Everything below needs a login and the chat permission. No exceptions, and
// no hub fallthrough — see the block comment above.
router.use(requireAuth, requirePermission('USE_CHAT'));

/* Static paths before parameterised ones. Express matches in declaration
   order, so /conversations/:id declared first would swallow nothing here today
   — but it would the moment somebody adds /conversations/recent, and that is a
   bug that shows up as a 404 on a route that plainly exists. */
router.get('/unread-count', c.unreadCount);
router.get('/directory',    dir.listDirectory);

/* Resolving a shared record. USE_CHAT only, and deliberately nothing more: the
   permission that decides whether you may SEE a record is the record's own, and
   it is applied per ref inside the resolver (services/chatRefs.service.js).
   Putting a record permission on this route would be the wrong shape entirely —
   one route cannot carry six different records' rules, and whichever one it
   carried would be wrong for the other five.
   It is a POST because it takes a list. Nothing is written. */
/* The composer's record picker. Its permission check is PER TYPE and lives in
   the controller, reusing the resolver's own code lists — one route cannot carry
   six records' rules. */
router.get('/records/kinds',  rec.listKinds);
router.get('/records/search', rec.search);

router.post('/refs/resolve', refs.resolve);
router.get ('/refs/types',   refs.listTypes);

router.get   ('/conversations',     c.listConversations);
router.post  ('/conversations',     c.createConversation);
router.get   ('/conversations/:id', c.getConversation);

/* Renaming. PATCH on the conversation itself rather than /title, because the
   title IS the conversation to everybody who uses it — /title would read as a
   sub-resource with a lifetime of its own. */
router.patch ('/conversations/:id', c.renameConversation);

/* ── The only route in this file that destroys anything ──────────────────────
   It cascades through chat_messages, chat_reads and chat_message_reactions, so
   it removes a group and everything anybody ever said in it, irreversibly. The
   three gates in front of it — MANAGE_CHAT, the typed name, groups only — are on
   destroyConversation. Archiving (below) is the normal way a group ends. */
router.delete('/conversations/:id', c.destroyConversation);

router.get ('/conversations/:id/messages', c.listMessages);
router.post('/conversations/:id/messages', c.sendMessage);

router.post ('/conversations/:id/read',    c.markRead);
router.post ('/conversations/:id/dismiss', c.dismiss);
router.patch('/conversations/:id/mute',    c.setMuted);

/* Archived is a property of the conversation for everybody; pinned is one
   person's ordering of their own list. Two routes because they are two different
   kinds of fact, even though both are a PATCH with one boolean. */
router.patch('/conversations/:id/archive', c.setArchived);
router.patch('/conversations/:id/pin',     c.setPinned);

/* Withdraw everything I said in here. Its own path rather than a flag on the
   conversation DELETE above, because they are different powers: this one needs
   no permission and touches only the caller's own messages, that one needs
   MANAGE_CHAT and destroys everybody's. A shared route with a query parameter
   deciding which is how the wrong one gets called. */
router.delete('/conversations/:id/my-messages',          c.deleteMyMessages);

router.get   ('/conversations/:id/participants',          c.listParticipants);
router.post  ('/conversations/:id/participants',          c.addParticipants);
router.delete('/conversations/:id/participants/:userId',  c.removeParticipant);

// Messages are addressed by their own id, not nested under the conversation:
// the controller resolves the conversation from the message and checks
// membership there, so a caller cannot pair a message id with a conversation
// they happen to be in.
router.patch ('/messages/:id', c.editMessage);
router.delete('/messages/:id', c.deleteMessage);

/* Reactions. A POST that TOGGLES rather than an add/remove pair — see the
   comment on toggleReaction for why the client must not have to know the current
   state to pick between two verbs. */
router.post('/messages/:id/reactions', c.toggleReaction);
router.get ('/messages/:id/reactions', c.listReactors);

/* Forwarding. A POST on the SOURCE message naming the destination, and both ends
   are membership-checked separately — see forwardMessage. The row that lands is a
   new message from the forwarder, never a copy wearing the original sender's
   name in a room they are not in. */
router.post('/messages/:id/forward', c.forwardMessage);

/* Who has not read up to a moment — the hover behind a group's ticks. */
router.get('/conversations/:id/pending-readers', c.pendingReaders);

module.exports = router;
