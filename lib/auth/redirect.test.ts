import { describe, it, expect } from "vitest";
import { safeNextPath } from "./redirect";

describe("safeNextPath", () => {
  it("allows same-origin absolute paths", () => {
    expect(safeNextPath("/")).toBe("/");
    expect(safeNextPath("/reset-password")).toBe("/reset-password");
    expect(safeNextPath("/dashboard?tab=sales")).toBe("/dashboard?tab=sales");
  });

  it("falls back to / when missing", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath("")).toBe("/");
  });

  it("rejects absolute URLs", () => {
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("http://evil.example/phish")).toBe("/");
  });

  it("rejects protocol-relative URLs", () => {
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("//evil.example/path")).toBe("/");
  });

  it("rejects backslash smuggling", () => {
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("\\\\evil.example")).toBe("/");
  });

  it("rejects relative paths and other schemes", () => {
    expect(safeNextPath("reset-password")).toBe("/");
    expect(safeNextPath("javascript:alert(1)")).toBe("/");
  });
});
