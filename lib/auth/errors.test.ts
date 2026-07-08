import { describe, it, expect } from "vitest";
import { friendlyAuthError, GOOGLE_NOT_ENABLED_MESSAGE } from "./errors";

describe("friendlyAuthError", () => {
  it("maps a disabled Google provider to actionable copy", () => {
    expect(
      friendlyAuthError("Unsupported provider: provider is not enabled", "google")
    ).toBe(GOOGLE_NOT_ENABLED_MESSAGE);
    expect(friendlyAuthError("provider is not enabled", "google")).toBe(
      GOOGLE_NOT_ENABLED_MESSAGE
    );
  });

  it("maps an invalid API key (misconfig) to a config message", () => {
    expect(friendlyAuthError("Invalid API key", "google")).toBe(
      GOOGLE_NOT_ENABLED_MESSAGE
    );
    // without a provider label, stays generic but still actionable
    expect(friendlyAuthError("Invalid API key")).toMatch(/configured/i);
  });

  it("passes real, user-fixable errors through unchanged", () => {
    for (const msg of [
      "Invalid login credentials",
      "Email not confirmed",
      "For security purposes, you can only request this after 60 seconds.",
    ]) {
      expect(friendlyAuthError(msg, "google")).toBe(msg);
    }
  });

  it("is case-insensitive on the config patterns", () => {
    expect(friendlyAuthError("PROVIDER IS NOT ENABLED", "google")).toBe(
      GOOGLE_NOT_ENABLED_MESSAGE
    );
  });
});
