// QA regression (launch pass, 2026-07-07): the root snap page and /login
// shipped with no <h1> at all — the brand wordmark was bare <span>s — so
// screen readers and SEO got a heading-less document. The fix wraps the
// wordmark in <h1> (visually inert under Tailwind preflight). This locks the
// heading in place at the source level.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string): string =>
  readFileSync(join(process.cwd(), p), "utf8");

describe("page heading structure", () => {
  it("the snap page keeps an h1 around the brand wordmark", () => {
    const src = read("app/page.tsx");
    expect(src).toMatch(/<h1[^>]*>\s*<BrandWordmark/);
  });

  it("the login page keeps an h1 around the brand wordmark", () => {
    const src = read("app/login/page.tsx");
    expect(src).toMatch(/<h1[^>]*>\s*<BrandWordmark/);
  });
});
