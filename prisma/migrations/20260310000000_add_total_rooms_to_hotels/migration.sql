-- Add total_rooms to master.hotels
-- Used by Step 3.2 (Inventory Overlap Check) in the hotel search algorithm.
-- total_rooms = physical room count from WBE static data (TotalRooms field).
-- NULL means unknown — overlap check skips the ratio check and flags the offer instead.

ALTER TABLE master.hotels ADD COLUMN IF NOT EXISTS total_rooms INTEGER;

-- Index to speed up overlap checks during hotel search
CREATE INDEX IF NOT EXISTS hotels_total_rooms_idx ON master.hotels (total_rooms);
