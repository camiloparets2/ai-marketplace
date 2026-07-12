-- Money-bug fix (docs/design/launch.md, "unknown shipping ≠ $0"): the pricing
-- engine no longer fabricates a break-even floor when the shipping estimate
-- is missing — computeFloor returns null and the item is held for review.
-- price_history must be able to record that decision honestly: a null
-- floor_price means "floor uncomputable at decision time", not zero.

alter table public.price_history alter column floor_price drop not null;
