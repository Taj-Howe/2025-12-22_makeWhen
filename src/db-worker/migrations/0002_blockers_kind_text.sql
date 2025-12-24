ALTER TABLE blockers ADD COLUMN kind TEXT NOT NULL DEFAULT 'general';
ALTER TABLE blockers ADD COLUMN text TEXT NOT NULL DEFAULT '';

UPDATE blockers
SET text = reason
WHERE (text IS NULL OR text = '')
  AND reason IS NOT NULL;
