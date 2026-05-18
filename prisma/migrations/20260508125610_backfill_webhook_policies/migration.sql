-- Backfill default Terms & Conditions / Cancellation Conditions on historical
-- webhook-created booking requests. Webhook ingestion never stored these fields
-- before today's fix (the WordPress + Wix forms don't carry them), so older rows
-- have NULL in both columns.
--
-- Format MUST match the dashboard's rich-text editor output (`<ol><li>…</li></ol>`)
-- otherwise the dashboard will collapse the text into a single paragraph instead
-- of rendering as a numbered list.
--
-- Idempotent: only updates rows where the column is currently NULL, so re-running
-- this migration won't overwrite values supplied by staff edits afterwards.
-- Scoped to `source = 'webhook'` so portal-created rows are untouched.

UPDATE app.booking_requests
SET terms_and_conditions = '<ol style="list-style-type: decimal; padding-left: 1.5rem;"><li>All prices are per room per night unless otherwise stated</li><li>Prices are subject to availability at time of booking</li><li>Full payment required 30 days before arrival</li><li>Cancellation policy applies as per individual hotel terms</li><li>Group rates are valid for minimum 10 participants</li><li>Final room list required 14 days before arrival</li></ol>'
WHERE source = 'webhook'
  AND terms_and_conditions IS NULL;

UPDATE app.booking_requests
SET cancellation_conditions = '<ol style="list-style-type: decimal; padding-left: 1.5rem;"><li>Cancellations made 14 days or more in advance of the event date will receive a 100% refund.</li><li>Cancellations made within 7 days will incur a 50% fee.</li></ol>'
WHERE source = 'webhook'
  AND cancellation_conditions IS NULL;
