import { describe, expect, it } from "vitest";
import { defaultSelectedSubsetIds, defaultSubsets } from "./logisticsConfig";
import { initialPageFromQuery, parseQuerySubsetPayload, parseStoredSubsets, queryChoice, queryNumber, querySelectedSubsetIds } from "./subsetStorage";

describe("subset storage and snapshot parsing", () => {
  it("falls back to built-in presets for malformed stored subset payloads", () => {
    expect(parseStoredSubsets("not json").map((subset) => subset.id)).toEqual(defaultSubsets().map((subset) => subset.id));
    expect(parseStoredSubsets(JSON.stringify([{ name: "Missing id" }])).map((subset) => subset.id)).toEqual(defaultSubsets().map((subset) => subset.id));
  });

  it("sanitizes shared subset snapshot payloads", () => {
    const payload = encodeURIComponent(
      JSON.stringify([
        {
          id: "snapshot-a",
          name: "Snapshot A",
          color: "#123456",
          attributeFilters: [
            { field: "market", operator: "in", values: ["Belgium"], extra: "ignored" },
            { field: "caseDurationHours", operator: "range", min: 1, max: 24, negated: true }
          ],
          requiredActivities: ["Deliver"],
          timeWindow: { startFrom: "2025-01-01T00:00:00", extra: "ignored" }
        }
      ])
    );

    const subsets = parseQuerySubsetPayload(`?subsetPayload=${payload}`);

    expect(subsets).toHaveLength(1);
    expect(subsets[0]).toMatchObject({
      id: "snapshot-a",
      name: "Snapshot A",
      requiredActivities: ["Deliver"],
      attributeFilters: [
        { field: "market", operator: "in", values: ["Belgium"], negated: false },
        { field: "caseDurationHours", operator: "range", min: 1, max: 24, negated: true }
      ],
      timeWindow: { startFrom: "2025-01-01T00:00:00" }
    });
  });

  it("parses query controls with bounded defaults", () => {
    expect(querySelectedSubsetIds("?selected=a,b")).toEqual(["a", "b"]);
    expect(querySelectedSubsetIds("?selected=")).toEqual(defaultSelectedSubsetIds);
    expect(queryChoice("scope", ["all", "common"] as const, "all", "?scope=common")).toBe("common");
    expect(queryChoice("scope", ["all", "common"] as const, "all", "?scope=bad")).toBe("all");
    expect(queryNumber("limit", 10, 1, 20, "?limit=99")).toBe(20);
    expect(queryNumber("limit", 10, 1, 20, "?limit=bad")).toBe(10);
  });

  it("opens the Shared DFG by default while preserving explicit page links", () => {
    expect(initialPageFromQuery("")).toBe("analysis");
    expect(initialPageFromQuery("?page=shared-dfg")).toBe("analysis");
    expect(initialPageFromQuery("?page=analysis")).toBe("analysis");
    expect(initialPageFromQuery("?page=builder")).toBe("builder");
    expect(initialPageFromQuery("?page=configuration")).toBe("configuration");
    expect(initialPageFromQuery("?page=unknown")).toBe("analysis");
  });

  it("keeps default selected subset ids aligned with built-in presets", () => {
    const presetIds = new Set(defaultSubsets().map((subset) => subset.id));
    expect(defaultSelectedSubsetIds.every((id) => presetIds.has(id))).toBe(true);
  });
});
