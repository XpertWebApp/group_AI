-- ============================================================================
-- UAT CUTOVER — Step 02: Create fresh empty master static tables
-- ============================================================================
-- Purpose:
--   After 01-archive-master-to-uat.sql moved the old tables to uat_archive,
--   this recreates them in `master` schema as empty tables with the EXACT
--   same structure Prisma expects (columns, types, indexes, constraints).
--
-- Source of truth: prisma/schema.prisma (models Destination, Hotel, HotelImage,
--   Facility, HotelFacility, HotelFacilityGroup, HotelGiataText,
--   HotelGiataFact, HotelGiataImage, HotelGiataMapping).
--
-- Guarantees:
--   - Wrapped in a single transaction. Any failure = full rollback.
--   - Fails loudly if any target table already exists.
--   - No data. Empty tables ready for LIVE sync.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/uat-cutover/02-create-fresh-master-tables.sql
-- ============================================================================

BEGIN;

-- ---- Guard: none of the master tables must already exist
DO $$
DECLARE
  existing text;
BEGIN
  SELECT string_agg(table_name, ', ')
    INTO existing
    FROM information_schema.tables
   WHERE table_schema = 'master'
     AND table_name IN (
       'destinations', 'hotels', 'hotel_images', 'facilities',
       'hotel_facilities', 'hotel_facility_groups',
       'hotel_giata_texts', 'hotel_giata_facts',
       'hotel_giata_images', 'hotel_giata_mappings'
     );
  IF existing IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: master schema still has: %. Run 01-archive-master-to-uat.sql first.', existing;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- destinations
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE master.destinations (
  id              integer      NOT NULL,
  name            varchar(255) NOT NULL,
  country_code    varchar(10),
  region          varchar(255),
  created_at      timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_synced_at  timestamp(3),
  metadata        jsonb,
  parent_id       integer,
  CONSTRAINT destinations_pkey PRIMARY KEY (id),
  CONSTRAINT destinations_parent_id_fkey
    FOREIGN KEY (parent_id) REFERENCES master.destinations(id)
    ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX destinations_name_idx      ON master.destinations(name);
CREATE INDEX destinations_parent_id_idx ON master.destinations(parent_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- hotels
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE master.hotels (
  hotel_code          varchar(255) NOT NULL,
  name                varchar(255) NOT NULL,
  master_hotel_id     integer,
  hotel_details_url   text,
  destination_id      integer,
  star_rating         numeric(2, 1),
  total_rooms         integer,
  category            varchar(50),
  giata_code          varchar(50),
  address             text,
  address_city        varchar(255),
  address_country     varchar(10),
  latitude            numeric(10, 7),
  longitude           numeric(10, 7),
  property_type       integer,
  supplier_code       varchar(50),
  metadata            jsonb,
  created_at          timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_synced_at      timestamp(3),
  details_fetched_at  timestamp(3),
  giata_synced_at     timestamp(3),
  giata_status        varchar(20),
  CONSTRAINT hotels_pkey PRIMARY KEY (hotel_code)
);
CREATE INDEX hotels_destination_id_name_idx ON master.hotels(destination_id, name);
CREATE INDEX hotels_destination_id_idx      ON master.hotels(destination_id);
CREATE INDEX hotels_supplier_code_idx       ON master.hotels(supplier_code);
CREATE INDEX hotels_name_idx                ON master.hotels(name);

-- ═══════════════════════════════════════════════════════════════════════════
-- hotel_images
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE master.hotel_images (
  id             uuid         NOT NULL DEFAULT gen_random_uuid(),
  hotel_code     varchar(64)  NOT NULL,
  image_key      text         NOT NULL,
  display_order  integer      NOT NULL DEFAULT 0,
  caption        text,
  created_at     timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hotel_images_pkey PRIMARY KEY (id)
);
CREATE INDEX hotel_images_hotel_code_idx               ON master.hotel_images(hotel_code);
CREATE INDEX hotel_images_hotel_code_display_order_idx ON master.hotel_images(hotel_code, display_order);

-- ═══════════════════════════════════════════════════════════════════════════
-- facilities
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE master.facilities (
  id          integer      NOT NULL,
  name        varchar(255) NOT NULL,
  created_at  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT facilities_pkey PRIMARY KEY (id)
);
CREATE INDEX facilities_name_idx ON master.facilities(name);

-- ═══════════════════════════════════════════════════════════════════════════
-- hotel_facilities
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE master.hotel_facilities (
  id           uuid         NOT NULL DEFAULT gen_random_uuid(),
  hotel_code   varchar(255) NOT NULL,
  facility_id  integer      NOT NULL,
  created_at   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hotel_facilities_pkey PRIMARY KEY (id)
);
CREATE INDEX hotel_facilities_hotel_code_idx              ON master.hotel_facilities(hotel_code);
CREATE INDEX hotel_facilities_facility_id_idx             ON master.hotel_facilities(facility_id);
CREATE INDEX hotel_facilities_hotel_code_facility_id_idx  ON master.hotel_facilities(hotel_code, facility_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- hotel_facility_groups
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE master.hotel_facility_groups (
  id           uuid         NOT NULL DEFAULT gen_random_uuid(),
  hotel_code   varchar(64)  NOT NULL,
  group_type   varchar(20)  NOT NULL,
  category     varchar(255),
  facilities   jsonb,
  created_at   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hotel_facility_groups_pkey PRIMARY KEY (id)
);
CREATE INDEX hotel_facility_groups_hotel_code_idx ON master.hotel_facility_groups(hotel_code);
CREATE INDEX hotel_facility_groups_group_type_idx ON master.hotel_facility_groups(group_type);

-- ═══════════════════════════════════════════════════════════════════════════
-- hotel_giata_texts
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE master.hotel_giata_texts (
  id            uuid         NOT NULL DEFAULT gen_random_uuid(),
  hotel_code    varchar(255) NOT NULL,
  giata_id      varchar(50)  NOT NULL,
  lang          varchar(10)  NOT NULL,
  section_type  varchar(20)  NOT NULL,
  title         varchar(255) NOT NULL,
  content       text         NOT NULL,
  last_update   timestamp(3),
  synced_at     timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hotel_giata_texts_pkey PRIMARY KEY (id),
  CONSTRAINT hotel_giata_texts_hotel_code_lang_section_type_key
    UNIQUE (hotel_code, lang, section_type)
);
CREATE INDEX hotel_giata_texts_hotel_code_idx ON master.hotel_giata_texts(hotel_code);
CREATE INDEX hotel_giata_texts_giata_id_idx   ON master.hotel_giata_texts(giata_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- hotel_giata_facts
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE master.hotel_giata_facts (
  id            uuid         NOT NULL DEFAULT gen_random_uuid(),
  hotel_code    varchar(255) NOT NULL,
  giata_id      varchar(50)  NOT NULL,
  section_type  varchar(20)  NOT NULL,
  section_name  varchar(100) NOT NULL,
  fact_id       integer      NOT NULL,
  fact_name     varchar(100) NOT NULL,
  type_hint     varchar(20)  NOT NULL,
  value         varchar(500) NOT NULL,
  unit          varchar(20),
  fee           boolean      DEFAULT false,
  synced_at     timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hotel_giata_facts_pkey PRIMARY KEY (id),
  CONSTRAINT hotel_giata_facts_hotel_code_fact_id_key
    UNIQUE (hotel_code, fact_id)
);
CREATE INDEX hotel_giata_facts_hotel_code_idx   ON master.hotel_giata_facts(hotel_code);
CREATE INDEX hotel_giata_facts_section_type_idx ON master.hotel_giata_facts(section_type);

-- ═══════════════════════════════════════════════════════════════════════════
-- hotel_giata_images
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE master.hotel_giata_images (
  id             uuid         NOT NULL DEFAULT gen_random_uuid(),
  hotel_code     varchar(255) NOT NULL,
  giata_id       varchar(50)  NOT NULL,
  image_type     varchar(5)   NOT NULL,
  display_order  integer      NOT NULL DEFAULT 0,
  url_small      text,
  url_medium     text,
  url_large      text,
  url_full_hd    text,
  url_original   text,
  last_update    timestamp(3),
  synced_at      timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hotel_giata_images_pkey PRIMARY KEY (id)
);
CREATE INDEX hotel_giata_images_hotel_code_idx               ON master.hotel_giata_images(hotel_code);
CREATE INDEX hotel_giata_images_hotel_code_display_order_idx ON master.hotel_giata_images(hotel_code, display_order);

-- ═══════════════════════════════════════════════════════════════════════════
-- hotel_giata_mappings
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE master.hotel_giata_mappings (
  id             uuid         NOT NULL DEFAULT gen_random_uuid(),
  hotel_code     varchar(255) NOT NULL,
  giata_id       varchar(50)  NOT NULL,
  provider_code  varchar(50)  NOT NULL,
  provider_type  varchar(20)  NOT NULL,
  code_value     varchar(255) NOT NULL,
  synced_at      timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hotel_giata_mappings_pkey PRIMARY KEY (id),
  CONSTRAINT hotel_giata_mappings_hotel_code_provider_code_code_value_key
    UNIQUE (hotel_code, provider_code, code_value)
);
CREATE INDEX hotel_giata_mappings_hotel_code_idx    ON master.hotel_giata_mappings(hotel_code);
CREATE INDEX hotel_giata_mappings_giata_id_idx      ON master.hotel_giata_mappings(giata_id);
CREATE INDEX hotel_giata_mappings_provider_code_idx ON master.hotel_giata_mappings(provider_code);

COMMIT;

-- ---- Verify all 10 tables now exist and are empty
\echo '=== Fresh master tables created. Verifying: ==='
SELECT 'destinations'           AS table_name, count(*) AS row_count FROM master.destinations
UNION ALL SELECT 'hotels',                    count(*) FROM master.hotels
UNION ALL SELECT 'hotel_images',              count(*) FROM master.hotel_images
UNION ALL SELECT 'facilities',                count(*) FROM master.facilities
UNION ALL SELECT 'hotel_facilities',          count(*) FROM master.hotel_facilities
UNION ALL SELECT 'hotel_facility_groups',     count(*) FROM master.hotel_facility_groups
UNION ALL SELECT 'hotel_giata_texts',         count(*) FROM master.hotel_giata_texts
UNION ALL SELECT 'hotel_giata_facts',         count(*) FROM master.hotel_giata_facts
UNION ALL SELECT 'hotel_giata_images',        count(*) FROM master.hotel_giata_images
UNION ALL SELECT 'hotel_giata_mappings',      count(*) FROM master.hotel_giata_mappings;

\echo ''
\echo '=== All rowcounts above should be 0. Ready for LIVE static-data sync. ==='
