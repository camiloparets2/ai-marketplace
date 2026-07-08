-- Guardrail review routing (docs/design/launch.md P0-5): when an auto-post
-- gate fails, the item lands in status='review' and the failing gates are
-- recorded here so the review queue can show "why is this item held?".
-- Shape: [{ "gate": "confidence", "reason": "…" }, …]

alter table public.inventory_items
  add column if not exists review_reasons jsonb not null default '[]'::jsonb;
