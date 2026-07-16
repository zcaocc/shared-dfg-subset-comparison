import { describe, expect, it } from "vitest";
import type { DfgEdgeMetrics, DfgNodeMetrics, SharedDfg } from "./types";
import { deriveDefaultVisibleLimits, deriveSharedDfgView } from "./sharedDfgView";

function nodeMetrics(caseShare: number): DfgNodeMetrics {
  return {
    avgPosition: 0.5,
    caseCount: Math.round(caseShare * 100),
    caseShare,
    eventCount: Math.round(caseShare * 120),
    frequencyShare: caseShare / 3
  };
}

function edgeMetrics(caseShare: number): DfgEdgeMetrics {
  return {
    avgWaitingHours: 1,
    caseCount: Math.round(caseShare * 100),
    caseShare,
    count: Math.round(caseShare * 120),
    frequencyShare: caseShare / 4,
    medianWaitingHours: 1,
    sumWaitingHours: Math.round(caseShare * 120)
  };
}

function presentZeroNodeMetrics(): DfgNodeMetrics {
  return {
    avgPosition: 0.5,
    caseCount: 0,
    caseShare: 0,
    eventCount: 1,
    frequencyShare: 0
  };
}

function presentZeroEdgeMetrics(): DfgEdgeMetrics {
  return {
    avgWaitingHours: 1,
    caseCount: 0,
    caseShare: 0,
    count: 1,
    frequencyShare: 0,
    medianWaitingHours: 1,
    sumWaitingHours: 1
  };
}

const sharedDfg: SharedDfg = {
  nodes: [
    { activity: "A", metricsBySubset: { a: nodeMetrics(0.9), b: nodeMetrics(0.4), c: nodeMetrics(0.4) } },
    { activity: "B", metricsBySubset: { a: nodeMetrics(0.7) } },
    { activity: "C", metricsBySubset: { a: nodeMetrics(0.2), b: nodeMetrics(0.8) } },
    { activity: "D", metricsBySubset: { a: nodeMetrics(0.3), b: nodeMetrics(0.3), c: nodeMetrics(0.3) } }
  ],
  edges: [
    { id: "A__B", source: "A", target: "B", metricsBySubset: { a: edgeMetrics(0.85) } },
    { id: "A__C", source: "A", target: "C", metricsBySubset: { a: edgeMetrics(0.2), b: edgeMetrics(0.75) } },
    { id: "A__D", source: "A", target: "D", metricsBySubset: { a: edgeMetrics(0.35), b: edgeMetrics(0.35), c: edgeMetrics(0.35) } },
    { id: "C__D", source: "C", target: "D", metricsBySubset: { c: edgeMetrics(0.6) } }
  ]
};

describe("Shared DFG view derivation", () => {
  it("ranks activities and paths by max case coverage across selected subsets", () => {
    const view = deriveSharedDfgView({
      activityCaseShareThreshold: 0,
      activityScope: "all",
      dfg: sharedDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      maxVisibleActivities: 4,
      maxVisiblePaths: 4,
      pathCaseShareThreshold: 0,
      pathMode: "all",
      selectedIds: ["a", "b", "c"]
    });

    expect(view.scopedNodes.map((node) => node.activity)).toEqual(["A", "C", "B", "D"]);
    expect(view.candidateEdges.map((edge) => edge.id)).toEqual(["A__D", "A__B", "A__C", "C__D"]);
  });

  it("keeps one logical path and only draws subsets where that path exists", () => {
    const view = deriveSharedDfgView({
      activityCaseShareThreshold: 0,
      activityScope: "all",
      dfg: sharedDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      maxVisibleActivities: 4,
      maxVisiblePaths: 2,
      pathCaseShareThreshold: 0,
      pathMode: "all",
      selectedIds: ["a", "b", "c"]
    });

    expect(view.visibleEdges.map((edge) => edge.id)).toEqual(["A__D", "A__B"]);
    expect([...view.visiblePairKeys].sort()).toEqual(["A__B-a", "A__D-a", "A__D-b", "A__D-c"]);
  });

  it("hides an entire shared logical path across all subset strokes", () => {
    const view = deriveSharedDfgView({
      activityCaseShareThreshold: 0,
      activityScope: "all",
      dfg: sharedDfg,
      hiddenActivities: [],
      hiddenPaths: ["A__C"],
      maxVisibleActivities: 4,
      maxVisiblePaths: 4,
      pathCaseShareThreshold: 0,
      pathMode: "all",
      selectedIds: ["a", "b", "c"]
    });

    expect(view.candidateEdges.map((edge) => edge.id)).not.toContain("A__C");
    expect([...view.visiblePairKeys].some((key) => key.startsWith("A__C-"))).toBe(false);
  });

  it("keeps a shared logical path when any selected subset reaches the path threshold", () => {
    const view = deriveSharedDfgView({
      activityCaseShareThreshold: 0,
      activityScope: "all",
      dfg: sharedDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      maxVisibleActivities: 4,
      maxVisiblePaths: 4,
      pathCaseShareThreshold: 0.5,
      pathMode: "all",
      selectedIds: ["a", "b", "c"]
    });

    expect(view.candidateEdges.map((edge) => edge.id)).toEqual(["A__B", "A__C", "C__D"]);
    expect(view.candidateEdges.map((edge) => edge.id)).not.toContain("A__D");
  });

  it("treats shared paths as paths present in every selected subset", () => {
    const view = deriveSharedDfgView({
      activityCaseShareThreshold: 0,
      activityScope: "all",
      dfg: sharedDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      maxVisibleActivities: 4,
      maxVisiblePaths: 4,
      pathCaseShareThreshold: 0,
      pathMode: "shared",
      selectedIds: ["a", "b", "c"]
    });

    expect(view.visibleEdges.map((edge) => edge.id)).toEqual(["A__D"]);
  });

  it("uses subset-specific paths when activity scope is subset-specific", () => {
    const view = deriveSharedDfgView({
      activityCaseShareThreshold: 0,
      activityScope: "specific",
      dfg: sharedDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      maxVisibleActivities: 4,
      maxVisiblePaths: 4,
      pathCaseShareThreshold: 0,
      pathMode: "shared",
      selectedIds: ["a", "b", "c"]
    });

    expect(view.effectivePathMode).toBe("specific");
    expect(view.scopedNodes.map((node) => node.activity)).toEqual(["B"]);
  });

  it("keeps Start and End boundary paths visible without counting them against the path limit", () => {
    const boundaryDfg: SharedDfg = {
      nodes: [
        { activity: "Start", metricsBySubset: { a: nodeMetrics(1), b: nodeMetrics(1) } },
        { activity: "A", metricsBySubset: { a: nodeMetrics(1), b: nodeMetrics(1) } },
        { activity: "B", metricsBySubset: { a: nodeMetrics(0.8), b: nodeMetrics(0.8) } },
        { activity: "End", metricsBySubset: { a: nodeMetrics(1), b: nodeMetrics(1) } }
      ],
      edges: [
        { id: "Start__A", source: "Start", target: "A", metricsBySubset: { a: edgeMetrics(1), b: edgeMetrics(1) } },
        { id: "A__B", source: "A", target: "B", metricsBySubset: { a: edgeMetrics(0.8), b: edgeMetrics(0.8) } },
        { id: "B__End", source: "B", target: "End", metricsBySubset: { a: edgeMetrics(0.8), b: edgeMetrics(0.8) } }
      ]
    };

    const view = deriveSharedDfgView({
      activityCaseShareThreshold: 0,
      activityScope: "all",
      dfg: boundaryDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      maxVisibleActivities: 2,
      maxVisiblePaths: 0,
      pathCaseShareThreshold: 0,
      pathMode: "all",
      selectedIds: ["a", "b"]
    });

    expect(view.candidateEdges.map((edge) => edge.id)).toEqual(["A__B"]);
    expect(view.visibleEdges.map((edge) => edge.id)).toEqual(["Start__A", "B__End"]);
    expect(view.displayNodes.map((node) => node.activity).sort()).toEqual(["A", "B", "End", "Start"]);
  });

  it("derives all-scope defaults from per-activity max case coverage", () => {
    const defaultLimits = deriveDefaultVisibleLimits({
      activityCaseShareThreshold: 0,
      activityScope: "all",
      dfg: sharedDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      pathCaseShareThreshold: 0,
      pathMode: "all",
      selectedIds: ["a", "b", "c"]
    });

    expect(defaultLimits.activityLimit).toBe(2);
    expect(defaultLimits.pathLimit).toBeGreaterThanOrEqual(1);
    expect(defaultLimits.stats.activityRule).toBe("all-coverage");
    expect(defaultLimits.stats.activityCoverage).toBeCloseTo(1.7);
  });

  it("fills all-scope defaults to at least one quarter of scoped activities", () => {
    const lowCoverageDfg: SharedDfg = {
      nodes: [
        { activity: "A", metricsBySubset: { a: nodeMetrics(0.69) } },
        { activity: "B", metricsBySubset: { a: nodeMetrics(0.68) } },
        { activity: "C", metricsBySubset: { a: nodeMetrics(0.67) } },
        { activity: "D", metricsBySubset: { a: nodeMetrics(0.66) } },
        { activity: "E", metricsBySubset: { a: nodeMetrics(0.65) } },
        { activity: "F", metricsBySubset: { a: nodeMetrics(0.64) } },
        { activity: "G", metricsBySubset: { a: nodeMetrics(0.63) } },
        { activity: "H", metricsBySubset: { a: nodeMetrics(0.62) } }
      ],
      edges: [
        { id: "A__B", source: "A", target: "B", metricsBySubset: { a: edgeMetrics(0.8) } }
      ]
    };

    const defaultLimits = deriveDefaultVisibleLimits({
      activityCaseShareThreshold: 0,
      activityScope: "all",
      dfg: lowCoverageDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      pathCaseShareThreshold: 0,
      pathMode: "all",
      selectedIds: ["a"]
    });

    expect(defaultLimits.activityLimit).toBe(2);
  });

  it("limits common-scope defaults to common activities above fifty percent case coverage", () => {
    const defaultLimits = deriveDefaultVisibleLimits({
      activityCaseShareThreshold: 0,
      activityScope: "common",
      dfg: sharedDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      pathCaseShareThreshold: 0,
      pathMode: "all",
      selectedIds: ["a", "b", "c"]
    });

    expect(defaultLimits.activityLimit).toBe(1);
    expect(defaultLimits.stats.activityRule).toBe("common-threshold");
  });

  it("does not cap all-scope activity defaults when many activities exceed the display coverage", () => {
    const manyHighCoverageDfg: SharedDfg = {
      nodes: Array.from({ length: 20 }, (_, index) => ({
        activity: `A${index + 1}`,
        metricsBySubset: { a: nodeMetrics(0.8 - index * 0.001) }
      })),
      edges: []
    };

    const defaultLimits = deriveDefaultVisibleLimits({
      activityCaseShareThreshold: 0.05,
      activityScope: "all",
      dfg: manyHighCoverageDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      pathCaseShareThreshold: 0.02,
      pathMode: "all",
      selectedIds: ["a"]
    });

    expect(defaultLimits.activityLimit).toBe(20);
  });

  it("uses a larger activity context for subset-specific path defaults", () => {
    const specificDfg: SharedDfg = {
      nodes: Array.from({ length: 10 }, (_, index) => ({
        activity: `A${index + 1}`,
        metricsBySubset: { a: nodeMetrics(0.95 - index * 0.04), b: nodeMetrics(0.7 - index * 0.02) }
      })),
      edges: Array.from({ length: 9 }, (_, index) => {
        const subsetId = index % 2 === 0 ? "a" : "b";
        return {
          id: `A${index + 1}__A${index + 2}`,
          source: `A${index + 1}`,
          target: `A${index + 2}`,
          metricsBySubset: { [subsetId]: edgeMetrics(index % 2 === 0 ? 0.3 : 0.28) }
        };
      })
    };

    const defaultLimits = deriveDefaultVisibleLimits({
      activityCaseShareThreshold: 0,
      activityScope: "all",
      dfg: specificDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      pathCaseShareThreshold: 0,
      pathMode: "specific",
      selectedIds: ["a", "b"]
    });

    expect(defaultLimits.activityLimit).toBeGreaterThanOrEqual(6);
    expect(defaultLimits.stats.activityRule).toBe("all-coverage");
  });

  it("keeps high-share subset-specific defaults and forces specific path density", () => {
    const defaultLimits = deriveDefaultVisibleLimits({
      activityCaseShareThreshold: 0,
      activityScope: "specific",
      dfg: sharedDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      pathCaseShareThreshold: 0,
      pathMode: "shared",
      selectedIds: ["a", "b", "c"]
    });

    expect(defaultLimits.activityLimit).toBe(1);
    expect(defaultLimits.stats.activityRule).toBe("specific-threshold");
    expect(defaultLimits.stats.pathRule).toBe("empty");
  });

  it("shows all qualifying subset-specific activities and connections by default", () => {
    const specificDfg: SharedDfg = {
      nodes: [
        { activity: "A", metricsBySubset: { a: nodeMetrics(0.2) } },
        { activity: "B", metricsBySubset: { a: nodeMetrics(0.15) } },
        { activity: "C", metricsBySubset: { b: nodeMetrics(0.1) } }
      ],
      edges: [
        { id: "A__B", source: "A", target: "B", metricsBySubset: { a: edgeMetrics(0.02) } },
        { id: "B__C", source: "B", target: "C", metricsBySubset: { b: edgeMetrics(0.01) } }
      ]
    };

    const defaultLimits = deriveDefaultVisibleLimits({
      activityCaseShareThreshold: 0.01,
      activityScope: "specific",
      dfg: specificDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      pathCaseShareThreshold: 0,
      pathMode: "all",
      selectedIds: ["a", "b"]
    });

    expect(defaultLimits.activityLimit).toBe(3);
    expect(defaultLimits.pathLimit).toBe(2);
    expect(defaultLimits.stats.pathRule).toBe("specific-paths");
  });

  it("uses strict greater-than thresholds so zero-coverage items are excluded", () => {
    const zeroCoverageDfg: SharedDfg = {
      nodes: [
        { activity: "A", metricsBySubset: { a: nodeMetrics(0.1) } },
        { activity: "Zero", metricsBySubset: { a: presentZeroNodeMetrics() } }
      ],
      edges: [
        { id: "A__Zero", source: "A", target: "Zero", metricsBySubset: { a: presentZeroEdgeMetrics() } }
      ]
    };

    const view = deriveSharedDfgView({
      activityCaseShareThreshold: 0,
      activityScope: "all",
      dfg: zeroCoverageDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      maxVisibleActivities: 2,
      maxVisiblePaths: 1,
      pathCaseShareThreshold: 0,
      pathMode: "all",
      selectedIds: ["a"]
    });

    expect(view.scopedNodes.map((node) => node.activity)).toEqual(["A"]);
    expect(view.scopedEdges).toEqual([]);
  });

  it("raises path defaults enough to include each visible activity's strongest incident path", () => {
    const connectedDfg: SharedDfg = {
      nodes: [
        { activity: "A", metricsBySubset: { a: nodeMetrics(0.8), b: nodeMetrics(0.8) } },
        { activity: "B", metricsBySubset: { a: nodeMetrics(0.7), b: nodeMetrics(0.7) } },
        { activity: "C", metricsBySubset: { a: nodeMetrics(0.6), b: nodeMetrics(0.6) } }
      ],
      edges: [
        { id: "A__B", source: "A", target: "B", metricsBySubset: { a: edgeMetrics(0.7), b: edgeMetrics(0.7) } },
        { id: "B__C", source: "B", target: "C", metricsBySubset: { a: edgeMetrics(0.25), b: edgeMetrics(0.25) } }
      ]
    };

    const defaultLimits = deriveDefaultVisibleLimits({
      activityCaseShareThreshold: 0,
      activityLimitOverride: 3,
      activityScope: "all",
      dfg: connectedDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      pathCaseShareThreshold: 0,
      pathMode: "all",
      selectedIds: ["a", "b"]
    });

    expect(defaultLimits.pathLimit).toBe(2);
    expect(defaultLimits.stats.connectedActivityCount).toBe(3);
  });

  it("keeps default connection count at least as high as the default activity count when candidates allow it", () => {
    const denseDfg: SharedDfg = {
      nodes: [
        { activity: "A", metricsBySubset: { a: nodeMetrics(0.9), b: nodeMetrics(0.9) } },
        { activity: "B", metricsBySubset: { a: nodeMetrics(0.85), b: nodeMetrics(0.85) } },
        { activity: "C", metricsBySubset: { a: nodeMetrics(0.8), b: nodeMetrics(0.8) } },
        { activity: "D", metricsBySubset: { a: nodeMetrics(0.75), b: nodeMetrics(0.75) } }
      ],
      edges: [
        { id: "A__B", source: "A", target: "B", metricsBySubset: { a: edgeMetrics(0.8), b: edgeMetrics(0.8) } },
        { id: "B__C", source: "B", target: "C", metricsBySubset: { a: edgeMetrics(0.2), b: edgeMetrics(0.2) } },
        { id: "C__D", source: "C", target: "D", metricsBySubset: { a: edgeMetrics(0.18), b: edgeMetrics(0.18) } },
        { id: "A__C", source: "A", target: "C", metricsBySubset: { a: edgeMetrics(0.16), b: edgeMetrics(0.16) } },
        { id: "B__D", source: "B", target: "D", metricsBySubset: { a: edgeMetrics(0.14), b: edgeMetrics(0.14) } }
      ]
    };

    const defaultLimits = deriveDefaultVisibleLimits({
      activityCaseShareThreshold: 0,
      activityScope: "all",
      dfg: denseDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      pathCaseShareThreshold: 0,
      pathMode: "all",
      selectedIds: ["a", "b"]
    });

    expect(defaultLimits.activityLimit).toBe(4);
    expect(defaultLimits.pathLimit).toBeGreaterThanOrEqual(defaultLimits.activityLimit);
    expect(defaultLimits.pathLimit).toBe(4);
  });

  it("uses lower default connection display thresholds for all and common scopes", () => {
    const connectionThresholdDfg: SharedDfg = {
      nodes: [
        { activity: "A", metricsBySubset: { a: nodeMetrics(0.9), b: nodeMetrics(0.9) } },
        { activity: "B", metricsBySubset: { a: nodeMetrics(0.8), b: nodeMetrics(0.8) } },
        { activity: "C", metricsBySubset: { a: nodeMetrics(0.75), b: nodeMetrics(0.75) } },
        { activity: "D", metricsBySubset: { a: nodeMetrics(0.72), b: nodeMetrics(0.72) } }
      ],
      edges: [
        { id: "A__B", source: "A", target: "B", metricsBySubset: { a: edgeMetrics(0.9), b: edgeMetrics(0.9) } },
        { id: "B__C", source: "B", target: "C", metricsBySubset: { a: edgeMetrics(0.55), b: edgeMetrics(0.55) } },
        { id: "C__D", source: "C", target: "D", metricsBySubset: { a: edgeMetrics(0.45), b: edgeMetrics(0.45) } }
      ]
    };

    const allLimits = deriveDefaultVisibleLimits({
      activityCaseShareThreshold: 0,
      activityScope: "all",
      dfg: connectionThresholdDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      pathCaseShareThreshold: 0,
      pathMode: "all",
      selectedIds: ["a", "b"]
    });
    const commonLimits = deriveDefaultVisibleLimits({
      activityCaseShareThreshold: 0,
      activityScope: "common",
      dfg: connectionThresholdDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      pathCaseShareThreshold: 0,
      pathMode: "all",
      selectedIds: ["a", "b"]
    });

    expect(allLimits.stats.pathCoverage).toBeCloseTo(2 / 3);
    expect(commonLimits.stats.pathCoverage).toBeCloseTo(1);
  });
});
