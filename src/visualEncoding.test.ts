import { describe, expect, it } from "vitest";
import { opacityFromNormalizedValue } from "./visualEncoding";

describe("visual encodings", () => {
  it("keeps incidental paths at the minimum opacity", () => {
    expect(opacityFromNormalizedValue(0)).toBe(0.1);
    expect(opacityFromNormalizedValue(0.019)).toBe(0.1);
  });

  it("maps two to seventy-two percent into the readable opacity range", () => {
    expect(opacityFromNormalizedValue(0.02)).toBeCloseTo(0.2);
    expect(opacityFromNormalizedValue(0.37)).toBeCloseTo(0.55);
    expect(opacityFromNormalizedValue(0.72)).toBeCloseTo(0.9);
  });

  it("caps high-value paths at ninety percent opacity", () => {
    expect(opacityFromNormalizedValue(0.73)).toBe(0.9);
    expect(opacityFromNormalizedValue(1)).toBe(0.9);
  });
});
