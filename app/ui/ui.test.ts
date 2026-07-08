import { describe, it, expect } from "vitest";
import { statusIntent } from "./status-badge";
import { confidenceTone, AUTO_POST_THRESHOLD } from "./confidence-meter";
import { GUARDRAIL_DEFAULTS } from "@/lib/guardrails";

describe("statusIntent", () => {
  it("maps every app lifecycle status to a semantic intent", () => {
    expect(statusIntent("review")).toBe("warn");
    expect(statusIntent("listed")).toBe("info");
    expect(statusIntent("live")).toBe("info");
    expect(statusIntent("sold")).toBe("ok");
    expect(statusIntent("end_failed")).toBe("danger");
    expect(statusIntent("oversold")).toBe("danger");
    expect(statusIntent("draft")).toBe("muted");
  });

  it("falls back to muted for unknown statuses instead of crashing", () => {
    expect(statusIntent("something_new")).toBe("muted");
  });
});

describe("confidenceTone", () => {
  it("mirrors the guardrail auto-post threshold exactly", () => {
    // The meter's marked bar and the server gate must never drift apart.
    expect(AUTO_POST_THRESHOLD).toBe(GUARDRAIL_DEFAULTS.minConfidence);
  });

  it("tones: ok at/above 0.80, warn 0.60–0.79, danger below", () => {
    expect(confidenceTone(0.8)).toBe("ok");
    expect(confidenceTone(0.95)).toBe("ok");
    expect(confidenceTone(0.79)).toBe("warn");
    expect(confidenceTone(0.6)).toBe("warn");
    expect(confidenceTone(0.59)).toBe("danger");
  });
});
