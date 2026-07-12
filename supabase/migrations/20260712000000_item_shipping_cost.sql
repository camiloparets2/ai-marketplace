-- Draft publish/retry (fix/draft-publish-and-credits): republishing a draft
-- must reuse the stored analysis instead of re-running (and re-charging) AI.
-- The shipping estimate was the one pricing input that never got persisted —
-- review approvals republished with shippingCost null, which the money rule
-- (never treat unknown shipping as $0) now refuses. Store it on the item.
alter table public.inventory_items
  add column if not exists shipping_cost numeric(10, 2)
    check (shipping_cost is null or shipping_cost >= 0);
