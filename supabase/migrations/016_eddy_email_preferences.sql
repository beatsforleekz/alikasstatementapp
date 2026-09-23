-- Optional reusable Eddy email personalization. Subjects are stored as
-- templates so {period} resolves to the current run instead of copying an old
-- period literally.
CREATE TABLE IF NOT EXISTS eddy_master_email_preferences (
  identity_key            TEXT PRIMARY KEY,
  payee_id                UUID REFERENCES payees(id) ON DELETE SET NULL,
  eddy_payee_id           TEXT,
  normalized_artist_name  TEXT NOT NULL,
  greeting_name           TEXT,
  reference_name          TEXT,
  subject_template        TEXT,
  updated_by              UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (char_length(trim(identity_key)) > 0),
  CHECK (char_length(trim(normalized_artist_name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_eddy_email_preferences_payee
  ON eddy_master_email_preferences(payee_id);
CREATE INDEX IF NOT EXISTS idx_eddy_email_preferences_eddy_payee
  ON eddy_master_email_preferences(eddy_payee_id);

DROP TRIGGER IF EXISTS trg_eddy_master_email_preferences_updated_at
  ON eddy_master_email_preferences;
CREATE TRIGGER trg_eddy_master_email_preferences_updated_at
  BEFORE UPDATE ON eddy_master_email_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE eddy_master_email_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_all_eddy_master_email_preferences"
  ON eddy_master_email_preferences;
CREATE POLICY "staff_all_eddy_master_email_preferences"
  ON eddy_master_email_preferences FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));

COMMENT ON TABLE eddy_master_email_preferences IS
  'Opt-in greeting, reference-name and subject templates reused across Eddy Master Run periods.';
