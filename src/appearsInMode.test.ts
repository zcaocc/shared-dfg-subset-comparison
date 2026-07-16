import { describe, expect, it } from "vitest";
import { effectiveActivityScope, effectiveConnectionMode, nextManualConnectionMode } from "./appearsInMode";
import type { ActivityScope, PathMode } from "./sharedDfgView";

function applyActivityScope(activityScope: ActivityScope, manualConnectionMode: PathMode) {
  return effectiveConnectionMode(activityScope, manualConnectionMode);
}

describe("appears-in mode dependency", () => {
  it("keeps manual connection mode when activity changes between non-unique modes", () => {
    const manualConnectionMode: PathMode = "shared";

    expect(applyActivityScope("all", manualConnectionMode)).toBe("shared");
    expect(applyActivityScope("common", manualConnectionMode)).toBe("shared");
  });

  it("forces effective activity scope to shared when connections are shared by all", () => {
    expect(effectiveActivityScope("all", "shared")).toBe("common");
    expect(effectiveActivityScope("common", "shared")).toBe("common");
  });

  it("forces effective connection mode to unique without overwriting manual mode", () => {
    let manualConnectionMode: PathMode = "shared";

    expect(effectiveConnectionMode("specific", manualConnectionMode)).toBe("specific");
    expect(manualConnectionMode).toBe("shared");

    manualConnectionMode = nextManualConnectionMode("specific", manualConnectionMode, "specific");
    expect(manualConnectionMode).toBe("shared");
    expect(effectiveConnectionMode("all", manualConnectionMode)).toBe("shared");
  });

  it("restores the previous manual connection mode after leaving unique activities", () => {
    const allManual: PathMode = "all";
    expect(effectiveConnectionMode("specific", allManual)).toBe("specific");
    expect(effectiveConnectionMode("all", allManual)).toBe("all");

    const anyManual: PathMode = "all";
    expect(effectiveConnectionMode("specific", anyManual)).toBe("specific");
    expect(effectiveConnectionMode("common", anyManual)).toBe("all");
  });

  it("lets unique activity scope win over an impossible shared-connection conflict", () => {
    expect(effectiveActivityScope("specific", "shared")).toBe("specific");
    expect(effectiveConnectionMode("specific", "shared")).toBe("specific");
  });

  it("releases forced activity scope when connections leave shared mode", () => {
    expect(effectiveActivityScope("all", "shared")).toBe("common");
    expect(effectiveActivityScope("all", "all")).toBe("all");
    expect(effectiveActivityScope("all", "specific")).toBe("all");
  });
});
