import { describe, expect, it } from "vitest";
import {
  anchorBoundaryPositions,
  centerStartPosition,
  compactBoundaryLinkSpacing,
  normalizeSameRankGroups,
  recenterGraphPositions,
  rebalanceHorizontalOutliers,
  resolveNodeOverlaps,
  runBrowserGraphvizLayout,
  toDot
} from "./graphvizLayout";

describe("browser Graphviz layout", () => {
  it("computes scaled node positions for a process graph", async () => {
    const result = await runBrowserGraphvizLayout(
      {
        nodes: ["Start", "Pick", "Pack", "End"],
        edges: [
          { source: "Start", target: "Pick", weight: 12 },
          { source: "Pick", target: "Pack", weight: 9 },
          { source: "Pack", target: "End", weight: 12 }
        ]
      },
      800,
      600
    );

    expect(result.engine).toBe("browser-graphviz-dot");
    expect(result.nodeCount).toBe(4);
    expect(Object.keys(result.positions).sort()).toEqual(["End", "Pack", "Pick", "Start"]);
    expect(result.positions.Start.y).toBeLessThan(result.positions.End.y);
  });

  it("keeps backward process edges from reversing the main top-down layout", async () => {
    const result = await runBrowserGraphvizLayout(
      {
        nodes: ["Start", "Pick", "Pack", "Review", "End"],
        edges: [
          { source: "Start", target: "Pick", weight: 12, constraint: true, minlen: 1 },
          { source: "Pick", target: "Pack", weight: 9, constraint: true, minlen: 1 },
          { source: "Pack", target: "Review", weight: 7, constraint: true, minlen: 1 },
          { source: "Review", target: "End", weight: 12, constraint: true, minlen: 1 },
          { source: "Review", target: "Pick", weight: 8, constraint: false }
        ]
      },
      900,
      700
    );

    expect(result.positions.Start.y).toBeLessThan(result.positions.Pick.y);
    expect(result.positions.Pick.y).toBeLessThan(result.positions.Pack.y);
    expect(result.positions.Pack.y).toBeLessThan(result.positions.Review.y);
    expect(result.positions.Review.y).toBeLessThan(result.positions.End.y);
  });

  it("places significant reciprocal pairs on the same horizontal rank", async () => {
    const result = await runBrowserGraphvizLayout(
      {
        nodes: ["Start", "Review", "Revise", "End"],
        sameRankGroups: [["Review", "Revise"]],
        edges: [
          { source: "Start", target: "Review", weight: 12, role: "main" },
          { source: "Review", target: "Revise", weight: 10, role: "reciprocal" },
          { source: "Revise", target: "Review", weight: 9, role: "reciprocal" },
          { source: "Review", target: "End", weight: 10, role: "main" },
          { source: "Revise", target: "End", weight: 8, role: "main" }
        ]
      },
      900,
      700
    );

    expect(result.positions.Start.y).toBeLessThan(result.positions.Review.y);
    expect(Math.abs(result.positions.Review.y - result.positions.Revise.y)).toBeLessThan(1);
    expect(result.positions.Revise.y).toBeLessThan(result.positions.End.y);
  });

  it("limits same-rank groups so reciprocal rows do not become too wide", () => {
    expect(
      normalizeSameRankGroups(
        [
          ["A", "B"],
          ["B", "C"],
          ["D", "E"],
          ["F", "G"],
          ["H", "I"]
        ],
        ["Start", "A", "B", "C", "D", "E", "F", "G", "H", "I", "End"]
      )
    ).toEqual([
      ["A", "B"],
      ["D", "E"],
      ["F", "G"]
    ]);
  });

  it("uses main-flow grouping only for main nodes and weak padding only for weak nodes", () => {
    const dot = toDot({
      nodes: ["Start", "A", "B", "Weak", "End"],
      nodeRoles: {
        A: "main",
        B: "side",
        Weak: "weak"
      },
      edges: [
        { source: "Start", target: "A", role: "main", weight: 12 },
        { source: "A", target: "B", role: "side", weight: 4 },
        { source: "Weak", target: "B", role: "side", weight: 2 },
        { source: "B", target: "End", role: "main", weight: 10 }
      ]
    });

    expect(dot).toContain(`"A" [width=1.55, group="main-flow"];`);
    expect(dot).toContain(`"B" [width=1.75];`);
    expect(dot).toContain(`"Weak" [width=2.25];`);
    expect(dot).not.toContain(`"Weak" [width=2.25, group="main-flow"];`);
  });

  it("uses narrower horizontal spacing for compact clear main-flow layouts", () => {
    const dot = toDot({
      compactMainFlow: true,
      nodes: ["Start", "A", "B", "Weak", "End"],
      nodeRoles: {
        A: "main",
        B: "main",
        Weak: "weak"
      },
      edges: [
        { source: "Start", target: "A", role: "main", weight: 12, minlen: 2 },
        { source: "A", target: "B", role: "main", weight: 12, minlen: 2 },
        { source: "B", target: "End", role: "main", weight: 12, minlen: 2 }
      ]
    });

    expect(dot).toContain("nodesep=0.62");
    expect(dot).toContain("ranksep=1.62");
    expect(dot).toContain(`"Weak" [width=1.85];`);
  });

  it("supports rank hints when specific views omit Start and End anchors", () => {
    const dot = toDot({
      nodes: ["A", "B", "C"],
      rankGuideEdges: [
        { source: "A", target: "B", weight: 14, minlen: 2 },
        { source: "B", target: "C", weight: 14, minlen: 2 }
      ],
      rankHints: [
        { rank: "min", nodes: ["A"] },
        { rank: "max", nodes: ["C"] }
      ],
      edges: [
        { source: "A", target: "B", role: "main", weight: 12, minlen: 2 },
        { source: "B", target: "C", role: "main", weight: 12, minlen: 2 }
      ]
    });

    expect(dot).toContain(`{ rank=min; "A"; }`);
    expect(dot).toContain(`{ rank=max; "C"; }`);
    expect(dot).toContain(`"A" -> "B" [style=invis, weight=14, minlen=2, constraint=true];`);
    expect(dot).toContain(`"A" -> "B" [weight=16, minlen=2, constraint=true];`);
  });

  it("does not recenter without explicit center nodes", () => {
    const positions = {
      A: { x: 180, y: 100 },
      B: { x: 260, y: 200 }
    };

    expect(recenterGraphPositions(positions, [], 1000, 120)).toBe(positions);
  });

  it("recenters explicit main corridor nodes while respecting horizontal margins", () => {
    const positions = {
      A: { x: 180, y: 100 },
      B: { x: 260, y: 200 },
      Side: { x: 360, y: 160 }
    };

    const centered = recenterGraphPositions(positions, ["A", "B"], 1000, 120);
    const originalCenterDistance = Math.abs((positions.A.x + positions.B.x) / 2 - 500);
    const centeredDistance = Math.abs((centered.A.x + centered.B.x) / 2 - 500);

    expect(centeredDistance).toBeLessThan(originalCenterDistance);
    expect(Math.min(...Object.values(centered).map((position) => position.x))).toBeGreaterThanOrEqual(120);
    expect(Math.max(...Object.values(centered).map((position) => position.x))).toBeLessThanOrEqual(880);
  });

  it("centers Start horizontally without changing vertical positions", () => {
    const positions = {
      Start: { x: 240, y: 95 },
      A: { x: 320, y: 180 },
      End: { x: 360, y: 300 }
    };

    const centered = centerStartPosition(positions, 1000, 120);

    expect(centered.Start.x).toBeCloseTo(500);
    expect(centered.Start.y).toBe(95);
    expect(centered.A.x - positions.A.x).toBeCloseTo(centered.Start.x - positions.Start.x);
    expect(centered.A.y).toBe(180);
    expect(centered.End.y).toBe(300);
  });

  it("keeps Start centering within horizontal margins", () => {
    const positions = {
      Start: { x: 140, y: 95 },
      A: { x: 700, y: 180 },
      End: { x: 860, y: 300 }
    };

    const centered = centerStartPosition(positions, 1000, 120);

    expect(centered.Start.x).toBeLessThan(500);
    expect(Math.min(...Object.values(centered).map((position) => position.x))).toBeGreaterThanOrEqual(120);
    expect(Math.max(...Object.values(centered).map((position) => position.x))).toBeLessThanOrEqual(880);
    expect(centered.Start.y).toBe(95);
  });

  it("anchors Start and End on the vertical center corridor without one global horizontal shift", () => {
    const positions = {
      Start: { x: 240, y: 95 },
      A: { x: 320, y: 180 },
      B: { x: 620, y: 260 },
      End: { x: 760, y: 420 }
    };

    const anchored = anchorBoundaryPositions(positions, 1000, 700, 120, 86);

    expect(anchored.Start.x).toBeCloseTo(500);
    expect(anchored.Start.y).toBe(95);
    expect(anchored.End.x).toBeCloseTo(500);
    expect(anchored.End.y).toBeGreaterThan(positions.End.y);
    expect(anchored.End.y).toBeLessThanOrEqual(700 - 86);
    expect(anchored.A.x - positions.A.x).not.toBeCloseTo(anchored.B.x - positions.B.x);
  });

  it("compacts direct Start and End boundary links without moving activity nodes", () => {
    const positions = {
      Start: { x: 500, y: 80 },
      A: { x: 500, y: 190 },
      B: { x: 520, y: 310 },
      End: { x: 500, y: 560 }
    };

    const compacted = compactBoundaryLinkSpacing(
      positions,
      {
        nodes: Object.keys(positions),
        edges: [
          { source: "Start", target: "A" },
          { source: "A", target: "B" },
          { source: "B", target: "End" }
        ]
      },
      1000,
      700,
      120,
      86
    );

    expect(compacted.Start.y).toBe(128);
    expect(compacted.End.y).toBe(372);
    expect(compacted.A).toEqual(positions.A);
    expect(compacted.B).toEqual(positions.B);
    expect(compacted.A.y - compacted.Start.y).toBe(62);
    expect(compacted.End.y - compacted.B.y).toBe(62);
  });

  it("leaves boundary nodes untouched when no direct boundary links are visible", () => {
    const positions = {
      Start: { x: 500, y: 80 },
      A: { x: 500, y: 190 },
      B: { x: 520, y: 310 },
      End: { x: 500, y: 560 }
    };

    expect(
      compactBoundaryLinkSpacing(
        positions,
        {
          nodes: Object.keys(positions),
          edges: [{ source: "A", target: "B" }]
        },
        1000,
        700,
        120,
        86
      )
    ).toBe(positions);
  });

  it("spreads nearby same-rank rectangular nodes horizontally", () => {
    const positions = {
      A: { x: 420, y: 240 },
      B: { x: 470, y: 252 },
      C: { x: 720, y: 430 }
    };

    const resolved = resolveNodeOverlaps(positions, 1000, 700, 120, 86);

    expect(Math.abs(resolved.B.x - resolved.A.x)).toBeGreaterThanOrEqual(170);
    expect(resolved.A.y).toBeCloseTo(positions.A.y);
    expect(resolved.B.y).toBeCloseTo(positions.B.y);
  });

  it("keeps compact boundary links closer than ordinary rectangular nodes", () => {
    const positions = {
      Start: { x: 500, y: 128 },
      A: { x: 500, y: 190 },
      B: { x: 520, y: 300 },
      End: { x: 520, y: 362 }
    };

    const resolved = resolveNodeOverlaps(positions, 1000, 700, 120, 86);

    expect(resolved.A.y - resolved.Start.y).toBeCloseTo(62);
    expect(resolved.End.y - resolved.B.y).toBeCloseTo(62);
    expect(resolved.A.x).toBeCloseTo(positions.A.x);
    expect(resolved.Start.x).toBeCloseTo(positions.Start.x);
  });

  it("pulls a far side activity closer to the main corridor without collapsing same-rank spacing", () => {
    const positions = {
      Start: { x: 500, y: 90 },
      A: { x: 470, y: 190 },
      B: { x: 500, y: 300 },
      Side: { x: 945, y: 300 },
      End: { x: 500, y: 620 }
    };

    const balanced = rebalanceHorizontalOutliers(
      positions,
      { centerNodes: ["Start", "A", "B", "End"], nodes: Object.keys(positions) },
      1000,
      700,
      120,
      86
    );
    const resolved = resolveNodeOverlaps(balanced, 1000, 700, 120, 86);

    expect(balanced.Side.x).toBeLessThan(positions.Side.x);
    expect(Math.abs(balanced.Side.x - 500)).toBeLessThan(360);
    expect(Math.abs(resolved.Side.x - resolved.B.x)).toBeGreaterThanOrEqual(170);
  });
});
