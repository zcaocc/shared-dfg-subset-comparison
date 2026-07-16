import * as Viz from "@viz-js/viz";

import { requireApiToken } from "../backend/auth.mjs";

function dotId(value) {
  return JSON.stringify(value);
}

function parsePair(value) {
  if (!value) return null;
  const [x, y] = String(value).split(",").map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

function parseBoundingBox(value) {
  if (!value) return null;
  const parts = String(value).split(",").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  return parts;
}

function normalizeSameRankGroups(groups, nodes, limit = 3) {
  const nodeSet = new Set(nodes);
  const used = new Set();
  const normalized = [];
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

function layoutEdgeConstraint(edge) {
  if (edge.source === edge.target) return false;
  if (typeof edge.constraint === "boolean") return edge.constraint;
  return edge.role !== "backward" && edge.role !== "reciprocal" && edge.role !== "self";
}

function layoutEdgeWeight(edge, constraint) {
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

function layoutEdgeMinlen(edge, constraint) {
  if (!constraint) return 1;
  const maxMinlen = edge.role === "main" ? 5 : 3;
  return Math.max(1, Math.min(maxMinlen, Math.round(edge.minlen ?? 1)));
}

function graphAttributes(compactMainFlow) {
  const nodesep = compactMainFlow ? 0.82 : 1.18;
  const ranksep = compactMainFlow ? 1.75 : 1.58;
  return `rankdir=TB, splines=polyline, overlap=false, sep="+18", esep="+10", concentrate=false, newrank=true, remincross=true, mclimit=6.0, searchsize=800, nslimit=10, nslimit1=10, nodesep=${nodesep}, ranksep=${ranksep}`;
}

function nodeAttributes(node, role, compactMainFlow) {
  if (role === "main") return ` [width=1.55, group="main-flow"]`;
  if (compactMainFlow && role === "weak") return " [width=1.85]";
  if (compactMainFlow && role === "side") return " [width=1.65]";
  if (role === "weak") return " [width=2.25]";
  if (role === "side") return " [width=1.75]";
  return "";
}

function toDot(request) {
  const lines = [
    "digraph G {",
    `  graph [${graphAttributes(request.compactMainFlow)}];`,
    '  node [shape=box, width=1.55, height=0.58, fixedsize=true, margin=0.05, style="rounded", ordering=out];',
    "  edge [arrowsize=0.75, penwidth=1.4];"
  ];

  for (const node of request.nodes ?? []) {
    lines.push(`  ${dotId(node)}${nodeAttributes(node, request.nodeRoles?.[node], request.compactMainFlow)};`);
  }
  if (request.nodes?.includes("Start")) lines.push(`  { rank=min; ${dotId("Start")}; }`);
  if (request.nodes?.includes("End")) lines.push(`  { rank=max; ${dotId("End")}; }`);
  for (const hint of request.rankHints ?? []) {
    const hintNodes = [...new Set(hint.nodes ?? [])].filter((node) => request.nodes.includes(node));
    if (hintNodes.length) lines.push(`  { rank=${hint.rank}; ${hintNodes.map(dotId).join("; ")}; }`);
  }
  for (const group of normalizeSameRankGroups(request.sameRankGroups, request.nodes ?? [])) {
    lines.push(`  { rank=same; ${group.map(dotId).join("; ")}; }`);
  }
  for (const edge of request.rankGuideEdges ?? []) {
    if (!request.nodes.includes(edge.source) || !request.nodes.includes(edge.target) || edge.source === edge.target) continue;
    const weight = Math.max(1, Math.min(20, Math.round(edge.weight ?? 12)));
    const minlen = Math.max(1, Math.min(5, Math.round(edge.minlen ?? 2)));
    lines.push(`  ${dotId(edge.source)} -> ${dotId(edge.target)} [style=invis, weight=${weight}, minlen=${minlen}, constraint=true];`);
  }
  for (const edge of request.edges ?? []) {
    const constraint = layoutEdgeConstraint(edge);
    const weight = layoutEdgeWeight(edge, constraint);
    const minlen = layoutEdgeMinlen(edge, constraint);
    lines.push(`  ${dotId(edge.source)} -> ${dotId(edge.target)} [weight=${weight}, minlen=${minlen}, constraint=${constraint ? "true" : "false"}];`);
  }
  lines.push("}");
  return lines.join("\n");
}

function recenterGraphPositions(positions, centerNodes, width, marginX) {
  const centered = (centerNodes ?? []).map((node) => positions[node]).filter(Boolean);
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

function centerStartPosition(positions, width, marginX) {
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clonePositions(positions) {
  return Object.fromEntries(Object.entries(positions).map(([node, position]) => [node, { ...position }]));
}

function clampGraphPositions(positions, width, height, marginX, marginY) {
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

function resolveNodeOverlaps(positions, width, height, marginX, marginY) {
  const entries = Object.entries(positions);
  if (entries.length < 2) return positions;
  const next = clonePositions(positions);
  const minGapX = 132;
  const minGapXNearRank = 184;
  const minGapY = 76;
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

function anchorBoundaryPositions(positions, width, height, marginX, marginY) {
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

function rebalanceHorizontalOutliers(positions, request, width, height, marginX, marginY) {
  const entries = Object.entries(positions);
  if (entries.length < 3) return positions;

  const centerCandidates = [
    positions.Start,
    positions.End,
    ...(request.centerNodes ?? []).map((node) => positions[node])
  ].filter(Boolean);
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

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") return JSON.parse(req.body);
  return req.body;
}

export default async function handler(req, res) {
  if (!requireApiToken(req, res)) return;

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = parseBody(req);
    const request = body.request;
    const width = Number(body.width ?? 1000);
    const height = Number(body.height ?? 760);
    if (!request?.nodes?.length) {
      res.status(200).json({ engine: "vercel-node-viz-dot", nodeCount: 0, positions: {} });
      return;
    }

    const viz = await Viz.instance();
    const graph = viz.renderJSON(toDot(request), { engine: "dot" });
    const bounds = parseBoundingBox(graph.bb);
    const nodes = graph.objects ?? [];
    if (!bounds || !nodes.length) {
      res.status(200).json({ engine: "vercel-node-viz-dot", nodeCount: 0, positions: {} });
      return;
    }

    const [x0, y0, x1, y1] = bounds;
    const graphWidth = Math.max(1, x1 - x0);
    const graphHeight = Math.max(1, y1 - y0);
    const marginX = 120;
    const marginY = 86;
    const layoutWidth = Math.max(1, width - marginX * 2);
    const layoutHeight = Math.max(1, height - marginY * 2);
    const positions = {};
    const nodeSet = new Set(request.nodes);

    for (const node of nodes) {
      if (!node.name || !nodeSet.has(node.name)) continue;
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
    const balancedPositions = rebalanceHorizontalOutliers(anchoredPositions, request, width, height, marginX, marginY);
    const centeredPositions = resolveNodeOverlaps(balancedPositions, width, height, marginX, marginY);
    res.status(200).json({
      engine: "vercel-node-viz-dot",
      nodeCount: Object.keys(centeredPositions).length,
      positions: centeredPositions
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
}
