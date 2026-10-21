-- Repair catalogue metadata for rows matched after migration 017 through an
-- automatic/re-match path. This remains fill-only and skips conflicting values.

WITH tempo_candidates AS (
  SELECT
    matched_repertoire_id AS repertoire_id,
    MIN(BTRIM(COALESCE(NULLIF(tempo_id, ''), identifier_raw))) AS tempo_id
  FROM import_rows
  WHERE domain = 'publishing'
    AND matched_repertoire_id IS NOT NULL
    AND NULLIF(BTRIM(COALESCE(NULLIF(tempo_id, ''), identifier_raw)), '') IS NOT NULL
    AND UPPER(REGEXP_REPLACE(COALESCE(NULLIF(tempo_id, ''), identifier_raw), '[-.[:space:]]', '', 'g')) !~ '^T[0-9]{10}$'
  GROUP BY matched_repertoire_id
  HAVING COUNT(DISTINCT UPPER(REGEXP_REPLACE(COALESCE(NULLIF(tempo_id, ''), identifier_raw), '[-.[:space:]]', '', 'g'))) = 1
)
UPDATE repertoire r
SET tempo_id = candidate.tempo_id
FROM tempo_candidates candidate
WHERE r.id = candidate.repertoire_id
  AND NULLIF(BTRIM(r.tempo_id), '') IS NULL;

WITH iswc_candidates AS (
  SELECT
    matched_repertoire_id AS repertoire_id,
    MIN(UPPER(BTRIM(COALESCE(NULLIF(iswc, ''), identifier_raw)))) AS iswc
  FROM import_rows
  WHERE domain = 'publishing'
    AND matched_repertoire_id IS NOT NULL
    AND NULLIF(BTRIM(COALESCE(NULLIF(iswc, ''), identifier_raw)), '') IS NOT NULL
    AND UPPER(REGEXP_REPLACE(COALESCE(NULLIF(iswc, ''), identifier_raw), '[-.[:space:]]', '', 'g')) ~ '^T[0-9]{10}$'
  GROUP BY matched_repertoire_id
  HAVING COUNT(DISTINCT UPPER(REGEXP_REPLACE(COALESCE(NULLIF(iswc, ''), identifier_raw), '[-.[:space:]]', '', 'g'))) = 1
)
UPDATE repertoire r
SET iswc = candidate.iswc
FROM iswc_candidates candidate
WHERE r.id = candidate.repertoire_id
  AND NULLIF(BTRIM(r.iswc), '') IS NULL;
