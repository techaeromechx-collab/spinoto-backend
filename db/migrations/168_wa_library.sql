-- 168_wa_library.sql
--
-- Two things an admin can configure and an agent can use: a library of images,
-- and a set of canned replies.
--
-- ── WHY THESE ARE NOT TEMPLATES ─────────────────────────────────────────────
--
-- wa_templates holds Meta-APPROVED message templates: they exist on Interakt's
-- side, carry a provider_template_name, have positional variables, and are the
-- only thing that may be sent OUTSIDE the 24-hour window. None of that applies
-- here. An image from this library and a quick reply are both ordinary
-- free-form messages, legal only INSIDE the window, invented by the workshop
-- with nobody's approval. Putting them in wa_templates would mean every
-- template screen, the outbox worker's JOIN, and the fingerprint check all had
-- to learn to ignore rows that are not templates.
--
-- ── WHY TWO TABLES AND NOT ONE ──────────────────────────────────────────────
--
-- They look similar — a name, a payload, an active flag — and they are not the
-- same thing. An image has a URL that must be publicly fetchable and an
-- ImageKit file id; a quick reply has a shortcut that must be unique and
-- message text with no length limit worth enforcing. One table would carry
-- both sets of columns with half of them NULL on every row, and a `kind`
-- column that every query has to remember to filter on.

-- ══ IMAGES ═════════════════════════════════════════════════════════════════
--
-- The FILE is not stored here and is not uploaded through this CRM. It lives
-- on ImageKit, and this table holds its address. That is not a shortcut — it
-- is forced by how sending works: WhatsApp fetches the image from ITS OWN
-- servers, so the only thing that can be sent is a publicly reachable URL.
-- A copy in our database would be a copy nobody could deliver.
CREATE TABLE IF NOT EXISTS wa_images (
  id                SERIAL PRIMARY KEY,

  -- What the agent sees in the picker. The URL is never shown to them.
  name              VARCHAR(120) NOT NULL,

  -- Must be an absolute http(s) address. Validated in the controller rather
  -- than by a CHECK: the rule is "WhatsApp can fetch this", which is a
  -- judgement about the outside world, and a CHECK constraint that only
  -- half-expresses it would give false confidence.
  imagekit_url      TEXT NOT NULL,

  -- ImageKit's own handle. Optional, because an admin pasting a URL may not
  -- have it — the file was uploaded through ImageKit's dashboard, not through
  -- us. Stored when known so a future "delete the file too" is possible;
  -- nothing deletes it today.
  imagekit_file_id  VARCHAR(120),

  -- Inactive hides it from the agent's picker immediately and changes nothing
  -- about images already sent. Deliberately not a soft-delete flag: a row can
  -- also be deleted outright, and the two mean different things — "not this
  -- season" versus "this was a mistake".
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,

  created_by        INTEGER REFERENCES users(id),
  updated_by        INTEGER REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Two images may legitimately share a URL — the same photo offered as
-- "Workshop map" and "Directions" is a naming choice, not a mistake. The NAME
-- is what must be unique, because that is what the agent picks from, and two
-- identical entries in a picker is a coin toss.
--
-- Case-insensitive: "Price list" and "Price List" are the same choice to a
-- human, and a picker offering both is the problem this prevents.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_images_name
  ON wa_images (LOWER(TRIM(name)));

-- The agent's read: active only, alphabetical.
CREATE INDEX IF NOT EXISTS idx_wa_images_active
  ON wa_images (is_active, name);

COMMENT ON TABLE  wa_images IS
  'Pre-approved images an agent can send from the WhatsApp chat. Holds the ImageKit ADDRESS, never the file — WhatsApp fetches the image from its own servers, so only a public URL can be delivered.';
COMMENT ON COLUMN wa_images.imagekit_url IS
  'Absolute public https URL. Validated in the controller; a relative or private address cannot be fetched by WhatsApp and would fail at send time.';
COMMENT ON COLUMN wa_images.is_active IS
  'FALSE hides it from the agent picker at once. Images already sent are unaffected.';

-- ══ QUICK REPLIES ══════════════════════════════════════════════════════════
--
-- Canned text an agent drops INTO the composer. Deliberately not "canned text
-- an agent sends": the message is inserted for review, because a stock answer
-- is only safe when a person confirms it fits the question that was asked.
CREATE TABLE IF NOT EXISTS wa_quick_replies (
  id            SERIAL PRIMARY KEY,

  title         VARCHAR(120) NOT NULL,

  -- '/location', '/timing'. Optional — a reply is perfectly usable from the
  -- picker with no shortcut at all, and forcing one would mean inventing
  -- '/reply7' for the fourth similar message.
  shortcut      VARCHAR(40),

  message       TEXT NOT NULL,

  is_active     BOOLEAN NOT NULL DEFAULT TRUE,

  created_by    INTEGER REFERENCES users(id),
  updated_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A shortcut is an identifier, so duplicates make it useless — but NULL is a
-- legitimate value here and several rows may have none. A plain UNIQUE would
-- allow that in PostgreSQL (NULLs do not conflict), and the partial index
-- says so explicitly rather than relying on the reader knowing it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_quick_replies_shortcut
  ON wa_quick_replies (LOWER(TRIM(shortcut)))
  WHERE shortcut IS NOT NULL AND TRIM(shortcut) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_quick_replies_title
  ON wa_quick_replies (LOWER(TRIM(title)));

CREATE INDEX IF NOT EXISTS idx_wa_quick_replies_active
  ON wa_quick_replies (is_active, title);

COMMENT ON TABLE  wa_quick_replies IS
  'Canned messages an agent inserts into the WhatsApp composer. Inserted for review, never sent directly — a stock answer is only safe once a person has confirmed it fits.';
COMMENT ON COLUMN wa_quick_replies.shortcut IS
  'Optional /slug shown beside the title. Unique among non-empty values.';

-- ══ THE LOCAL-UPLOAD SWITCH ════════════════════════════════════════════════
--
-- Whether agents may attach a file from their own computer — the paperclip.
--
-- Stored in integration_settings (migration 152) rather than as a column
-- somewhere, because that table already exists for exactly this: one value,
-- read by the app, editable from a settings screen. A dedicated table for a
-- single boolean would be a table to maintain forever.
--
-- No row is inserted here. integrationSettings.getSetting() returns '' for a
-- key with no row, and the controller treats anything other than the literal
-- 'false' as ON — so the feature keeps working exactly as it does today until
-- somebody deliberately turns it off. Seeding 'true' would look tidier and
-- would mean an install that never visits this screen depends on a row that
-- may or may not have been inserted.
DO $$
BEGIN
  IF to_regclass('integration_settings') IS NULL THEN
    RAISE NOTICE '168: integration_settings is missing — run migration 152 first. '
                 'The paperclip stays ON, which is the pre-168 behaviour.';
  END IF;
END $$;
