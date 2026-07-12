-- Cover foreign keys used by cascading deletes and reconciliation queries.
create index if not exists publish_attempts_inventory_item_idx
  on public.publish_attempts (inventory_item_id);
create index if not exists sold_events_inventory_item_idx
  on public.sold_events (inventory_item_id);
create index if not exists price_history_user_idx
  on public.price_history (user_id);
