-- Preserve source writer names independently from payee/artist matching fields.

ALTER TABLE import_rows
  ADD COLUMN IF NOT EXISTS writer_name_raw TEXT;

COMMENT ON COLUMN import_rows.writer_name_raw IS
  'Writer attribution retained verbatim from publishing source imports for catalogue work creation.';

-- Recover rows imported after raw payload preservation was introduced.
UPDATE import_rows
SET writer_name_raw = NULLIF(BTRIM(raw_payload_json ->> 'Writer'), '')
WHERE domain = 'publishing'
  AND NULLIF(BTRIM(writer_name_raw), '') IS NULL
  AND raw_payload_json IS NOT NULL
  AND NULLIF(BTRIM(raw_payload_json ->> 'Writer'), '') IS NOT NULL;

-- The original 2026JUN_1564669_1395491 workbook predates raw-payload writer
-- preservation. These 45 Tempo ID mappings cover every currently unmatched
-- work and were verified as one-to-one against that source workbook.
WITH verified_writers(tempo_id, writer_name) AS (
  VALUES
    ('1215802', 'Iain James, Carl Martin Emanuel Ryden'),
    ('1251605', 'NABIHA BENSOUDA, Carl Martin Emanuel Ryden'),
    ('1251606', 'NABIHA BENSOUDA, Carl Martin Emanuel Ryden'),
    ('1251663', 'Carl Martin Emanuel Ryden; NC: Michael Woods'),
    ('4857842', 'Soeren Vedsgaard Christensen; NC: Danny Ayer, Emil Wilk Roehrmann'),
    ('4858210', 'NABIHA BENSOUDA; NC: Lucien Foort'),
    ('4858214', 'NABIHA BENSOUDA; NC: Roman Salzger'),
    ('5072749', 'NABIHA BENSOUDA; NC: Carl Martin Emanuel Ryden'),
    ('5073031', 'NABIHA BENSOUDA; NC: Anders Pedersen, Soeren Reiff'),
    ('5356835', 'Rino Esposito'),
    ('5386407', 'Soeren Vedsgaard Christensen; NC: Maria Christina Apetri'),
    ('5409281', 'Soeren Vedsgaard Christensen; NC: Jens Damsgaard Kristiansen, Christian Alexander Soerensen'),
    ('5409302', 'Soeren Vedsgaard Christensen; NC: Jeppe Gade Hvirvelkaer'),
    ('6186136', 'Max Loke Linus Reich'),
    ('6186169', 'Max Loke Linus Reich; NC: Charles James Dockins, Simon Lee Marlin'),
    ('6186273', 'Max Loke Linus Reich'),
    ('6186331', 'Max Loke Linus Reich; NC: Petra Maria Hallberg, SAMUEL RUDOLF MALM'),
    ('6635723', 'Soeren Vedsgaard Christensen; NC: Tim Schou Nielsen, Soeren Torpegaard'),
    ('6718132', 'Elvis Elezaj'),
    ('6718143', 'Elvis Elezaj'),
    ('6718308', 'Elvis Elezaj'),
    ('6718347', 'Elvis Elezaj'),
    ('6718393', 'Elvis Elezaj'),
    ('6718414', 'Elvis Elezaj'),
    ('6718448', 'Elvis Elezaj'),
    ('6718457', 'Elvis Elezaj'),
    ('6718465', 'Elvis Elezaj'),
    ('6718469', 'Elvis Elezaj'),
    ('6718470', 'Elvis Elezaj'),
    ('6718483', 'Elvis Elezaj'),
    ('7181384', 'Elvis Elezaj'),
    ('7181385', 'Elvis Elezaj'),
    ('7181390', 'Robin Michelangelo Maichner, Eli Sterling'),
    ('7181391', 'Robin Michelangelo Maichner, Eli Sterling'),
    ('7205022', 'Pauline Bougarel, Alfio Rizzo; NC: Cedric Sylvain Kahn, Emilien Michel Sylvain Mendez, Remi Nicolett, Ludovic Piquemal'),
    ('7248660', 'Derek Ofosu-Amaah; NC: Prince Ofori'),
    ('7443162', 'Elvis Elezaj; NC: Themba Mbongeni Nkosi'),
    ('7522833', 'Alika McGillivary; NC: Christopher Felix De Jesus, Aaron Anthony Evans, Andre Lyon, Anthony Melas, Marcello Valenzano'),
    ('7523324', 'Alika McGillivary; NC: Andre Lyon, Anthony Melas, Marcello Valenzano'),
    ('7568019', 'Elvis Elezaj'),
    ('7568049', 'Elvis Elezaj; NC: Dennis Giusti'),
    ('7663278', 'Carl Martin Emanuel Ryden; NC: Sam Dees, Larry Jr Graham, Tina Graham, MAX LOKE LINUS REICH'),
    ('7710801', 'Alika Leah Monica Amaka McGillivary; NC: Jay Gilbert, Blessing Nicole Yanda'),
    ('7717625', 'Soeren Vedsgaard Christensen; NC: Jeppe Gade Hvirvelkaer, Morten Soegaard, Sophie Ziedoy'),
    ('7717638', 'Soeren Vedsgaard Christensen; NC: Flavia Couri Thorsen, Martin Couri Thorsen')
)
UPDATE import_rows ir
SET writer_name_raw = source.writer_name
FROM verified_writers source
WHERE ir.domain = 'publishing'
  AND NULLIF(BTRIM(ir.writer_name_raw), '') IS NULL
  AND BTRIM(COALESCE(NULLIF(ir.tempo_id, ''), ir.identifier_raw)) = source.tempo_id;
