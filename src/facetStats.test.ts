import { describe, expect, it } from "vitest";
import type { CaseRecord, SubsetDefinition } from "./types";
import {
  categoricalFacetStats,
  dateFacetDistribution,
  facetBaseCases,
  numericFacetDistribution,
  subsetWithoutFacet,
  visibleBuilderAttributes
} from "./facetStats";

const cases: CaseRecord[] = [
  {
    caseId: "C1",
    attributes: { market: "Belgium", salesChannel: "Agency", transportationTimeDays: 12, purchaseOrderDate: "2025-01-01" },
    caseStart: "2025-01-01T00:00:00",
    caseEnd: "2025-01-03T00:00:00",
    caseDurationHours: 48,
    events: [{ activity: "A", timestamp: "2025-01-01T00:00:00" }]
  },
  {
    caseId: "C2",
    attributes: { market: "Belgium", salesChannel: "Direct Sales", transportationTimeDays: 24, purchaseOrderDate: "2025-02-01" },
    caseStart: "2025-02-01T00:00:00",
    caseEnd: "2025-02-03T00:00:00",
    caseDurationHours: 48,
    events: [{ activity: "A", timestamp: "2025-02-01T00:00:00" }]
  },
  {
    caseId: "C3",
    attributes: { market: "France", salesChannel: "Agency", transportationTimeDays: 36, purchaseOrderDate: "2025-03-01" },
    caseStart: "2025-03-01T00:00:00",
    caseEnd: "2025-03-03T00:00:00",
    caseDurationHours: 48,
    events: [{ activity: "B", timestamp: "2025-03-01T00:00:00" }]
  }
];

const subset: SubsetDefinition = {
  id: "S",
  name: "Subset",
  description: "",
  color: "#3f6fa6",
  requiredActivities: [],
  excludedActivities: [],
  reworkActivities: [],
  attributeFilters: [
    { field: "market", operator: "in", values: ["Belgium"] },
    { field: "salesChannel", operator: "in", values: ["Agency"] }
  ]
};

describe("facet stats", () => {
  it("removes only the requested attribute facet", () => {
    const withoutMarket = subsetWithoutFacet(subset, { kind: "attribute", field: "market" });
    expect(withoutMarket.attributeFilters.map((filter) => filter.field)).toEqual(["salesChannel"]);
  });

  it("computes linked counts from the current subset without the active facet", () => {
    const baseCases = facetBaseCases(cases, subset, { kind: "attribute", field: "market" });
    const stats = categoricalFacetStats(baseCases, "market", ["Belgium", "France"]);
    expect(baseCases.map((caseRecord) => caseRecord.caseId)).toEqual(["C1", "C3"]);
    expect(stats).toEqual([
      { value: "Belgium", count: 1, share: 0.5 },
      { value: "France", count: 1, share: 0.5 }
    ]);
  });

  it("builds numeric and date distributions", () => {
    expect(numericFacetDistribution(cases, "transportationTimeDays")?.count).toBe(3);
    expect(dateFacetDistribution(cases, "purchaseOrderDate")?.count).toBe(3);
    expect(dateFacetDistribution(cases, "caseStart")?.count).toBe(3);
  });

  it("keeps builder attributes within the default canvas fields", () => {
    expect(visibleBuilderAttributes(["market", "dateOfCustomerDelivery"], ["salesChannel", "market"])).toEqual(["market"]);
    expect(visibleBuilderAttributes(["dateOfCustomerDelivery"], ["salesChannel", "market"])).toEqual(["salesChannel", "market"]);
  });
});
