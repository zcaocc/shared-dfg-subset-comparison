export type GraphvizLayoutEdgeRole = "main" | "side" | "backward" | "reciprocal" | "self";
export type GraphvizLayoutNodeRole = "main" | "side" | "weak";

export type GraphvizLayoutRequest = {
  centerNodes?: string[];
  compactMainFlow?: boolean;
  edges: Array<{
    constraint?: boolean;
    minlen?: number;
    role?: GraphvizLayoutEdgeRole;
    source: string;
    target: string;
    weight?: number;
  }>;
  nodeRoles?: Record<string, GraphvizLayoutNodeRole>;
  nodes: string[];
  rankGuideEdges?: Array<{ minlen?: number; source: string; target: string; weight?: number }>;
  rankHints?: Array<{ nodes: string[]; rank: "min" | "max" }>;
  sameRankGroups?: string[][];
};

export type GraphvizLayoutResult = {
  engine: string;
  nodeCount: number;
  positions: Record<string, { x: number; y: number }>;
};

type GraphvizJsonNode = {
  name?: string;
  pos?: string;
};

type GraphvizJson = {
  bb?: string;
  objects?: GraphvizJsonNode[];
};

const nodeOverlapMinGapY = 76;
const boundaryLinkCompactCenterGap = 62;

function dotId(value: string): string {
  return JSON.stringify(value);
}

function parsePair(value: string | undefined): [number, number] | null {
  if (!value) return null;
  const [x, y] = value.split(",").map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

function parseBoundingBox(value: string | undefined): [number, number, number, number] | null {
  if (!value) return null;
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  return [parts[0], parts[1], parts[2], parts[3]];
}

export function normalizeSameRankGroups(groups: string[][] | undefined, nodes: string[], limit = 3): string[][] {
  const nodeSet = new Set(nodes);
  const used = new Set<string>();
  const normalized: string[][] = [];
  for (const group of groups ?? []) {
    const uniqueGroup = [...new Set(group)].filter((node) => nodeSet.has(node) && node !== "Start" && node !== "End");
    if (uniqueGroup.length < 2) continue;
    if (uniqueGroup.some((node) => used.has(node))) continue;
    normalized.push(uniqueGroup);
    for (const node of uniqueGroup) used.add(node);
    if (normalized.length >= limit) break;
  }
  return normalized;
}

function layoutEdgeConstraint(edge: GraphvizLayoutRequest["edges"][number]): boolean {
  if (edge.source === edge.target) return false;
  if (typeof edge.constraint === "boolean") return edge.constraint;
  return edge.role !== "backward" && edge.role !== "reciprocal" && edge.role !== "self";
}

function layoutEdgeWeight(edge: GraphvizLayoutRequest["edges"][number], constraint: boolean): number {
  const metricWeight = Number.isFinite(edge.weight) ? Math.max(1, Math.min(12, Math.round(edge.weight ?? 1))) : 1;
  if (!constraint) {
    if (edge.role === "reciprocal") return Math.max(2, Math.min(5, metricWeight));
    return edge.role === "backward" ? 2 : 1;
  }
  if (edge.source === "Start" || edge.target === "End") return Math.max(12, metricWeight);
  if (edge.role === "main") return Math.min(16, metricWeight + 4);
  if (edge.role === "side") return Math.max(2, Math.min(8, Math.round(metricWeight * 0.7)));
  return metricWeight;
}

function layoutEdgeMinlen(edge: GraphvizLayoutRequest["edges"][number], constraint: boolean): number {
  if (!constraint) return 1;
  const maxMinlen = edge.role === "main" ? 5 : 3;
  return Math.max(1, Math.min(maxMinlen, Math.round(edge.minlen ?? 1)));
}

function graphAttributes(compactMainFlow: boolean | undefined): string {
  const nodesep = compactMainFlow ? 0.62 : 1.05;
  const ranksep = compactMainFlow ? 1.62 : 1.45;
  return `rankdir=TB, splines=polyline, overlap=false, concentrate=false, newrank=true, remincross=true, mclimit=6.0, searchsize=800, nslimit=10, nslimit1=10, nodesep=${nodesep}, ranksep=${ranksep}`;
}

function nodeAttributes(node: string, role: GraphvizLayoutNodeRole | undefined, compactMainFlow: boolean | undefined): string {
  if (role === "main") return ` [width=1.55, group="main-flow"]`;
  if (compactMainFlow && role === "weak") return " [width=1.85]";
  if (compactMainFlow && role === "side") return " [width=1.65]";
  if (role === "weak") return " [width=2.25]";
  if (role === "side") return " [width=1.75]";
  return "";
}

export function toDot(request: GraphvizLayoutRequest): string {
  const lines = [
    "digraph G {",
    `  graph [${graphAttributes(request.compactMainFlow)}];`,
    "  node [shape=box, width=1.55, height=0.58, fixedsize=true, margin=0.05, style=\"rounded\", ordering=out];",
    "  edge [arrowsize=0.75, penwidth=1.4];"
  ];

  for (const node of request.nodes) {
    lines.push(`  ${dotId(node)}${nodeAttributes(node, request.nodeRoles?.[node], request.compactMainFlow)};`);
  }
  if (request.nodes.includes("Start")) {
    lines.push(`  { rank=min; ${dotId("Start")}; }`);
  }
  if (request.nodes.includes("End")) {
    lines.push(`  { rank=max; ${dotId("End")}; }`);
  }
  for (const hint of request.rankHints ?? []) {
    const hintNodes = [...new Set(hint.nodes)].filter((node) => request.nodes.includes(node));
    if (hintNodes.length) {
      lines.push(`  { rank=${hint.rank}; ${hintNodes.map(dotId).join("; ")}; }`);
    }
  }
  for (const group of normalizeSameRankGroups(request.sameRankGroups, request.nodes)) {
    lines.push(`  { rank=same; ${group.map(dotId).join("; ")}; }`);
  }
  for (const edge of request.rankGuideEdges ?? []) {
    if (!request.nodes.includes(edge.source) || !request.nodes.includes(edge.target) || edge.source === edge.target) continue;
    const weight = Math.max(1, Math.min(20, Math.round(edge.weight ?? 12)));
    const minlen = Math.max(1, Math.min(5, Math.round(edge.minlen ?? 2)));
    lines.push(`  ${dotId(edge.source)} -> ${dotId(edge.target)} [style=invis, weight=${weight}, minlen=${minlen}, constraint=true];`);
  }
  for (const edge of request.edges) {
    const constraint = layoutEdgeConstraint(edge);
    const weight = layoutEdgeWeight(edge, constraint);
    const minlen = layoutEdgeMinlen(edge, constraint);
    lines.push(`  ${dotId(edge.source)} -> ${dotId(edge.target)} [weight=${weight}, minlen=${minlen}, constraint=${constraint ? "true" : "false"}];`);
  }
  lines.push("}");
  return lines.join("\n");
}

export function recenterGraphPositions(
  positions: Record<string, { x: number; y: number }>,
  centerNodes: string[] | undefined,
  width: number,
  marginX: number
): Record<string, { x: number; y: number }> {
  const centered = (centerNodes ?? []).map((node) => positions[node]).filter((position): position is { x: number; y: number } => Boolean(position));
  const allPositions = Object.values(positions);
  if (!centered.length || !allPositions.length) return positions;
  const centerAverageX = centered.reduce((sum, position) => sum + position.x, 0) / centered.length;
  const rawDx = width / 2 - centerAverageX;
  const minX = Math.min(...allPositions.map((position) => position.x));
  const maxX = Math.max(...allPositions.map((position) => position.x));
  const minDx = marginX - minX;
  const maxDx = width - marginX - maxX;
  const dx = Math.max(minDx, Math.min(maxDx, rawDx));
  if (Math.abs(dx) < 0.1) return positions;
  return Object.fromEntries(Object.entries(positions).map(([node, position]) => [node, { x: position.x + dx, y: position.y }]));
}

export function centerStartPosition(
  positions: Record<string, { x: number; y: number }>,
  width: number,
  marginX: number
): Record<string, { x: number; y: number }> {
  const start = positions.Start;
  const allPositions = Object.values(positions);
  if (!start || !allPositions.length) return positions;
  const rawDx = width / 2 - start.x;
  const minX = Math.min(...allPositions.map((position) => position.x));
  const maxX = Math.max(...allPositions.map((position) => position.x));
  const minDx = marginX - minX;
  const maxDx = width - marginX - maxX;
  const dx = Math.max(minDx, Math.min(maxDx, rawDx));
  if (Math.abs(dx) < 0.1) return positions;
  return Object.fromEntries(Object.entries(positions).map(([node, position]) => [node, { x: position.x + dx, y: position.y }]));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clonePositions(positions: Record<string, { x: number; y: number }>): Record<string, { x: number; y: number }> {
  return Object.fromEntries(Object.entries(positions).map(([node, position]) => [node, { ...position }]));
}

function isBoundaryLayoutNode(node: string): boolean {
  return node === "Start" || node === "End";
}

function clampGraphPositions(
  positions: Record<string, { x: number; y: number }>,
  width: number,
  height: number,
  marginX: number,
  marginY: number
): Record<string, { x: number; y: number }> {
  const minX = marginX * 0.45;
  const maxX = width - marginX * 0.45;
  const minY = marginY * 0.55;
  const maxY = height - marginY * 0.55;
  return Object.fromEntries(
    Object.entries(positions).map(([node, position]) => [
      node,
      {
        x: clamp(position.x, minX, maxX),
        y: clamp(position.y, minY, maxY)
      }
    ])
  );
}

export function resolveNodeOverlaps(
  positions: Record<string, { x: number; y: number }>,
  width: number,
  height: number,
  marginX: number,
  marginY: number
): Record<string, { x: number; y: number }> {
  const entries = Object.entries(positions);
  if (entries.length < 2) return positions;
  const next = clonePositions(positions);
  const minGapX = 132;
  const minGapXNearRank = 184;
  const nearRankY = 96;
  const minX = marginX * 0.45;
  const maxX = width - marginX * 0.45;
  const minY = marginY * 0.55;
  const maxY = height - marginY * 0.55;

  for (let iteration = 0; iteration < 8; iteration += 1) {
    let changed = false;
    const nodes = Object.keys(next);
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = next[nodes[i]];
        const b = next[nodes[j]];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        const pairIncludesBoundary = isBoundaryLayoutNode(nodes[i]) || isBoundaryLayoutNode(nodes[j]);
        const minGapY = pairIncludesBoundary ? boundaryLinkCompactCenterGap : nodeOverlapMinGapY;
        const requiredGapX = absDy < nearRankY ? minGapXNearRank : minGapX;
        if (absDx >= requiredGapX || absDy >= minGapY) continue;

        if (absDy < nearRankY || absDx <= absDy) {
          const shift = (requiredGapX - absDx) / 2 + 2;
          const direction = dx >= 0 ? 1 : -1;
          a.x = clamp(a.x - shift * direction, minX, maxX);
          b.x = clamp(b.x + shift * direction, minX, maxX);
        } else {
          const shift = (minGapY - absDy) / 2 + 2;
          const direction = dy >= 0 ? 1 : -1;
          a.y = clamp(a.y - shift * direction, minY, maxY);
          b.y = clamp(b.y + shift * direction, minY, maxY);
        }
        changed = true;
      }
    }
    if (!changed) break;
  }
  return next;
}

export function compactBoundaryLinkSpacing(
  positions: Record<string, { x: number; y: number }>,
  request: Pick<GraphvizLayoutRequest, "edges" | "nodes">,
  width: number,
  height: number,
  marginX: number,
  marginY: number
): Record<string, { x: number; y: number }> {
  const nodeSet = new Set(request.nodes);
  const next = clonePositions(positions);
  let changed = false;

  const startTarget = request.edges
    .filter((edge) => edge.source === "Start" && !isBoundaryLayoutNode(edge.target))
    .filter((edge) => nodeSet.has(edge.target) && Boolean(next[edge.target]))
    .map((edge) => next[edge.target])
    .sort((a, b) => a.y - b.y)[0];
  if (next.Start && startTarget) {
    const nextStartY = startTarget.y - boundaryLinkCompactCenterGap;
    if (Math.abs(next.Start.y - nextStartY) > 0.1) {
      next.Start = { ...next.Start, y: nextStartY };
      changed = true;
    }
  }

  const endSource = request.edges
    .filter((edge) => edge.target === "End" && !isBoundaryLayoutNode(edge.source))
    .filter((edge) => nodeSet.has(edge.source) && Boolean(next[edge.source]))
    .map((edge) => next[edge.source])
    .sort((a, b) => b.y - a.y)[0];
  if (next.End && endSource) {
    const nextEndY = endSource.y + boundaryLinkCompactCenterGap;
    if (Math.abs(next.End.y - nextEndY) > 0.1) {
      next.End = { ...next.End, y: nextEndY };
      changed = true;
    }
  }

  return changed ? clampGraphPositions(next, width, height, marginX, marginY) : positions;
}

export function anchorBoundaryPositions(
  positions: Record<string, { x: number; y: number }>,
  width: number,
  height: number,
  marginX: number,
  marginY: number
): Record<string, { x: number; y: number }> {
  const start = positions.Start;
  const end = positions.End;
  const entries = Object.entries(positions);
  if (!entries.length) return positions;

  if (start && end) {
    const targetX = width / 2;
    const endDeltaY = end.y - start.y;
    const targetEndY = height - marginY;
    const scaleY = endDeltaY > 1 ? clamp((targetEndY - start.y) / endDeltaY, 0.85, 1.25) : 1;
    const startDx = targetX - start.x;
    const endDx = targetX - end.x;
    const anchored = Object.fromEntries(
      entries.map(([node, position]) => {
        const progress = endDeltaY > 1 ? clamp((position.y - start.y) / endDeltaY, 0, 1) : node === "End" ? 1 : 0;
        return [
          node,
          {
            x: position.x + startDx + (endDx - startDx) * progress,
            y: start.y + (position.y - start.y) * scaleY
          }
        ];
      })
    );
    return clampGraphPositions(anchored, width, height, marginX, marginY);
  }

  if (start) {
    return clampGraphPositions(centerStartPosition(positions, width, marginX), width, height, marginX, marginY);
  }

  if (end) {
    const targetX = width / 2;
    const rawDx = targetX - end.x;
    const allPositions = Object.values(positions);
    const minX = Math.min(...allPositions.map((position) => position.x));
    const maxX = Math.max(...allPositions.map((position) => position.x));
    const dx = clamp(rawDx, marginX - minX, width - marginX - maxX);
    const anchored = Math.abs(dx) < 0.1 ? positions : Object.fromEntries(entries.map(([node, position]) => [node, { x: position.x + dx, y: position.y }]));
    return clampGraphPositions(anchored, width, height, marginX, marginY);
  }

  return clampGraphPositions(positions, width, height, marginX, marginY);
}

export function rebalanceHorizontalOutliers(
  positions: Record<string, { x: number; y: number }>,
  request: Pick<GraphvizLayoutRequest, "centerNodes" | "nodes">,
  width: number,
  height: number,
  marginX: number,
  marginY: number
): Record<string, { x: number; y: number }> {
  const entries = Object.entries(positions);
  if (entries.length < 3) return positions;

  const centerCandidates = [
    positions.Start,
    positions.End,
    ...(request.centerNodes ?? []).map((node) => positions[node])
  ].filter((position): position is { x: number; y: number } => Boolean(position));
  const centerX = centerCandidates.length
    ? centerCandidates.reduce((sum, position) => sum + position.x, 0) / centerCandidates.length
    : width / 2;
  const maxX = width - marginX * 0.55;
  const minX = marginX * 0.55;
  const baseOffset = clamp(width * 0.28, 300, 460);
  const rankWindow = 96;
  const outlierEase = 0.1;

  const next = clonePositions(positions);
  for (const [node, position] of entries) {
    if (node === "Start" || node === "End") continue;
    const rankPeerCount = entries.filter(([, peer]) => Math.abs(peer.y - position.y) <= rankWindow).length;
    const rankAllowance = Math.min(160, Math.max(0, rankPeerCount - 1) * 48);
    const allowedOffset = Math.min(Math.max(180, width / 2 - marginX * 0.9), baseOffset + rankAllowance);
    const offset = position.x - centerX;
    const absOffset = Math.abs(offset);
    if (absOffset <= allowedOffset) continue;

    const direction = offset >= 0 ? 1 : -1;
    next[node] = {
      ...position,
      x: clamp(centerX + direction * (allowedOffset + (absOffset - allowedOffset) * outlierEase), minX, maxX)
    };
  }

  return clampGraphPositions(next, width, height, marginX, marginY);
}

export async function runBrowserGraphvizLayout(
  request: GraphvizLayoutRequest,
  width: number,
  height: number
): Promise<GraphvizLayoutResult> {
  const Viz = await import("@viz-js/viz");
  const viz = await Viz.instance();
  const graph = viz.renderJSON(toDot(request), { engine: "dot" }) as GraphvizJson;
  const bounds = parseBoundingBox(graph.bb);
  const nodes = graph.objects ?? [];
  if (!bounds || !nodes.length) {
    return { engine: "browser-graphviz-dot", nodeCount: 0, positions: {} };
  }

  const [x0, y0, x1, y1] = bounds;
  const graphWidth = Math.max(1, x1 - x0);
  const graphHeight = Math.max(1, y1 - y0);
  const marginX = 120;
  const marginY = 86;
  const layoutWidth = Math.max(1, width - marginX * 2);
  const layoutHeight = Math.max(1, height - marginY * 2);
  const positions: Record<string, { x: number; y: number }> = {};

  for (const node of nodes) {
    if (!node.name || !request.nodes.includes(node.name)) continue;
    const point = parsePair(node.pos);
    if (!point) continue;
    const [rawX, rawY] = point;
    positions[node.name] = {
      x: marginX + ((rawX - x0) / graphWidth) * layoutWidth,
      y: marginY + ((y1 - rawY) / graphHeight) * layoutHeight
    };
  }

  const recenteredPositions = recenterGraphPositions(positions, request.centerNodes, width, marginX);
  const resolvedPositions = resolveNodeOverlaps(recenteredPositions, width, height, marginX, marginY);
  const anchoredPositions = anchorBoundaryPositions(resolvedPositions, width, height, marginX, marginY);
  const compactedPositions = compactBoundaryLinkSpacing(anchoredPositions, request, width, height, marginX, marginY);
  const balancedPositions = rebalanceHorizontalOutliers(compactedPositions, request, width, height, marginX, marginY);
  const centeredPositions = resolveNodeOverlaps(balancedPositions, width, height, marginX, marginY);

  return {
    engine: "browser-graphviz-dot",
    nodeCount: Object.keys(centeredPositions).length,
    positions: centeredPositions
  };
}
