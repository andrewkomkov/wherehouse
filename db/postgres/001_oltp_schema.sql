-- OLTP side: the user's workspace.
-- Everything here is mutable, transactional, single-row-latency work — the exact
-- shape ClickHouse is bad at. CDC'd into ClickHouse via ClickPipes so the analytical
-- side can join a user's portfolio against 75M Overture POIs.
--
-- Managed Postgres 18.4 (ClickHouse Cloud, eu-west-1). wal_level=logical already set.

-- A named search a user is working on: "bakery in Berlin, walkable".
CREATE TABLE IF NOT EXISTS shortlists (
    id           BIGSERIAL PRIMARY KEY,
    chat_id      TEXT        NOT NULL,          -- ties back to trigger.dev chat.agent chatId
    user_id      TEXT        NOT NULL,
    title        TEXT        NOT NULL,
    city         TEXT        NOT NULL,          -- berlin | amsterdam | belgrade
    business_type TEXT       NOT NULL,          -- bakery | pharmacy | cafe | clinic | kindergarten
    weights      JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- user's factor weights
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A candidate site the user saved. This is the object the whole product is about.
CREATE TABLE IF NOT EXISTS saved_sites (
    id           BIGSERIAL PRIMARY KEY,
    shortlist_id BIGINT      NOT NULL REFERENCES shortlists(id) ON DELETE CASCADE,
    user_id      TEXT        NOT NULL,
    label        TEXT        NOT NULL,
    note         TEXT,
    lon          DOUBLE PRECISION NOT NULL,
    lat          DOUBLE PRECISION NOT NULL,
    h3_8         TEXT        NOT NULL,          -- computed app-side; the join key into ClickHouse
    score        REAL,                          -- last score we showed the user
    status       TEXT        NOT NULL DEFAULT 'candidate',  -- candidate | shortlisted | rejected | signed
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saved_sites_shortlist_idx ON saved_sites (shortlist_id);
CREATE INDEX IF NOT EXISTS saved_sites_user_idx      ON saved_sites (user_id);
CREATE INDEX IF NOT EXISTS saved_sites_h3_idx        ON saved_sites (h3_8);

-- Keep updated_at honest — CDC replays these as new versions, which is what gives us
-- the "how did my shortlist evolve" timeline for free.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shortlists_touch ON shortlists;
CREATE TRIGGER shortlists_touch BEFORE UPDATE ON shortlists
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS saved_sites_touch ON saved_sites;
CREATE TRIGGER saved_sites_touch BEFORE UPDATE ON saved_sites
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ClickPipes CDC needs REPLICA IDENTITY FULL to ship before-images on UPDATE/DELETE.
ALTER TABLE shortlists  REPLICA IDENTITY FULL;
ALTER TABLE saved_sites REPLICA IDENTITY FULL;

-- Publication consumed by the ClickPipe.
DROP PUBLICATION IF EXISTS wherehouse_pub;
CREATE PUBLICATION wherehouse_pub FOR TABLE shortlists, saved_sites;
