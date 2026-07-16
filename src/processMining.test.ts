import { describe, expect, it } from "vitest";
import type { CaseRecord, SubsetDefinition } from "./types";
import { computeDfg, filterCases, mergeDfgs } from "./processMining";

const cases: CaseRecord[] = [
  {
    caseId: "C1",
    attributes: { priority: 1, assetType: "application", transportationTimeDays: 2, advanceNoticeTimeDays: 10, purchaseOrderDate: "2024-01-01" },
    caseStart: "2024-01-01T00:00:00",
    caseEnd: "2024-01-01T04:00:00",
    caseDurationHours: 4,
    events: [
      { activity: "Open", timestamp: "2024-01-01T00:00:00" },
      { activity: "Assignment", timestamp: "2024-01-01T01:00:00" },
      { activity: "Closed", timestamp: "2024-01-01T04:00:00" }
    ]
  },
  {
    caseId: "C2",
    attributes: { priority: 4, assetType: "hardware", transportationTimeDays: null, advanceNoticeTimeDays: 20, purchaseOrderDate: "2024-02-01" },
    caseStart: "2024-01-02T00:00:00",
    caseEnd: "2024-01-02T05:00:00",
    caseDurationHours: 5,
    events: [
      { activity: "Open", timestamp: "2024-01-02T00:00:00" },
      { activity: "Assignment", timestamp: "2024-01-02T01:00:00" },
      { activity: "Assignment", timestamp: "2024-01-02T02:00:00" },
      { activity: "Closed", timestamp: "2024-01-02T05:00:00" }
    ]
  }
];

const baseSubset: SubsetDefinition = {
  id: "S",
  name: "Subset",
  description: "",
  color: "#ef4444",
  requiredActivities: [],
  excludedActivities: [],
  reworkActivities: [],
  attributeFilters: []
};

describe("process mining helpers", () => {
  it("filters cases with required, excluded and rework activities", () => {
    expect(filterCases(cases, { ...baseSubset, requiredActivities: ["Assignment"] })).toHaveLength(2);
    expect(filterCases(cases, { ...baseSubset, excludedActivities: ["Closed"] })).toHaveLength(0);
    expect(filterCases(cases, { ...baseSubset, reworkActivities: ["Assignment"] }).map((item) => item.caseId)).toEqual(["C2"]);
  });

  it("filters by case attributes", () => {
    const matched = filterCases(cases, {
      ...baseSubset,
      attributeFilters: [{ field: "priority", operator: "range", min: 1, max: 2 }]
    });
    expect(matched.map((item) => item.caseId)).toEqual(["C1"]);
  });

  it("supports negated case attribute filters while excluding blank values", () => {
    const matched = filterCases(cases, {
      ...baseSubset,
      attributeFilters: [{ field: "priority", operator: "range", min: 1, max: 2, negated: true }]
    });
    expect(matched.map((item) => item.caseId)).toEqual(["C2"]);
  });

  it("filters by case date attributes", () => {
    const matched = filterCases(cases, {
      ...baseSubset,
      attributeFilters: [{ field: "purchaseOrderDate", operator: "range", min: "2024-01-15", max: "2024-02-15" }]
    });
    expect(matched.map((item) => item.caseId)).toEqual(["C2"]);
  });

  it("filters start and end date ranges by first and last event timestamps", () => {
    const matched = filterCases(cases, {
      ...baseSubset,
      timeWindow: {
        startFrom: "2024-01-01T00:00:00",
        startTo: "2024-01-01T23:59:59",
        endFrom: "2024-01-01T00:00:00",
        endTo: "2024-01-02T04:30:00"
      }
    });
    expect(matched.map((item) => item.caseId)).toEqual(["C1"]);
  });

  it("includes cases exactly on start and end date boundaries", () => {
    const matched = filterCases(cases, {
      ...baseSubset,
      timeWindow: {
        startFrom: "2024-01-01T00:00:00",
        startTo: "2024-01-01T00:00:00",
        endFrom: "2024-01-01T04:00:00",
        endTo: "2024-01-01T04:00:00"
      }
    });
    expect(matched.map((item) => item.caseId)).toEqual(["C1"]);
  });

  it("supports negated start date ranges", () => {
    const matched = filterCases(cases, {
      ...baseSubset,
      timeWindow: {
        startFrom: "2024-01-01T00:00:00",
        startTo: "2024-01-01T23:59:59",
        invertStartRange: true
      }
    });
    expect(matched.map((item) => item.caseId)).toEqual(["C2"]);
  });

  it("computes edge frequency and waiting time", () => {
    const dfg = computeDfg(baseSubset, cases);
    const edge = dfg.edges.find((item) => item.id === "Open__Assignment");
    expect(edge?.metrics.count).toBe(2);
    expect(edge?.metrics.caseShare).toBe(1);
    expect(edge?.metrics.avgWaitingHours).toBe(1);
    expect(edge?.metrics.sumWaitingHours).toBe(2);
  });

  it("adds subset-aware Start and End boundaries", () => {
    const dfg = computeDfg(baseSubset, cases);
    const startNode = dfg.nodes.find((item) => item.activity === "Start");
    const endNode = dfg.nodes.find((item) => item.activity === "End");
    const startEdge = dfg.edges.find((item) => item.id === "Start__Open");
    const endEdge = dfg.edges.find((item) => item.id === "Closed__End");

    expect(startNode?.metrics.caseShare).toBe(1);
    expect(endNode?.metrics.caseShare).toBe(1);
    expect(startEdge?.metrics.count).toBe(2);
    expect(startEdge?.metrics.sumWaitingHours).toBe(0);
    expect(endEdge?.metrics.count).toBe(2);
    expect(endEdge?.metrics.sumWaitingHours).toBe(0);
  });

  it("aggregates logistics KPI averages while ignoring blanks", () => {
    const dfg = computeDfg(baseSubset, cases);
    expect(dfg.metrics.avgTransportationTimeDays).toBe(2);
    expect(dfg.metrics.avgAdvanceNoticeTimeDays).toBe(15);
  });

  it("merges DFG metrics by subset", () => {
    const dfgA = computeDfg({ ...baseSubset, id: "A" }, [cases[0]]);
    const dfgB = computeDfg({ ...baseSubset, id: "B" }, [cases[1]]);
    const shared = mergeDfgs([dfgA, dfgB]);
    const edge = shared.edges.find((item) => item.id === "Assignment__Closed");
    const matchingEdges = shared.edges.filter((item) => item.id === "Assignment__Closed");
    expect(matchingEdges).toHaveLength(1);
    expect(edge?.metricsBySubset.A.count).toBe(1);
    expect(edge?.metricsBySubset.B.count).toBe(1);
  });
});
