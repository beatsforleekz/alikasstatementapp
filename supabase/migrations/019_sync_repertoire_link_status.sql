-- Keep the legacy repertoire draft_status aligned with real publishing links.
-- Explicit draft records remain drafts; only needs_linking/active are synced.

CREATE OR REPLACE FUNCTION sync_repertoire_status_from_contract_links()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE repertoire
    SET draft_status = 'active'
    WHERE id = NEW.repertoire_id
      AND draft_status = 'needs_linking';
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    UPDATE repertoire
    SET draft_status = 'needs_linking'
    WHERE id = OLD.repertoire_id
      AND repertoire_type = 'work'
      AND draft_status = 'active'
      AND NOT EXISTS (
        SELECT 1
        FROM contract_repertoire_links
        WHERE repertoire_id = OLD.repertoire_id
      );
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_repertoire_status_after_link_insert
  ON contract_repertoire_links;
CREATE TRIGGER trg_sync_repertoire_status_after_link_insert
AFTER INSERT ON contract_repertoire_links
FOR EACH ROW
EXECUTE FUNCTION sync_repertoire_status_from_contract_links();

DROP TRIGGER IF EXISTS trg_sync_repertoire_status_after_link_delete
  ON contract_repertoire_links;
CREATE TRIGGER trg_sync_repertoire_status_after_link_delete
AFTER DELETE ON contract_repertoire_links
FOR EACH ROW
EXECUTE FUNCTION sync_repertoire_status_from_contract_links();

-- Repair existing records that are linked but still carry the stale status.
UPDATE repertoire r
SET draft_status = 'active'
WHERE r.draft_status = 'needs_linking'
  AND EXISTS (
    SELECT 1
    FROM contract_repertoire_links link
    WHERE link.repertoire_id = r.id
  );
