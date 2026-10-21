-- Make Needs Linking reflect actual publishing contract links. Draft remains an
-- explicit manual state; every other work is active only when at least one link
-- exists. This keeps the server-side Needs Linking filter reliable.

CREATE OR REPLACE FUNCTION enforce_repertoire_status_from_links()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.repertoire_type = 'work'
     AND COALESCE(NEW.draft_status, 'active') <> 'draft' THEN
    IF EXISTS (
      SELECT 1
      FROM contract_repertoire_links link
      WHERE link.repertoire_id = NEW.id
    ) THEN
      NEW.draft_status := 'active';
    ELSE
      NEW.draft_status := 'needs_linking';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_repertoire_status_from_links
  ON repertoire;
CREATE TRIGGER trg_enforce_repertoire_status_from_links
BEFORE INSERT OR UPDATE OF repertoire_type, draft_status
ON repertoire
FOR EACH ROW
EXECUTE FUNCTION enforce_repertoire_status_from_links();

-- Correct all existing non-draft publishing works from their real link state.
UPDATE repertoire r
SET draft_status = CASE
  WHEN EXISTS (
    SELECT 1
    FROM contract_repertoire_links link
    WHERE link.repertoire_id = r.id
  ) THEN 'active'
  ELSE 'needs_linking'
END
WHERE r.repertoire_type = 'work'
  AND COALESCE(r.draft_status, 'active') <> 'draft';
