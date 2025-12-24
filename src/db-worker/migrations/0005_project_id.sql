ALTER TABLE items ADD COLUMN project_id TEXT;

UPDATE items SET project_id = id WHERE type = 'project';

WITH RECURSIVE chain(id, parent_id, project_id) AS (
  SELECT id, parent_id,
    CASE WHEN type = 'project' THEN id ELSE NULL END
  FROM items
  UNION ALL
  SELECT c.id, p.parent_id,
    COALESCE(c.project_id, CASE WHEN p.type = 'project' THEN p.id ELSE p.project_id END)
  FROM chain c
  JOIN items p ON p.id = c.parent_id
  WHERE c.project_id IS NULL AND c.parent_id IS NOT NULL
)
UPDATE items
SET project_id = (
  SELECT chain.project_id
  FROM chain
  WHERE chain.id = items.id AND chain.project_id IS NOT NULL
  LIMIT 1
)
WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_items_project_id ON items(project_id);
