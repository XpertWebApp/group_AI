-- Normalise existing booking_requests.group_type values to the canonical
-- code set used by the parseGroupType() function in webhook.service.ts.
-- Idempotent: running twice produces the same result (canonical codes
-- already in the target set are mapped to themselves).
--
-- Mapping:
--   business_group / corporate / Corporate / Geschäftsgruppe → business
--   leisure_group                                            → leisure
--   sports_team                                              → sports
--   youth_group                                              → youth
--   school_group                                             → school
--   family / wedding / conference                            → unchanged (already canonical)
--   anything else not NULL                                   → other

UPDATE app.booking_requests
SET group_type = CASE
    WHEN LOWER(group_type) IN ('business', 'business_group', 'corporate', 'geschäftsgruppe') THEN 'business'
    WHEN LOWER(group_type) IN ('leisure', 'leisure_group') THEN 'leisure'
    WHEN LOWER(group_type) IN ('sports', 'sports_team') THEN 'sports'
    WHEN LOWER(group_type) = 'youth_group' THEN 'youth'
    WHEN LOWER(group_type) = 'school_group' THEN 'school'
    WHEN LOWER(group_type) IN ('family', 'wedding', 'conference') THEN LOWER(group_type)
    WHEN LOWER(group_type) IN ('youth', 'school', 'other') THEN LOWER(group_type)
    WHEN group_type IS NULL THEN NULL
    ELSE 'other'
END
WHERE group_type IS NOT NULL;
