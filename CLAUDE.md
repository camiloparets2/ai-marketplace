\# CLAUDE.md — ai-marketplace



> This file is read automatically by Claude Code on every session start.

> It defines the project context, stack, and gstack skill conventions for this workspace.



\---



\## 🗂 Project Overview



\*\*Name:\*\* ai-marketplace  

\*\*Owner:\*\* Camilo (Systems Coordinator \& Data Scientist)  

\*\*Goal:\*\* A "Snap-to-List" tool that lets users photograph an item and instantly generate optimized listings for eBay and Etsy, plus a custom \*\*No-Fee direct marketplace\*\* with Stripe-powered checkout.



\---



\## 🧱 Stack



| Layer | Technology |

|---|---|

| Frontend | Next.js + TypeScript |

| Backend / DB | Supabase (PostgreSQL) + Edge Functions |

| AI Engine | Claude 3.5 / 4.6 Vision API (image → listing) |

| Marketplace SDKs | eBay SDK, Etsy API |

| Payments | Stripe (direct checkout) |

| Frontend Deploy | Vercel |

| Backend Deploy | Supabase Edge Functions |



\---



\## 🛠 gstack Skills



gstack skills are slash-command agents that each own a specific phase of the product lifecycle.

\*\*Always invoke the appropriate skill before writing code or tests.\*\*



\---



\### `/office-hours` — Product Strategy \& Design Lead



\*\*When to use:\*\*

Before writing any code, designing any schema, or building any feature — invoke `/office-hours` to validate the idea first.



\*\*What it does:\*\*

Acts as a YC-style Product Strategy \& Design Lead. It pressure-tests the product idea by asking \*\*6 forcing questions\*\* that reframe the problem and challenge assumptions. It will not let you skip to implementation until the idea is defensible.



\*\*Output:\*\*

Produces a \*\*Design Doc\*\* — a structured specification that defines the problem, constraints, user journey, and success criteria. This doc becomes the source of truth that all other skills (coding, QA, etc.) follow.



\*\*Workflow:\*\*

```

/office-hours → answer 6 forcing questions → receive Design Doc → proceed to implementation

```



\*\*Rules:\*\*

\- Never start a new feature without a Design Doc from `/office-hours`.

\- If scope changes mid-build, re-run `/office-hours` for the changed surface.

\- The Design Doc lives at `docs/design/\[feature-name].md` in this repo.



\---



\### `/qa` — QA Lead Agent



\*\*When to use:\*\*

After any feature is built, before merging to `main`, or when a bug is reported.



\*\*What it does:\*\*

Activates a live QA agent that uses a real \*\*Chromium browser\*\* (via the `/browse` skill) to navigate the running application — local or deployed. It does not mock or simulate; it interacts with the actual UI.



\*\*Full QA cycle:\*\*

1\. \*\*Explore\*\* — navigates the app and exercises the feature under test

2\. \*\*Find bugs\*\* — identifies broken behavior, UI regressions, or logic errors

3\. \*\*Screenshot\*\* — captures visual evidence of each issue found

4\. \*\*Root-cause\*\* — traces the bug back to the specific file and line in the codebase

5\. \*\*Fix\*\* — creates an \*\*atomic commit\*\* per bug with a clear message

6\. \*\*Regression test\*\* — auto-generates a test (unit or e2e) to prevent the bug from returning



\*\*Workflow:\*\*

```

/qa \[feature or URL] → browser session opens → bug report generated → fixes committed → regression tests written

```



\*\*Rules:\*\*

\- Always run `/qa` against the local dev server (`localhost:3000`) before deploying to Vercel.

\- Each fix must be its own atomic commit — no bundled changes.

\- Regression tests go in `tests/regression/` and must pass in CI before merge.

\- If `/qa` finds a design-level problem (not just a code bug), escalate back to `/office-hours`.



\---



\## 📁 Key Directories



```

ai-marketplace/

├── CLAUDE.md                  ← you are here

├── docs/

│   └── design/                ← Design Docs produced by /office-hours

├── app/                       ← Next.js app router pages \& components

├── lib/                       ← Shared utilities (eBay SDK, Etsy API, Stripe, Supabase client)

├── supabase/

│   ├── functions/             ← Edge Functions (backend logic)

│   └── migrations/            ← SQL schema migrations

├── tests/

│   └── regression/            ← Auto-generated regression tests from /qa

└── public/

```



\---



\## ⚙️ Dev Conventions



\- \*\*Branching:\*\* `feature/\[name]`, `fix/\[name]`, `chore/\[name]`

\- \*\*Commits:\*\* Atomic, imperative mood — e.g. `fix: handle null eBay listing ID on retry`

\- \*\*Env vars:\*\* Never hardcoded. Use `.env.local` locally; Vercel env panel in production.

\- \*\*Types:\*\* Strict TypeScript. No `any`. Supabase types are generated via `supabase gen types`.

\- \*\*AI calls:\*\* All Vision API calls go through `lib/ai/vision.ts` — never call the API directly from a component.



\---



\## 🚀 Local Dev



```bash

\# Install deps

npm install



\# Start Next.js dev server

npm run dev



\# Start Supabase locally

supabase start



\# Generate Supabase types

supabase gen types typescript --local > lib/types/supabase.ts

```



\---



\## 🔑 Key Identifiers (do not commit values, only structure)



| Variable | Purpose |

|---|---|

| `NEXT\_PUBLIC\_SUPABASE\_URL` | Supabase project URL |

| `NEXT\_PUBLIC\_SUPABASE\_ANON\_KEY` | Supabase anon key (client-safe) |

| `SUPABASE\_SERVICE\_ROLE\_KEY` | Supabase service role (Edge Functions only) |

| `ANTHROPIC\_API\_KEY` | Claude Vision API |

| `EBAY\_CLIENT\_ID` / `EBAY\_CLIENT\_SECRET` | eBay SDK credentials |

| `ETSY\_API\_KEY` | Etsy API key |

| `STRIPE\_SECRET\_KEY` | Stripe backend key |

| `STRIPE\_WEBHOOK\_SECRET` | Stripe webhook verification |



## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health

