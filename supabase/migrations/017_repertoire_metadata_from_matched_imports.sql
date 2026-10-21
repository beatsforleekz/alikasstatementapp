-- Preserve publishing identifiers independently and fill missing catalogue
-- metadata from confirmed import-row matches. Existing repertoire values are
-- never overwritten, and conflicting source identifiers are skipped.

ALTER TABLE repertoire
  ADD COLUMN IF NOT EXISTS tempo_id TEXT;

ALTER TABLE import_rows
  ADD COLUMN IF NOT EXISTS tempo_id TEXT,
  ADD COLUMN IF NOT EXISTS iswc TEXT;

CREATE INDEX IF NOT EXISTS idx_repertoire_tempo_id ON repertoire(tempo_id);
CREATE INDEX IF NOT EXISTS idx_import_rows_tempo_id ON import_rows(tempo_id);
CREATE INDEX IF NOT EXISTS idx_import_rows_iswc ON import_rows(iswc);

-- Earlier publishing imports stored the primary identifier in identifier_raw.
-- Recover it only where its shape clearly distinguishes Tempo ID from ISWC.
UPDATE import_rows
SET tempo_id = BTRIM(identifier_raw)
WHERE domain = 'publishing'
  AND NULLIF(BTRIM(tempo_id), '') IS NULL
  AND NULLIF(BTRIM(identifier_raw), '') IS NOT NULL
  AND UPPER(REGEXP_REPLACE(identifier_raw, '[-.[:space:]]', '', 'g')) !~ '^T[0-9]{10}$';

UPDATE import_rows
SET iswc = UPPER(BTRIM(identifier_raw))
WHERE domain = 'publishing'
  AND NULLIF(BTRIM(iswc), '') IS NULL
  AND UPPER(REGEXP_REPLACE(identifier_raw, '[-.[:space:]]', '', 'g')) ~ '^T[0-9]{10}$';

WITH tempo_candidates AS (
  SELECT
    matched_repertoire_id AS repertoire_id,
    MIN(BTRIM(tempo_id)) AS tempo_id
  FROM import_rows
  WHERE domain = 'publishing'
    AND matched_repertoire_id IS NOT NULL
    AND NULLIF(BTRIM(tempo_id), '') IS NOT NULL
  GROUP BY matched_repertoire_id
  HAVING COUNT(DISTINCT UPPER(REGEXP_REPLACE(tempo_id, '[-.[:space:]]', '', 'g'))) = 1
)
UPDATE repertoire r
SET tempo_id = candidate.tempo_id
FROM tempo_candidates candidate
WHERE r.id = candidate.repertoire_id
  AND NULLIF(BTRIM(r.tempo_id), '') IS NULL;

WITH iswc_candidates AS (
  SELECT
    matched_repertoire_id AS repertoire_id,
    MIN(UPPER(BTRIM(iswc))) AS iswc
  FROM import_rows
  WHERE domain = 'publishing'
    AND matched_repertoire_id IS NOT NULL
    AND NULLIF(BTRIM(iswc), '') IS NOT NULL
  GROUP BY matched_repertoire_id
  HAVING COUNT(DISTINCT UPPER(REGEXP_REPLACE(iswc, '[-.[:space:]]', '', 'g'))) = 1
)
UPDATE repertoire r
SET iswc = candidate.iswc
FROM iswc_candidates candidate
WHERE r.id = candidate.repertoire_id
  AND NULLIF(BTRIM(r.iswc), '') IS NULL;

-- The earlier 2026 H1 Sony import retained Tempo IDs but not its separate ISWC
-- column. These one-to-one mappings were verified against the original
-- 2026JUN_1564669_1395491 source workbook. Blank source ISWCs and ambiguous
-- mappings are intentionally omitted.
WITH verified_source(repertoire_id, tempo_id, iswc) AS (
  VALUES
    ('9e8d5dba-2913-4875-973f-99eb6568e81a'::UUID, '4857888', 'T9174125849'),
    ('de6461ab-760e-4a04-808d-36e0c3179405'::UUID, '6690433', 'T3242731637'),
    ('0328281e-032b-44bb-8dd4-9a82222535ca'::UUID, '6717846', 'T3254552693'),
    ('f02f3e17-400f-4941-a4a7-88e882314470'::UUID, '6717858', 'T3254552875'),
    ('4dad0360-7548-40d4-abc5-c24d43e9e61b'::UUID, '1226166', 'T9123309579'),
    ('7cae601f-a366-41ef-89e4-849307553702'::UUID, '7248732', 'T3347518832'),
    ('917ea9dc-4a01-4a2a-b22d-66efb3c4c8ea'::UUID, '7086381', 'T3306077083'),
    ('d8b2a1f1-df1b-40aa-aa79-c7f9d964a430'::UUID, '6485163', 'T3213051760'),
    ('6aa5b4f3-1692-4b07-869f-5db2e8d85ad7'::UUID, '6185870', 'T9115317505'),
    ('24f0ac75-16cb-4a9c-bbe5-62ec20102841'::UUID, '1251585', 'T2051739466'),
    ('10968783-483f-4e32-aecd-2a15e6bce05f'::UUID, '7248738', 'T3347519335'),
    ('516a5cc6-930f-40a0-8ea4-508a25506e62'::UUID, '7518808', 'T3360489885'),
    ('8953a9bf-c4ad-4570-96c2-59c199963d45'::UUID, '7248736', 'T3347519200'),
    ('2c708469-d9c7-42b9-9472-a549e150be94'::UUID, '7252006', 'T3346575999'),
    ('463d76b7-c7e7-47bf-bb9d-fe273e5c9d44'::UUID, '7248734', 'T3347518912'),
    ('bd45ec2f-130a-4e6e-aea4-dbb33f5ad4e1'::UUID, '5409218', 'T9138933763'),
    ('a5c7593c-b6a2-462e-ad8f-2a9bab7a2785'::UUID, '6718094', 'T3254554520'),
    ('e97dc610-ec59-4e5a-a946-f25a92364ee8'::UUID, '5409223', 'T9138933752'),
    ('3a2ccdfd-74cf-499f-b4a1-1fe872be7027'::UUID, '7225671', 'T3344495149'),
    ('56f501e4-6296-4fbd-a3f4-d8a41ae94563'::UUID, '7181377', 'T3329875590'),
    ('a64875a7-7f35-4848-aa64-8b13872aadd3'::UUID, '6718141', 'T3254555034'),
    ('52a4cd85-663c-4449-b317-9f34130db815'::UUID, '7086383', 'T3306076955'),
    ('539621f6-2e0c-4988-a92b-c373b8770c64'::UUID, '6718166', 'T3254555329'),
    ('c13165b2-45a6-455e-aecd-26b792842d1b'::UUID, '4858220', 'T9203084677'),
    ('535ae8db-0def-4b02-9e5d-59469339d540'::UUID, '6718241', 'T3254555603'),
    ('ccadf5e7-43fa-4180-9f8f-3a5ee6a563db'::UUID, '6186198', 'T9092326426'),
    ('5cd92c73-5dbf-4637-b68b-b691da4604cb'::UUID, '7181375', 'T3248330505'),
    ('f8fcf118-45e2-4bc8-8ddf-2fe5f7b81b78'::UUID, '734017', 'T9137012783'),
    ('53b3ab0d-2b6f-475d-bed2-931e2d6bf23b'::UUID, '7251189', 'T3278831719'),
    ('f325b842-b121-443a-bba5-ca4f1b6bf2ed'::UUID, '6529159', 'T3213051759'),
    ('0d83b377-88b4-4f41-8629-c9668abe8dea'::UUID, '6635715', 'T3188712047'),
    ('be413248-f3f2-401e-9c7e-9e25405ca9de'::UUID, '7196070', 'T3219894681'),
    ('2f269447-81d4-4c07-a99a-f01eff365faa'::UUID, '1333024', 'T9123373126'),
    ('412f8f99-23e9-4442-bf20-737be1f52166'::UUID, '6718357', 'T3254556866'),
    ('5e158cc8-6c73-4607-9a5e-b482244425b8'::UUID, '6187193', 'T9282624219'),
    ('cd5ac511-6b49-40c1-b94a-41249dbf9551'::UUID, '718894', 'T9101277025'),
    ('14325151-a318-4479-9ec9-9a81fee07770'::UUID, '6718443', 'T3254557789'),
    ('54e57184-b257-4e0a-9685-0dfd56aac749'::UUID, '4027722', 'T9108629589'),
    ('21e7ca74-3424-47ec-a6f2-e466e7f16e73'::UUID, '7066796', 'T3381168356'),
    ('eab235d9-3775-477e-a633-fc4ffcab4b33'::UUID, '7066801', 'T3381163317'),
    ('90a21f77-f4b3-40e3-b516-3be2b43d2697'::UUID, '6718466', 'T3254558099'),
    ('6b32a0d1-594a-4294-9d09-a87a19c02f18'::UUID, '738590', 'T9054527967')
)
UPDATE repertoire r
SET
  tempo_id = CASE
    WHEN NULLIF(BTRIM(r.tempo_id), '') IS NULL THEN source.tempo_id
    ELSE r.tempo_id
  END,
  iswc = CASE
    WHEN NULLIF(BTRIM(r.iswc), '') IS NULL THEN source.iswc
    ELSE r.iswc
  END
FROM verified_source source
WHERE r.id = source.repertoire_id
  AND (
    NULLIF(BTRIM(r.tempo_id), '') IS NULL
    OR NULLIF(BTRIM(r.iswc), '') IS NULL
  );

COMMENT ON COLUMN import_rows.tempo_id IS
  'Publishing Tempo/Sony Song ID retained separately from fallback identifiers.';

COMMENT ON COLUMN import_rows.iswc IS
  'Publishing ISWC retained separately so catalogue metadata can be enriched after manual matching.';
