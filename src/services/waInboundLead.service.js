'use strict';

/**
 * Who does an incoming WhatsApp message belong to?
 *
 * One question, one answer, one place. The webhook calls this; the reply
 * endpoint calls this; the next stage (routing a reply to the advisor who owns
 * the lead, firing a template on a status change) calls this. It is deliberately
 * NOT part of the webhook controller — a rule this important should not live
 * inside an HTTP handler that only one caller can reach.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 *   1. An OPEN lead exists for this number → attach to it. Never a second one.
 *   2. Otherwise                           → create a lead, Source WhatsApp.
 *
 * Step 2 then asks one more thing (migration 161): is this actually a stranger?
 * A number with a past appointment or a customer profile is a REPEAT CUSTOMER;
 * a number whose old lead was closed — Lost, Junk, Not Interested — is a
 * RE-ENQUIRY. Each starts on whichever status has been ticked for it in Master
 * Data, so the pipeline stops showing all three as "New Lead". Nothing is
 * ticked by default, and until something is, this is exactly the old behaviour.
 *
 * Step 2 used to have an exception: a number already in customer_profiles got
 * no lead at all, because a repeat customer asking a question is a conversation
 * rather than a sales enquiry. That exception is gone — see the comment at the
 * branch itself. The profile is still read, for the customer's real name.
 *
 * ── Matching is on the LAST TEN DIGITS, never on the stored string ───────────
 *
 * leads.mobile is free text with no normalisation (the create route accepts any
 * 20 characters). The same person is '+91 97241 90308' in the CRM and
 * '+919724190308' from Interakt. A `WHERE mobile = $1` misses, and the miss
 * silently creates the duplicate lead this whole module exists to prevent.
 * Migration 155 indexes the same expression used here.
 */

const { toE164, toNational } = require('../utils/phone');
const { generatePublicToken } = require('../utils/publicToken');

/** The exact expression migration 155 indexed. Must not drift from it. */
const NAT = (col) => `RIGHT(regexp_replace(COALESCE(${col}, ''), '\\D', '', 'g'), 10)`;

/**
 * Is this lead finished?
 *
 * Two ways, and both are needed:
 *
 *   1. Its status is flagged is_closed (migration 156) — Lost, Junk, Not
 *      Interested, and whatever else the owner ticks in Master Data.
 *   2. An appointment was created from it. The job happened; a message months
 *      later is a new enquiry, not a continuation. This also matches what
 *      /leads/check-mobile already assumes when deciding what counts as a live
 *      duplicate.
 *
 * NOT is_pipeline. That flag means "count this lead's value on the dashboard"
 * and is edited for reporting reasons; wiring message routing to it would move
 * customers' conversations the day someone adjusted a report.
 *
 * A status with no row in lead_statuses — leads.status is free text, so typos
 * and retired names exist — is treated as OPEN. Never retire a lead over a
 * spelling mistake; the cost of guessing wrong that way is one extra message on
 * a live lead, versus an enquiry filed where nobody looks.
 */
const CLOSED_LEAD = `(
  EXISTS (
    SELECT 1 FROM lead_statuses ls
     WHERE LOWER(TRIM(ls.name)) = LOWER(TRIM(l.status))
       AND ls.is_closed
  )
  OR EXISTS (SELECT 1 FROM appointments ap WHERE ap.lead_id = l.id)
)`;

/**
 * Has this number been here before, and in what way? (migration 161)
 *
 * Only ever asked once every open route has already missed — so by the time
 * this runs, we know a new lead is being created and the only question left is
 * what to call it.
 *
 * Two answers, and they are not the same customer:
 *
 *   repeat     they have already had a job done. A past appointment on this
 *              number, or a row in customer_profiles. Revenue that worked.
 *   reenquiry  they had a lead and it was CLOSED — Lost, Junk, Not Interested.
 *              A sale that did not work, getting a second run.
 *
 * ── Why the appointment is matched on the NUMBER, not through the lead ──────
 *
 * appointments.lead_id is nullable and 021's own comment says why: a walk-in
 * has no lead. Asking "does a lead of theirs have an appointment" would miss
 * every walk-in — and a walk-in who paid you and then messaged on WhatsApp is
 * the most obviously repeat customer there is.
 *
 * ── Both true at once ───────────────────────────────────────────────────────
 *
 * Common, and not a conflict: somebody serviced their bike last year and was
 * marked Lost on a quote for something else in March. Repeat wins. What they
 * are to you is a customer; the lost quote is one episode inside that.
 */
async function classifyReturn(client, national) {
  const r = await client.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM appointments ap
          WHERE ${NAT('ap.mobile')} = $1 OR ${NAT('ap.whatsapp')} = $1
       ) AS had_appointment,
       EXISTS (
         SELECT 1 FROM leads l
           JOIN lead_statuses ls
             ON LOWER(TRIM(ls.name)) = LOWER(TRIM(l.status))
          WHERE (${NAT('l.mobile')} = $1 OR ${NAT('l.whatsapp')} = $1)
            AND ls.is_closed
       ) AS had_closed_lead`,
    [national]
  );
  return {
    hadAppointment: r.rows[0].had_appointment,
    hadClosedLead:  r.rows[0].had_closed_lead,
  };
}

/**
 * The status a returning customer's new lead should start on.
 *
 * Returns the status NAME, because leads.status stores the name (migration 013
 * turned the enum into VARCHAR(100)). The name is read from the row at the last
 * possible moment rather than hardcoded anywhere, which is the entire point of
 * the flags: rename the status and this keeps working.
 *
 * ── The fallback chain, and why it leans one way ────────────────────────────
 *
 * A repeat customer with no repeat status configured falls back to the
 * re-enquiry status. Slightly wrong, and much better than blank: somebody who
 * has ticked only one of the two boxes has told us they want returning
 * customers marked, and putting them on "New Lead" would ignore that. The
 * reverse does NOT apply — a re-enquiry never lands on the repeat-customer
 * status, because calling somebody who has never paid you a customer is a
 * different kind of wrong, and one that ends up in front of them.
 *
 * Nothing ticked at all → null → status NULL → "New Lead", exactly as before.
 */
async function returningStatusName(client, { repeat, reenquiry }) {
  if (!repeat && !reenquiry) return null;

  const r = await client.query(
    `SELECT name, is_repeat_customer, is_reenquiry
       FROM lead_statuses
      WHERE (is_repeat_customer OR is_reenquiry) AND is_active`);
  if (!r.rowCount) return null;

  const repeatRow = r.rows.find(x => x.is_repeat_customer) || null;
  const reenqRow  = r.rows.find(x => x.is_reenquiry) || null;

  if (repeat) return (repeatRow || reenqRow)?.name || null;
  return reenqRow?.name || null;
}

/**
 * One line on the new lead saying which record it is a continuation of.
 *
 * Without it the same person is simply in the CRM twice with nothing
 * explaining why, and the first thing anybody does is open both and try to
 * work out which is real. Cheap to write, and it is the question every advisor
 * asks in the first ten seconds.
 */
async function priorTrail(client, national, { repeat }) {
  if (repeat) {
    const ap = await client.query(
      `SELECT appointment_code, scheduled_date FROM appointments ap
        WHERE ${NAT('ap.mobile')} = $1 OR ${NAT('ap.whatsapp')} = $1
        ORDER BY scheduled_date DESC NULLS LAST, id DESC
        LIMIT 1`, [national]);
    if (!ap.rowCount) return 'Repeat customer — already on file.';
    const when = ap.rows[0].scheduled_date
      ? new Date(ap.rows[0].scheduled_date).toISOString().slice(0, 10)
      : null;
    return `Repeat customer — last visit ${when || 'date unknown'}` +
           `${ap.rows[0].appointment_code ? ` (${ap.rows[0].appointment_code})` : ''}.`;
  }

  const prev = await client.query(
    `SELECT l.id, l.status FROM leads l
       JOIN lead_statuses ls ON LOWER(TRIM(ls.name)) = LOWER(TRIM(l.status))
      WHERE (${NAT('l.mobile')} = $1 OR ${NAT('l.whatsapp')} = $1) AND ls.is_closed
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT 1`, [national]);
  if (!prev.rowCount) return null;
  return `Re-enquiry — previous lead #${prev.rows[0].id} was ${prev.rows[0].status}.`;
}

/**
 * A usable customer name out of whatever the message actually contained.
 *
 * Interakt's `traits.name` is the WhatsApp profile name and is frequently
 * absent, or a nickname, or an emoji. Meanwhile the messages that matter most —
 * the ones from a Meta lead form or a website form forwarded to WhatsApp —
 * carry the real name INSIDE the body:
 *
 *     Full name: Rajeev Mundra
 *     Phone number: +919724190308
 *     Vehicle Brand & Model: Volkswagen Ameo
 *
 * A lead called "+919724190308" when the customer typed their name three lines
 * down is a lead someone has to open and fix by hand.
 *
 * Deliberately conservative: a labelled line only, capped, and rejected if it
 * looks like a phone number or contains digits in the middle of a word. A wrong
 * name on a lead is worse than no name, because nobody re-checks it.
 */
const NAME_LABELS = /^\s*(?:full\s*name|name|customer\s*name|your\s*name)\s*[:\-–]\s*(.+)$/i;

function nameFromBody(body) {
  if (!body || typeof body !== 'string') return null;

  for (const line of body.split(/\r?\n/).slice(0, 40)) {
    const m = NAME_LABELS.exec(line);
    if (!m) continue;

    const candidate = m[1].trim().replace(/\s+/g, ' ');
    if (candidate.length < 2 || candidate.length > 80) continue;
    // A "Name: 9724190308" line is a mislabelled phone number, not a name.
    if (/\d/.test(candidate)) continue;
    // Guard against a form label with an empty value picking up the next field.
    if (/[:]/.test(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * Interakt gives no body for a photo, document or voice note — `message` is
 * null and message_content_type says what it was. Storing null loses the fact
 * that the customer sent anything at all, so the conversation shows a gap where
 * a picture of a damaged bumper should be.
 */
const MEDIA_LABEL = Object.freeze({
  Image: '📷 Photo',
  Video: '🎥 Video',
  Audio: '🎤 Voice message',
  Document: '📄 Document',
  Sticker: '🙂 Sticker',
  Location: '📍 Location',
  Contacts: '👤 Contact',
});

/**
 * When the customer TAPS instead of types.
 *
 * A flow with buttons or a list — "Bike/Scooter · Car · Support/Help" — does not
 * produce text. WhatsApp sends an interactive reply, and Interakt hands it to us
 * as a JSON STRING sitting in the same `message` field a typed message uses:
 *
 *   {"type":"list_reply","list_reply":{"id":"without_faq__c078b…","title":"AC Service/Repair"}}
 *   {"type":"button_reply","button_reply":{"id":"…","title":"Car"}}
 *   {"latitude":23.0117971,"longitude":72.639749}
 *
 * Stored as-is, the conversation reads as a wall of machine output and the one
 * word that matters — what they actually chose — is buried in the middle of it.
 *
 * Nothing is lost by unwrapping: the untouched payload is already kept in
 * wa_events, so the id is still recoverable. This is only what a person reads.
 *
 * Anything unrecognised falls through to the original string rather than being
 * guessed at. A message rendered wrongly is worse than one rendered rawly.
 */
function unwrapInteractive(text) {
  if (typeof text !== 'string') return text;

  const t = text.trim();
  // Cheap gate: a typed message almost never starts with a brace, and this
  // avoids a JSON.parse attempt on every message that arrives.
  if (!t.startsWith('{')) return text;

  let o;
  try { o = JSON.parse(t); } catch { return text; }
  if (!o || typeof o !== 'object') return text;

  // A tapped button or list row. Interakt has sent both flat and nested under
  // `interactive`, so both are read.
  const pick = o.list_reply || o.button_reply
            || o.interactive?.list_reply || o.interactive?.button_reply;
  if (pick && (pick.title || pick.id)) return String(pick.title || pick.id);

  // A shared pin. Coordinates kept — they are the only useful part, and an
  // advisor pasting them into Maps is the actual workflow.
  if (o.latitude != null && o.longitude != null) {
    const place = [o.name, o.address].filter(Boolean).join(', ');
    return `📍 ${place ? `${place} — ` : ''}${o.latitude}, ${o.longitude}`;
  }

  if (typeof o.text === 'string' && o.text.trim()) return o.text;

  return text;
}

function bodyFor(msg) {
  if (typeof msg?.message === 'string' && msg.message.trim()) {
    return unwrapInteractive(msg.message);
  }
  const type = msg?.message_content_type;
  if (type && type !== 'Text') return MEDIA_LABEL[type] || `[${type}]`;
  return null;
}

/**
 * The attachment on an inbound message, as the columns from migration 166.
 *
 * ── WHAT USED TO HAPPEN TO IT ───────────────────────────────────────────────
 *
 * Interakt sends `media_url` — their docs call it "public link to media file" —
 * and this module read `message_content_type`, turned it into the string
 * '📷 Photo' and dropped the URL on the floor. The customer's photo survived
 * only inside the raw wa_events payload, where nothing looks for it. An advisor
 * asking "send me a picture of the damage" got back the words "📷 Photo" and
 * had to open WhatsApp on their own phone to see it.
 *
 * ── media_file_id IS DELIBERATELY NOT SET ───────────────────────────────────
 *
 * That column is OUR ImageKit handle, for deleting files we uploaded. Inbound
 * media lives on the provider's storage and is not ours to delete; writing an
 * id there would be a claim on a file we do not own.
 *
 * ── THESE URLS EXPIRE ───────────────────────────────────────────────────────
 *
 * The provider's link is not permanent. A photo from months ago may 404, so
 * the thread must tolerate a broken image rather than assume one — which is
 * why body_rendered keeps its '📷 Photo' text either way: it is the fallback
 * that still says what arrived once the picture is gone.
 *
 * @returns {{message_type: string, media_url: string|null, caption: string|null}}
 */
const CONTENT_TYPE_TO_KIND = Object.freeze({
  Image: 'image', Video: 'video', Audio: 'audio', Document: 'document',
  Sticker: 'sticker', Location: 'location', Contacts: 'contacts',
});

function mediaFor(msg) {
  const kind = CONTENT_TYPE_TO_KIND[msg?.message_content_type];
  if (!kind) return { message_type: 'text', media_url: null, caption: null };

  const url = typeof msg?.media_url === 'string' ? msg.media_url.trim() : '';
  const usable = /^https?:\/\/\S+$/i.test(url) ? url : null;

  // Location and Contacts carry no file, so they are the one media kind that
  // may be stored without a URL — the CHECK in migration 166 allows exactly
  // those two. Every other kind without a fetchable URL is recorded as text,
  // because a media row with nothing to show is a permanently empty bubble.
  if (!usable && kind !== 'location' && kind !== 'contacts') {
    return { message_type: 'text', media_url: null, caption: null };
  }

  // WhatsApp lets a photo carry a caption, and Interakt puts it in `message` —
  // the same field a plain text message uses. bodyFor only reads it when it is
  // non-empty, so a captioned photo already produces sensible body text; this
  // records it as a caption as well, so the thread can render it under the
  // picture rather than beside a paperclip emoji.
  const cap = typeof msg?.message === 'string' ? msg.message.trim() : '';

  return { message_type: kind, media_url: usable, caption: cap || null };
}

/**
 * Resolve — and if necessary create — the record this number belongs to.
 *
 * MUST be called inside a transaction on `client`, after the wa_conversations
 * row for this number has been upserted. That upsert is the lock: mobile is
 * UNIQUE, so a second concurrent webhook for the same new number blocks there
 * and then sees the lead_id the first one wrote, instead of creating its own.
 *
 * @returns {Promise<{entityType: 'lead'|null, entityId: number|null,
 *                    leadId: number|null, createdLead: boolean,
 *                    matchedCustomer: boolean}>}
 */
async function resolveOrCreateLead(client, { e164, name, firstMessage }) {
  const national = toNational(e164);
  if (!national) return { entityType: null, entityId: null, leadId: null, createdLead: false, matchedCustomer: false };

  // The conversation row already knows, if this number has been seen before.
  // Cheapest path, and the one that guarantees a stable answer for a
  // back-and-forth rather than re-deciding on every message.
  // The remembered lead — but only if it is still OPEN.
  //
  // This check is why the whole feature works. Without it the pointer keeps
  // returning the lead it first resolved to, so a lead marked Junk yesterday
  // still wins today and everything below never runs. The rest of this function
  // can be perfectly correct and messages still land on the dead lead.
  const known = await client.query(
    `SELECT l.id
       FROM wa_conversations c
       JOIN leads l ON l.id = c.lead_id
      WHERE c.mobile = $1
        AND NOT ${CLOSED_LEAD}`,
    [e164]
  );
  const knownLeadId = known.rows[0]?.id || null;
  if (knownLeadId) {
    return { entityType: 'lead', entityId: knownLeadId, leadId: knownLeadId, createdLead: false, matchedCustomer: false };
  }

  // ── 1. An existing lead, matched on the normalised number ────────────────
  //
  // Most recent OPEN one wins. A customer who enquired twice has two leads
  // (manual entry permits it); their new message belongs on the one still being
  // worked — and if none is, on a new one.
  //
  // Closed leads are skipped entirely rather than being used as a fallback. A
  // message on a Lost lead is stored, visible and unread forever, which is
  // worse than not receiving it: the system looks like it worked.
  const lead = await client.query(
    `SELECT l.id FROM leads l
      WHERE (${NAT('l.mobile')} = $1 OR ${NAT('l.whatsapp')} = $1)
        AND NOT ${CLOSED_LEAD}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT 1`,
    [national]
  );
  if (lead.rowCount > 0) {
    const leadId = lead.rows[0].id;
    await client.query(`UPDATE wa_conversations SET lead_id = $2 WHERE mobile = $1`, [e164, leadId]);
    return { entityType: 'lead', entityId: leadId, leadId, createdLead: false, matchedCustomer: false };
  }

  // ── 2. An existing customer ──────────────────────────────────────────────
  //
  // Looked up, but NO LONGER a stopping point.
  //
  // This branch used to return here: a number already in customer_profiles got
  // its message stored and no lead, on the reasoning that a repeat customer
  // asking a question is a conversation rather than a sales lead. That reasoning
  // still holds, and it was still the wrong call, for a reason the rule itself
  // could not see:
  //
  //   the message was filed against NOTHING. entity_type and entity_id both
  //   NULL. "It shows on their Customer page" was true only in the sense that
  //   the row existed — a customer who messaged went into the database and
  //   appeared on no screen anybody opens.
  //
  // A missed enquiry from someone who has already paid you once is the most
  // expensive kind. So the lookup stays — the NAME is worth having — and the
  // lead gets created either way. The Customer page now carries the same thread
  // as the Lead page, so the conversation is readable from both sides.
  //
  // customer_profiles.mobile is the 10-digit national form, so it compares
  // directly against `national`.
  // No ORDER BY: customer_profiles.mobile IS the primary key (migration 026 —
  // there is no surrogate id, and `ORDER BY id` here would simply throw), so
  // this matches at most one row.
  const cust = await client.query(
    `SELECT display_name FROM customer_profiles
      WHERE mobile = $1 AND is_deleted = FALSE
      LIMIT 1`,
    [national]
  );
  const matchedCustomer = cust.rowCount > 0;

  // Their real name, already known, beats the WhatsApp profile name and beats
  // "(no name)" — which is what these leads would otherwise be called, since a
  // returning customer rarely re-types their name. `name` (traits.name or a
  // labelled line in the body) still wins when it is present: it came from this
  // message, and customer_profiles may be years stale.
  const custName = matchedCustomer
    ? (cust.rows[0].display_name || '').trim() || null
    : null;

  // ── 3. Have they been here before? (migration 161) ───────────────────────
  //
  // Asked only on this branch, and that placement is the whole rule. Everything
  // above returns when an OPEN lead was found, so reaching here means a NEW
  // lead is being created — and the only remaining question is whether this is
  // a stranger, somebody who said no once, or somebody who has already paid.
  //
  // customer_profiles counts as a past job in its own right. A profile exists
  // because they were served; whether the appointment row survived a tidy-up is
  // not something the customer should be able to feel.
  const seen = await classifyReturn(client, national);
  const repeat    = seen.hadAppointment || matchedCustomer;
  const reenquiry = seen.hadClosedLead;

  const statusName = await returningStatusName(client, { repeat, reenquiry });
  const trail = (repeat || reenquiry)
    ? await priorTrail(client, national, { repeat })
    : null;

  // ── 4. Create the lead. ──────────────────────────────────────────────────
  //
  // status is NULL for a stranger — leads.controller.js's own comment is
  // explicit that "status = NULL means New Lead"; there is no 'New' row in
  // lead_statuses, so writing the string 'New' would produce a lead with a
  // status no filter, colour or board column recognises. A returning customer
  // gets the NAME read out of the flagged row a moment ago, never a literal
  // written into this file.
  //
  // created_by NULL: no user did this. That is what NULL is for, and the audit
  // log below records the real actor.
  //
  // mobile is stored in E.164 — the form the message arrived in and the form
  // every future match normalises anyway.
  //
  // The trail line goes FIRST in the notes. It is the sentence that answers
  // "why is this person in here twice", and burying it under a 2000-character
  // form-fill message would be the same as not writing it.
  const notes = [
    trail,
    firstMessage ? `First WhatsApp message:\n${String(firstMessage).slice(0, 2000)}` : null,
  ].filter(Boolean).join('\n\n') || null;

  const created = await client.query(
    `INSERT INTO leads (name, mobile, whatsapp, lead_source, status, notes, created_by, public_token)
     VALUES ($1, $2, $2, 'WhatsApp', $5, $3, NULL, $4)
     RETURNING id`,
    [
      name || custName || null,
      e164,
      notes,
      generatePublicToken(),
      statusName,
    ]
  );
  const leadId = created.rows[0].id;

  await client.query(`UPDATE wa_conversations SET lead_id = $2 WHERE mobile = $1`, [e164, leadId]);

  return {
    entityType: 'lead', entityId: leadId, leadId, createdLead: true, matchedCustomer,
    // Reported back so the webhook can say WHICH kind of lead it just made in
    // one log line. "created lead #204" and "created lead #204 (repeat
    // customer)" are the difference between a log you scan and a log you have
    // to cross-reference.
    returning: repeat ? 'repeat' : reenquiry ? 'reenquiry' : null,
    status: statusName,
  };
}

module.exports = {
  resolveOrCreateLead,
  nameFromBody,
  bodyFor,
  mediaFor,
  // Exported for the suite, which asserts the classification directly rather
  // than inferring it from whichever status happened to be ticked.
  classifyReturn,
  returningStatusName,
  // Exported so the backfill script rewrites old rows with THIS function rather
  // than a second copy of the rule written in SQL.
  unwrapInteractive,
  NAT,
};
