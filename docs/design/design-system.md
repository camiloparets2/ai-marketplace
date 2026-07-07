# Snap to List — design system

**Status:** v1 · 2026-07-07 · extends the existing Tailwind v4 setup (no
rip-and-replace). Mobile-first: this is a phone-photo product; every screen
is designed at 390px and then relaxed for desktop.

## Stack

Tailwind CSS v4 (`@theme` tokens in `app/globals.css`), Geist type, no
component library — the shared set lives in **`app/ui/`**. Extend these;
don't hand-roll new button/badge/card styles in pages.

## Tokens (`app/globals.css` `@theme`)

| Token | Utility | Meaning |
|---|---|---|
| `--color-brand` / `-strong` / `-accent` | `bg-brand`, `text-brand`… | blue-600 / blue-700 / indigo-600 — the gradient endpoints of `.btn-primary` and `.text-brand-gradient` |
| `--color-ok` + `--color-ok-surface` | `text-ok`, `bg-ok-surface` | success — green-700 on green-50 (AA on its surface) |
| `--color-warn` + surface | `text-warn`, `bg-warn-surface` | review/held/pending — amber-700 on amber-50 |
| `--color-danger` + surface | `text-danger`, `bg-danger-surface` | errors, failed ends, oversold — red-700 on red-50 |
| `--color-info` + surface | `text-info`, `bg-info-surface` | live/listed — blue-700 on blue-50 |
| `--color-muted` + surface | `text-muted`, `bg-muted-surface` | drafts, ended, neutral |
| `--radius-card` (16px) | `rounded-(--radius-card)` | cards are the roundest surface |
| `--radius-control` (12px) | `rounded-(--radius-control)` | buttons, inputs |
| `--radius-badge` | `rounded-badge` | pills |
| `--spacing-touch` (44px) | `min-h-touch` | WCAG touch-target floor for interactive controls |

Type scale: Tailwind defaults (`text-xs` metadata → `text-2xl` page brand
moments); page titles are `text-lg font-semibold`, section labels
`text-sm font-medium text-gray-700`. Spacing: 4px grid, `gap-6` between
page sections, `gap-3`/`gap-2` inside cards.

## Global behaviors

- `:focus-visible` = 2px brand outline everywhere (keyboard-visible focus,
  WCAG 2.4.7) — never remove outlines locally.
- `prefers-reduced-motion` collapses all animation.
- Status colors mean the same thing on every screen (see StatusBadge).

## Components (`app/ui/`)

| Component | Use | Notes |
|---|---|---|
| `Button` | every action | variants `primary/secondary/ghost/danger`, sizes `sm/md/lg`; `loading` shows spinner + `aria-busy`; md+ meet 44px |
| `Card` | every container | `flush` to manage own padding |
| `StatusBadge` | every lifecycle state | pure `statusIntent(status)` maps all app statuses → `ok/warn/danger/info/muted`; unknown → muted |
| `Input`, `Select` | forms | label/hint/error wiring incl. `aria-describedby`, `aria-invalid`, `role=alert` errors |
| `Modal` | confirm-sized dialogs only | Escape/overlay close, focus trap-in/return, scroll lock; bottom-sheet on phones |
| `ToastProvider` + `useToast()` | async action feedback | mounted in root layout; `success/error/info`; `aria-live=polite`; clears the tab bar |
| `Skeleton`, `SkeletonCard` | loading states | shape-matched placeholders; set `aria-busy` on the region |
| `EmptyState` | zero states | icon + headline + one sentence + one action |
| `ConfidenceMeter` | identification results | 0–1 bar with the **0.80 auto-post threshold marked**; `role=meter`; tone helper tested to stay in sync with `GUARDRAIL_DEFAULTS.minConfidence` |

## Accessibility bar (WCAG 2.1 AA)

- Contrast: status text colors are the -700 shades on -50 surfaces (≥4.5:1);
  don't lighten them.
- Touch targets ≥44px (`min-h-touch`) for primary controls.
- Every form control gets a real `<label>` (Input/Select do this for you).
- Focus is visible, keyboard order follows reading order, dialogs trap and
  return focus.
- Async outcomes are announced (toasts) — never color-only signaling; badges
  carry text, the meter has `aria-valuetext`.

## Rules

1. New screens compose `app/ui/*` — a new visual pattern starts life here,
   documented, or it doesn't ship.
2. Status → color only through `statusIntent`.
3. Publish/approve CTAs must reflect the **dry-run/sandbox gate** (see
   `resolvePublishMode`): never present a production publish as available
   when the flag is off.
