'use strict';

/**
 * Which CRM user owns this WhatsApp conversation?
 *
 * Four rules, in this order:
 *
 *   0. ALL LEADS. One person has been switched on as taking everything. While
 *      that is on, nothing below is consulted.
 *
 *   1. CONTINUITY. If wa_conversations.assigned_user_id already names someone,
 *      they keep it. A customer who messaged in March and messages again in
 *      August gets the advisor who already knows them — even though the closed
 *      lead rule (migration 156) has created a brand new lead for the enquiry.
 *      Continuity beats fairness: the point of routing is that the customer
 *      talks to one person, not that the workload divides evenly to two places
 *      after the decimal.
 *
 *   2. CATEGORY, then ROUND-ROBIN. The customer's answer to the flow's first
 *      question — Bike/Scooter, Car, Support/Help — narrows it to the users who
 *      handle that and are on duty. Among those, the one who was given a lead
 *      longest ago.
 *
 *   3. THE FALLBACK OWNER (migration 160). Everything above needs a signal:
 *      a mode being on, a number we have seen before, or an answer to the flow.
 *      A customer who types "Interested" and taps nothing gives none of them,
 *      and used to land in the unassigned queue by default rather than by
 *      decision. If somebody has been named as the fallback owner on the
 *      settings screen, they get it — marked 'fallback', which means
 *      PROVISIONAL.
 *
 * And when none of the four produces anybody, NOBODY IS ASSIGNED. The lead sits
 * in the shared unassigned queue where it is visibly nobody's. That is still
 * deliberate: a lead handed to a random person because the rules ran out has a
 * name on it, and a lead with a name on it looks handled.
 *
 * ── The second visit ────────────────────────────────────────────────────────
 *
 * routeInbound is called twice for a typical conversation, and the second call
 * is not a no-op:
 *
 *   the customer's first message  → creates the lead, no answers yet → rule 3
 *   the customer taps "Car"       → an answer exists → the guess is revisited
 *
 * That revisit is confirmOrHandOff below. It is why rule 3 stamps 'fallback'
 * rather than 'auto': the word is what licenses the lead to be moved later.
 */

/**
 * Matching is TRIM + LOWER, never equality.
 *
 * Interakt's own payload sends the second button as "Car " — with a trailing
 * space — while the flow editor shows "Car". An exact comparison would have
 * failed on the very first Car lead and looked like the routing was broken
 * rather than the string.
 */
const NORM = (col) => `LOWER(TRIM(${col}))`;

/**
 * Is one person taking every WhatsApp lead right now?
 *
 * Checked before anything else, because that is what "everything" means: while
 * it is on, the categories and the rota are not consulted at all.
 *
 * Off duty or deactivated falls THROUGH to the normal rota rather than assigning
 * to them anyway. Somebody who switched themselves off has said they are not
 * available, and honouring "all leads" over "I am not here" would hand every
 * customer of the day to an empty chair — the exact failure the unassigned queue
 * exists to make visible.
 */
async function allLeadsOwner(client) {
  const r = await client.query(
    `SELECT a.user_id
       FROM wa_agents a
       JOIN users u ON u.id = a.user_id
      WHERE a.takes_all AND a.on_duty AND u.is_active AND u.hub_id IS NULL
      LIMIT 1`);
  return r.rows[0]?.user_id || null;
}

/**
 * Who mops up the leads the rules could not sort? (migration 160)
 *
 * Same shape as allLeadsOwner and deliberately a separate column, because the
 * two are on at different times and mean different things: takes_all is "the
 * rota is off today", takes_unrouted is "the rota is on, and I take what it
 * cannot place". The same person may hold both.
 *
 * Same off-duty rule too, and for the same reason: an unassigned lead is
 * visible, a lead sitting with somebody who went home is not.
 */
async function unroutedOwner(client) {
  const r = await client.query(
    `SELECT a.user_id
       FROM wa_agents a
       JOIN users u ON u.id = a.user_id
      WHERE a.takes_unrouted AND a.on_duty AND u.is_active AND u.hub_id IS NULL
      LIMIT 1`);
  return r.rows[0]?.user_id || null;
}

/**
 * Pick the next agent for a category, and stamp them.
 *
 * MUST be called inside a transaction on `client`. FOR UPDATE SKIP LOCKED is
 * doing real work here: workflow_response_update fires on every tap, so two
 * customers answering at the same instant would otherwise both read the same
 * "oldest" row and both be handed to the same person.
 *
 * @returns {Promise<number|null>} user id, or null when nobody is eligible
 */
const ELIGIBLE = `
  SELECT a.user_id
    FROM wa_agents a
    JOIN users u ON u.id = a.user_id
   WHERE a.on_duty
     AND u.is_active
     -- Never a hub portal account. hub_id set means a workshop's login
     -- (migration 066), not somebody who works leads. Enforced HERE and not
     -- only on the settings screen, so a stale rota row from before that screen
     -- filtered them cannot quietly route a customer to a workshop.
     AND u.hub_id IS NULL
     AND EXISTS (
       SELECT 1 FROM unnest(a.handles) AS h
        WHERE ${NORM('h')} = ${NORM('$1')}
     )
   -- NULLS FIRST: someone added to the rota this morning goes next, not last.
   -- Tie-broken on user_id so the order is stable rather than whatever the
   -- planner felt like.
   ORDER BY a.last_assigned_at NULLS FIRST, a.user_id
   LIMIT 1`;

async function pickAgent(client, category) {
  if (!category || !String(category).trim()) return null;

  // SKIP LOCKED first: with several messages arriving together this hands each
  // one a different agent without any of them waiting.
  let picked = await client.query(`${ELIGIBLE} FOR UPDATE OF a SKIP LOCKED`, [String(category)]);

  // ── …and a blocking retry, which is not optional ─────────────────────────
  //
  // SKIP LOCKED alone was wrong, and only under load. With three eligible
  // agents and four simultaneous messages, the first three lock a row each and
  // the fourth finds every row locked, returns nothing, and the lead is left
  // UNASSIGNED — not because nobody could take it, but because everybody was
  // being picked at that instant. Measured: four concurrent Car leads produced
  // three owners and one orphan, intermittently, which is the worst kind.
  //
  // So when the fast path finds nobody, ask again and wait. By the time a lock
  // frees, that agent's last_assigned_at has been stamped, so this re-reads the
  // rotation rather than reusing a stale position.
  if (!picked.rows[0]) {
    picked = await client.query(`${ELIGIBLE} FOR UPDATE OF a`, [String(category)]);
  }

  const userId = picked.rows[0]?.user_id || null;
  if (!userId) return null;

  await client.query(
    `UPDATE wa_agents SET last_assigned_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
    [userId]
  );

  return userId;
}

/**
 * Does this user handle this category, and are they on duty for it?
 *
 * Asked of the person who is ALREADY holding a lead, which is why it is not
 * pickAgent: pickAgent chooses and stamps, this only checks. Used to decide
 * whether a provisional owner turned out to be the right one.
 */
async function handlesCategory(client, userId, category) {
  if (!userId || !category) return false;
  const r = await client.query(
    `SELECT 1
       FROM wa_agents a
       JOIN users u ON u.id = a.user_id
      WHERE a.user_id = $1
        AND a.on_duty AND u.is_active AND u.hub_id IS NULL
        AND EXISTS (
          SELECT 1 FROM unnest(a.handles) AS h
           WHERE ${NORM('h')} = ${NORM('$2')}
        )`,
    [userId, String(category)]
  );
  return r.rowCount > 0;
}

/**
 * The first answer that names a category we know about.
 *
 * Deliberately NOT keyed on step_number. The step numbers in the payload are
 * Interakt's, and they renumber the day the flow is edited — routing would then
 * read the answer to a different question and nobody would notice until leads
 * started going to the wrong people.
 *
 * Matching on the VALUE is self-correcting: if the answer is one of the
 * categories somebody ticked in Settings, that is the category, whichever
 * question it happened to answer.
 *
 * @param client  a pg client, for reading the category list
 * @param answers the customer's answers, oldest first
 */
async function categoryFromAnswers(client, answers) {
  const list = (answers || [])
    .map(a => (typeof a === 'string' ? a.trim() : ''))
    .filter(Boolean);
  if (!list.length) return null;

  const known = await client.query(
    `SELECT name FROM wa_categories WHERE is_active`
  );
  const byNorm = new Map(known.rows.map(r => [r.name.trim().toLowerCase(), r.name]));

  for (const answer of list) {
    const hit = byNorm.get(answer.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** One user's display name, or null. Used in notifications and the timeline. */
async function nameOf(client, userId) {
  if (!userId) return null;
  const r = await client.query(`SELECT name FROM users WHERE id = $1`, [userId]);
  return r.rows[0]?.name || null;
}

/** How the lead should be described to a human — its name, else its number. */
async function describeLead(client, leadId) {
  const r = await client.query(`SELECT name, mobile FROM leads WHERE id = $1`, [leadId]);
  return r.rows[0]?.name || r.rows[0]?.mobile || 'A customer';
}

/**
 * Assign a lead, everywhere it needs to be recorded, once.
 *
 * Writes four things because four different questions get asked of them:
 *   leads.assigned_to               "whose lead is this" — the pipeline
 *   wa_conversations.assigned_user  "whose customer is this" — outlives the lead
 *   lead_activities                 "how did it get here" — the Assignment
 *                                   History panel on the lead, which otherwise
 *                                   shows an owner appearing out of nowhere
 *   notifications                   "tell them" — nobody watches a list
 *
 * Idempotent by design: it returns immediately if the lead already has an
 * owner. workflow_response_update is CUMULATIVE and re-fires on every single
 * tap, so without that guard a customer pressing four buttons would hand their
 * lead to four different people in turn.
 *
 * @param source one of 'auto' | 'fallback' — VARCHAR(12), so keep it short
 * @param why    plain English for the timeline note; not shown to the customer
 * @returns {Promise<{assigned: boolean, userId: number|null, reason: string}>}
 */
async function assignLead(client, { leadId, e164, userId, source, why }) {
  if (!leadId || !userId) return { assigned: false, userId: null, reason: 'nothing_to_do' };

  // Re-read inside the transaction. The caller's copy may be a few statements
  // old, and "is it already assigned" is exactly the question a stale read gets
  // wrong.
  const cur = await client.query(
    `SELECT assigned_to FROM leads WHERE id = $1 FOR UPDATE`, [leadId]);
  if (!cur.rowCount) return { assigned: false, userId: null, reason: 'lead_gone' };
  if (cur.rows[0].assigned_to) {
    return { assigned: false, userId: cur.rows[0].assigned_to, reason: 'already_assigned' };
  }

  await client.query(
    `UPDATE leads SET assigned_to = $2, assignment_source = $3 WHERE id = $1`,
    [leadId, userId, source]
  );

  // The conversation remembers the person. This is what makes rule 1 work the
  // next time this number gets in touch.
  if (e164) {
    await client.query(
      `UPDATE wa_conversations SET assigned_user_id = $2 WHERE mobile = $1`,
      [e164, userId]
    );
  }

  const who   = await describeLead(client, leadId);
  const owner = await nameOf(client, userId);

  // created_by NULL, which the Assignment History panel renders as "System".
  // Correct: no person did this, and attributing it to whoever happened to be
  // logged in would be a lie told in an audit trail.
  await client.query(
    `INSERT INTO lead_activities (lead_id, type, old_value, new_value, note, created_by)
     VALUES ($1, 'assigned_changed', NULL, $2, $3, NULL)`,
    [leadId, owner, why || null]
  );

  await client.query(
    `INSERT INTO notifications (user_id, type, title, body, lead_id)
     VALUES ($1, 'lead_assigned', $2, $3, $4)`,
    [userId, 'New WhatsApp lead assigned to you',
     `${who} messaged on WhatsApp. Reply within 24 hours to keep the free-text window open.`,
     leadId]
  );

  return { assigned: true, userId, reason: source };
}

/**
 * The lead already has an owner. Is that still the right answer?
 *
 * Almost always yes, and this returns immediately. There is exactly one case
 * where it is not: the owner was the FALLBACK owner, who took it because
 * nothing was known about the enquiry yet — and something is known now.
 *
 * ── Why only 'fallback' ─────────────────────────────────────────────────────
 *
 * assignment_source is the whole permission system here.
 *
 *   'manual'   a person chose. Never moved. Somebody deciding who handles a
 *              customer and then watching the CRM undo it a minute later would
 *              stop trusting the screen, correctly.
 *   'reply'    an advisor answered first and claimed it. That is a stronger
 *              signal than any rule — they are already in the conversation.
 *   'auto'     routed on a real signal. Moving it would mean the rules
 *              disagreeing with themselves.
 *   'fallback' a placeholder. This is the only one that was ever provisional,
 *              and the only one moved.
 *
 * ── Why it is confirm-OR-hand-off and not just hand-off ─────────────────────
 *
 * If the fallback owner turns out to handle the category anyway — common, since
 * whoever triages is usually on the rota too — the lead stops being provisional
 * and is stamped 'auto'. Without that, every subsequent tap would re-ask the
 * same question forever, and the lead would stay eligible to be moved days
 * later by a stray flow reply.
 */
async function confirmOrHandOff(client, { leadId, e164, answers, currentUserId, source }) {
  const stay = { assigned: false, userId: currentUserId, reason: 'already_assigned' };

  if (source !== 'fallback') return stay;

  const category = await categoryFromAnswers(client, answers);
  // Still nothing to go on. Left provisional on purpose — the customer may tap
  // an option tomorrow, and this should still be able to act on it.
  if (!category) return stay;

  if (await handlesCategory(client, currentUserId, category)) {
    await client.query(
      `UPDATE leads SET assignment_source = 'auto' WHERE id = $1`, [leadId]);
    return { assigned: false, userId: currentUserId, reason: 'fallback_confirmed' };
  }

  const next = await pickAgent(client, category);
  if (!next || next === currentUserId) {
    // Nobody better exists. It stays where it is and stays provisional: a lead
    // with an owner who does not specialise still beats a lead with nobody, and
    // when somebody does come on duty for this category a later tap will move
    // it.
    return { assigned: false, userId: currentUserId, reason: `nobody_on_duty_for_${category}` };
  }

  const fromName = await nameOf(client, currentUserId);
  const toName   = await nameOf(client, next);
  const who      = await describeLead(client, leadId);

  // 'auto' now: it was routed on the customer's actual answer, so it is no
  // longer a guess and must not be revisited again.
  await client.query(
    `UPDATE leads SET assigned_to = $2, assignment_source = 'auto' WHERE id = $1`,
    [leadId, next]);

  if (e164) {
    await client.query(
      `UPDATE wa_conversations SET assigned_user_id = $2 WHERE mobile = $1`,
      [e164, next]);
  }

  await client.query(
    `INSERT INTO lead_activities (lead_id, type, old_value, new_value, note, created_by)
     VALUES ($1, 'assigned_changed', $2, $3, $4, NULL)`,
    [leadId, fromName, toName,
     `Customer chose ${category}. Moved off the fallback owner to whoever handles it.`]);

  // ── Both people are told, and the second one is the point ────────────────
  //
  // The new owner needs to know they have a customer. The PREVIOUS owner needs
  // to know they no longer do — they were notified minutes ago, they may have
  // the thread open, and two advisors typing at one customer is the exact
  // failure routing exists to prevent. A silent removal is worse than no
  // routing at all.
  await client.query(
    `INSERT INTO notifications (user_id, type, title, body, lead_id)
     VALUES ($1, 'lead_assigned', $2, $3, $4)`,
    [next, 'New WhatsApp lead assigned to you',
     `${who} chose ${category} on WhatsApp. Reply within 24 hours to keep the free-text window open.`,
     leadId]);

  await client.query(
    `INSERT INTO notifications (user_id, type, title, body, lead_id)
     VALUES ($1, 'lead_reassigned', $2, $3, $4)`,
    [currentUserId, `A WhatsApp lead moved to ${toName || 'someone else'}`,
     `${who} chose ${category}, which ${toName || 'they'} handle${toName ? 's' : ''}. ` +
     `It is no longer on your list — you had it only until they picked an option.`,
     leadId]);

  return { assigned: true, userId: next, reason: 'recategorised', movedFrom: currentUserId };
}

/**
 * The whole decision, for one inbound conversation.
 *
 * @param answers  what the customer has tapped/typed so far, oldest first.
 *                 Empty on a plain message — that is the normal case now, not
 *                 an error, and rule 3 exists for it.
 */
async function routeInbound(client, { leadId, e164, answers }) {
  if (!leadId) return { assigned: false, userId: null, reason: 'no_lead' };

  // ── Already owned? ───────────────────────────────────────────────────────
  //
  // Asked FIRST, and with the row locked, which is a change: it used to be
  // asked three queries later inside assignLead. Two things now depend on it.
  //
  // One, routeInbound is called twice per conversation — once when the message
  // creates the lead and once when the flow answer arrives — so "already
  // owned" is the ordinary path, not the exception, and running the whole
  // rule stack to discover it is waste.
  //
  // Two, those two calls can overlap by milliseconds. The lock is what makes
  // them take turns instead of both reading "unassigned" and both assigning.
  const owned = await client.query(
    `SELECT assigned_to, assignment_source FROM leads WHERE id = $1 FOR UPDATE`,
    [leadId]);
  if (!owned.rowCount) return { assigned: false, userId: null, reason: 'lead_gone' };

  if (owned.rows[0].assigned_to) {
    return confirmOrHandOff(client, {
      leadId, e164, answers,
      currentUserId: owned.rows[0].assigned_to,
      source: owned.rows[0].assignment_source,
    });
  }

  // ── 0. One person is taking everything ───────────────────────────────────
  //
  // Ahead of continuity too, and deliberately. This mode is chosen when the
  // owner wants every conversation on one desk — usually because they are
  // covering alone, or watching a new setup. "Everything" that quietly excluded
  // returning customers would not be everything, and the exception would only
  // be discovered by a customer being answered by somebody who thought they had
  // switched the rota off.
  const all = await allLeadsOwner(client);
  if (all) {
    const r = await assignLead(client, {
      leadId, e164, userId: all, source: 'auto',
      why: 'One person is set to handle every WhatsApp lead.',
    });
    // Stamped even though the rotation is not being used, so that switching the
    // mode back off does not hand this person the next few leads as well for
    // having sat at the top of the queue the whole time.
    if (r.assigned) {
      await client.query(
        `UPDATE wa_agents SET last_assigned_at = NOW() WHERE user_id = $1`, [all]);
    }
    return r;
  }

  // ── 1. Continuity ────────────────────────────────────────────────────────
  const conv = await client.query(
    `SELECT c.assigned_user_id
       FROM wa_conversations c
       JOIN users u ON u.id = c.assigned_user_id
      WHERE c.mobile = $1 AND u.is_active`,
    [e164]
  );
  const remembered = conv.rows[0]?.assigned_user_id || null;
  if (remembered) {
    return assignLead(client, {
      leadId, e164, userId: remembered, source: 'auto',
      why: 'Already this customer’s advisor from an earlier conversation.',
    });
  }

  // ── 2. Category, then round-robin ────────────────────────────────────────
  const category = await categoryFromAnswers(client, answers);
  if (category) {
    const agent = await pickAgent(client, category);
    if (agent) {
      return assignLead(client, {
        leadId, e164, userId: agent, source: 'auto',
        why: `Customer chose ${category}; next in line on the rota for it.`,
      });
    }
  }

  // ── 3. The fallback owner ────────────────────────────────────────────────
  //
  // Reached two different ways, and both are worth marking provisional:
  //
  //   no category   the customer typed a sentence and tapped nothing. They may
  //                 still tap something, and then this owner is the wrong one.
  //   no agent      the category is known but nobody on duty handles it. The
  //                 right person may come on duty later.
  //
  // So both stamp 'fallback', and confirmOrHandOff revisits either of them.
  const fallback = await unroutedOwner(client);
  if (fallback) {
    const r = await assignLead(client, {
      leadId, e164, userId: fallback, source: 'fallback',
      why: category
        ? `Nobody on duty handles ${category}; went to the fallback owner.`
        : 'No option chosen yet; went to the fallback owner.',
    });
    // Stamped for the same reason the all-leads owner is: they are being given
    // work, and the rota should not owe them a run of leads for the minutes
    // they spent doing it.
    if (r.assigned) {
      await client.query(
        `UPDATE wa_agents SET last_assigned_at = NOW() WHERE user_id = $1`, [fallback]);
    }
    return r;
  }

  return {
    assigned: false,
    userId: null,
    reason: category ? `nobody_on_duty_for_${category}` : 'no_category_yet',
  };
}

module.exports = {
  pickAgent, categoryFromAnswers, assignLead, routeInbound,
  allLeadsOwner, unroutedOwner, handlesCategory, confirmOrHandOff, NORM,
};
