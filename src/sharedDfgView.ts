import type { SharedDfg, SharedDfgEdge, SharedDfgNode } from "./types";
import { metricOrEmpty } from "./processMining";

export type PathMode = "all" | "shared" | "specific";
export type ActivityScope = "all" | "common" | "specific";

export interface SharedDfgViewInput {
  activityCaseShareThreshold: number;
  activityScope: ActivityScope;
  dfg: SharedDfg;
  hiddenActivities: string[];
  hiddenPaths: string[];
  maxVisibleActivities: number;
  maxVisiblePaths: number;
  pathCaseShareThreshold: number;
  pathMode: PathMode;
  selectedIds: string[];
}

export interface SharedDfgView {
  candidateEdges: SharedDfgEdge[];
  displayNodes: SharedDfgNode[];
  effectivePathMode: PathMode;
  scopedEdges: SharedDfgEdge[];
  scopedNodes: SharedDfgNode[];
  visibleEdges: SharedDfgEdge[];
  visibleEdgePairs: Set<string>;
  visiblePairKeys: Set<string>;
}

export interface DefaultVisibleLimitsInput {
  activityCaseShareThreshold: number;
  activityLimitOverride?: number;
  activityScope: ActivityScope;
  dfg: SharedDfg;
  hiddenActivities: string[];
  hiddenPaths: string[];
  pathCaseShareThreshold: number;
  pathMode: PathMode;
  selectedIds: string[];
}

export interface DefaultVisibleLimitStats {
  activityCoverage: number;
  activityRule: "all-coverage" | "common-threshold" | "specific-threshold" | "empty";
  connectedActivityCount: number;
  pathCoverage: number;
  pathRule: "importance-coverage" | "specific-paths" | "empty";
}

export interface DefaultVisibleLimits {
  activityLimit: number;
  pathLimit: number;
  stats: DefaultVisibleLimitStats;
}

const boundaryActivities = new Set(["Start", "End"]);

export function isBoundaryActivityName(activity: string): boolean {
  return boundaryActivities.has(activity);
}

export function subsetIdsForNode(node: SharedDfgNode, selectedIds: string[]): string[] {
  return selectedIds.filter((id) => {
    const metrics = node.metricsBySubset[id];
    return Boolean(metrics && (metrics.caseCount > 0 || metrics.eventCount > 0));
  });
}

export function subsetIdsForEdge(edge: SharedDfgEdge, selectedIds: string[]): string[] {
  return selectedIds.filter((id) => metricOrEmpty(edge, id).count > 0);
}

export function maxNodeCaseShare(node: SharedDfgNode, selectedIds: string[]): number {
  return Math.max(0, ...selectedIds.map((id) => node.metricsBySubset[id]?.caseShare ?? 0));
}

export function maxEdgeCaseShare(edge: SharedDfgEdge, selectedIds: string[]): number {
  return Math.max(0, ...selectedIds.map((id) => metricOrEmpty(edge, id).caseShare));
}

export function nodeAveragePosition(node: SharedDfgNode): number {
  const positions = Object.values(node.metricsBySubset).map((metrics) => metrics.avgPosition);
  return positions.reduce((sum, value) => sum + value, 0) / Math.max(1, positions.length);
}

export function visibleForActivityScope(node: SharedDfgNode, selectedIds: string[], activityScope: ActivityScope): boolean {
  const presentIds = subsetIdsForNode(node, selectedIds);
  if (activityScope === "common") return selectedIds.length > 0 && presentIds.length === selectedIds.length;
  if (activityScope === "specific") return presentIds.length === 1;
  return presentIds.length > 0;
}

export function visibleForPathMode(edge: SharedDfgEdge, selectedIds: string[], pathMode: PathMode): boolean {
  const presentIds = subsetIdsForEdge(edge, selectedIds);
  if (pathMode === "shared") return selectedIds.length > 0 && presentIds.length === selectedIds.length;
  if (pathMode === "specific") return presentIds.length === 1;
  return presentIds.length > 0;
}

function nodePassesThreshold(node: SharedDfgNode, selectedIds: string[], threshold: number): boolean {
  return maxNodeCaseShare(node, selectedIds) > threshold;
}

function edgePassesThreshold(edge: SharedDfgEdge, selectedIds: string[], threshold: number): boolean {
  return maxEdgeCaseShare(edge, selectedIds) > threshold;
}

function endpointsInSet(edge: SharedDfgEdge, activities: Set<string>): boolean {
  const sourceVisible = isBoundaryActivityName(edge.source) || activities.has(edge.source);
  const targetVisible = isBoundaryActivityName(edge.target) || activities.has(edge.target);
  return sourceVisible && targetVisible;
}

function isBoundaryEdge(edge: SharedDfgEdge): boolean {
  return isBoundaryActivityName(edge.source) || isBoundaryActivityName(edge.target);
}

function sortNodesByPriority(nodes: SharedDfgNode[], selectedIds: string[]): SharedDfgNode[] {
  return [...nodes].sort(
    (a, b) =>
      maxNodeCaseShare(b, selectedIds) - maxNodeCaseShare(a, selectedIds) ||
      nodeAveragePosition(a) - nodeAveragePosition(b) ||
      a.activity.localeCompare(b.activity)
  );
}

function sortEdgesByPriority(edges: SharedDfgEdge[], selectedIds: string[]): SharedDfgEdge[] {
  return [...edges].sort(
    (a, b) =>
      Number(subsetIdsForEdge(b, selectedIds).length === selectedIds.length) - Number(subsetIdsForEdge(a, selectedIds).length === selectedIds.length) ||
      maxEdgeCaseShare(b, selectedIds) - maxEdgeCaseShare(a, selectedIds) ||
      edgeTotalFrequency(b, selectedIds) - edgeTotalFrequency(a, selectedIds) ||
      a.source.localeCompare(b.source) ||
      a.target.localeCompare(b.target)
  );
}

function edgeTotalFrequency(edge: SharedDfgEdge, selectedIds: string[]): number {
  return selectedIds.reduce((sum, id) => sum + metricOrEmpty(edge, id).count, 0);
}

function edgePriorityScore(edge: SharedDfgEdge, selectedIds: string[]): number {
  const boundaryBoost = isBoundaryEdge(edge) ? 10000 : 0;
  const sharedBoost = subsetIdsForEdge(edge, selectedIds).length === selectedIds.length ? 1000 : 0;
  return boundaryBoost + sharedBoost + maxEdgeCaseShare(edge, selectedIds) * 100 + edgeTotalFrequency(edge, selectedIds) / 100000;
}

function scopedBusinessNodes({
  activityCaseShareThreshold,
  activityScope,
  dfg,
  hiddenActivities,
  selectedIds
}: Pick<DefaultVisibleLimitsInput, "activityCaseShareThreshold" | "activityScope" | "dfg" | "hiddenActivities" | "selectedIds">): SharedDfgNode[] {
  const hiddenActivitySet = new Set(hiddenActivities);
  return sortNodesByPriority(
    dfg.nodes
      .filter((node) => !isBoundaryActivityName(node.activity))
      .filter((node) => !hiddenActivitySet.has(node.activity))
      .filter((node) => visibleForActivityScope(node, selectedIds, activityScope))
      .filter((node) => nodePassesThreshold(node, selectedIds, activityCaseShareThreshold)),
    selectedIds
  );
}

function scopedLogicalEdges({
  activityScope,
  dfg,
  hiddenActivities,
  hiddenPaths,
  pathCaseShareThreshold,
  pathMode,
  selectedIds
}: Pick<DefaultVisibleLimitsInput, "activityScope" | "dfg" | "hiddenActivities" | "hiddenPaths" | "pathCaseShareThreshold" | "pathMode" | "selectedIds"> & {
  scopedActivitySet: Set<string>;
}): SharedDfgEdge[] {
  const hiddenActivitySet = new Set(hiddenActivities);
  const hiddenPathSet = new Set(hiddenPaths);
  const effectivePathMode = activityScope === "specific" ? "specific" : pathMode;
  return sortEdgesByPriority(
    dfg.edges
      .filter((edge) => !hiddenPathSet.has(edge.id))
      .filter((edge) => !hiddenActivitySet.has(edge.source) && !hiddenActivitySet.has(edge.target))
      .filter((edge) => visibleForPathMode(edge, selectedIds, effectivePathMode))
      .filter((edge) => edgePassesThreshold(edge, selectedIds, pathCaseShareThreshold)),
    selectedIds
  );
}

function minimumDefaultActivityLimit(nodes: SharedDfgNode[]): number {
  if (!nodes.length) return 0;
  return Math.max(1, Math.ceil(nodes.length * 0.25));
}

function activityLimitByItemCoverage(nodes: SharedDfgNode[], selectedIds: string[], coverageThreshold: number): number {
  const coverageLimit = nodes.filter((node) => maxNodeCaseShare(node, selectedIds) > coverageThreshold).length;
  return Math.min(nodes.length, Math.max(coverageLimit, minimumDefaultActivityLimit(nodes)));
}

function prefixLimitForItemCoverage(edges: SharedDfgEdge[], selectedIds: string[], coverageThreshold: number): { coverage: number; limit: number } {
  let limit = 0;
  let qualifyingCount = 0;
  edges.forEach((edge, index) => {
    if (maxEdgeCaseShare(edge, selectedIds) > coverageThreshold) {
      qualifyingCount += 1;
      limit = Math.max(limit, index + 1);
    }
  });
  return {
    coverage: edges.length ? qualifyingCount / edges.length : 0,
    limit: Math.min(edges.length, limit)
  };
}

function strongestIncidentEdgeIndex(activity: string, edges: SharedDfgEdge[], selectedIds: string[]): number {
  let bestIndex = -1;
  let bestScore = -Infinity;
  edges.forEach((edge, index) => {
    if (edge.source !== activity && edge.target !== activity) return;
    const score = edgePriorityScore(edge, selectedIds);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  });
  return bestIndex;
}

export function deriveDefaultVisibleLimits({
  activityCaseShareThreshold,
  activityLimitOverride,
  activityScope,
  dfg,
  hiddenActivities,
  hiddenPaths,
  pathCaseShareThreshold,
  pathMode,
  selectedIds
}: DefaultVisibleLimitsInput): DefaultVisibleLimits {
  const emptyStats: DefaultVisibleLimitStats = {
    activityCoverage: 0,
    activityRule: "empty",
    connectedActivityCount: 0,
    pathCoverage: 0,
    pathRule: "empty"
  };
  if (!selectedIds.length) return { activityLimit: 1, pathLimit: 1, stats: emptyStats };

  const scopedNodes = scopedBusinessNodes({ activityCaseShareThreshold, activityScope, dfg, hiddenActivities, selectedIds });
  if (!scopedNodes.length) return { activityLimit: 1, pathLimit: 1, stats: emptyStats };

  let activityRule: DefaultVisibleLimitStats["activityRule"] = "all-coverage";
  let activityCoverage = 0;
  let activityLimit = 1;
  if (typeof activityLimitOverride === "number") {
    activityLimit = Math.max(1, Math.min(scopedNodes.length, activityLimitOverride));
    activityCoverage = scopedNodes.slice(0, activityLimit).reduce((sum, node) => sum + maxNodeCaseShare(node, selectedIds), 0);
  } else if (activityScope === "specific") {
    activityRule = "specific-threshold";
    activityLimit = scopedNodes.length;
    activityCoverage = scopedNodes.slice(0, activityLimit).reduce((sum, node) => sum + maxNodeCaseShare(node, selectedIds), 0);
  } else if (activityScope === "common") {
    activityRule = "common-threshold";
    activityLimit = activityLimitByItemCoverage(scopedNodes, selectedIds, 0.5);
    activityCoverage = scopedNodes.slice(0, activityLimit).reduce((sum, node) => sum + maxNodeCaseShare(node, selectedIds), 0);
  } else {
    activityLimit = activityLimitByItemCoverage(scopedNodes, selectedIds, 0.7);
    activityCoverage = scopedNodes.slice(0, activityLimit).reduce((sum, node) => sum + maxNodeCaseShare(node, selectedIds), 0);
  }

  const visibleActivities = new Set(scopedNodes.slice(0, activityLimit).map((node) => node.activity));
  const scopedActivitySet = new Set(scopedNodes.map((node) => node.activity));
  const scopedEdges = scopedLogicalEdges({
    activityScope,
    dfg,
    hiddenActivities,
    hiddenPaths,
    pathCaseShareThreshold,
    pathMode,
    scopedActivitySet,
    selectedIds
  }).filter((edge) => endpointsInSet(edge, scopedActivitySet));
  const visibleCandidates = scopedEdges.filter((edge) => endpointsInSet(edge, visibleActivities));
  const boundaryEdges = visibleCandidates.filter(isBoundaryEdge);
  const candidateEdges = visibleCandidates.filter((edge) => !isBoundaryEdge(edge));
  if (!candidateEdges.length) {
    return {
      activityLimit,
      pathLimit: 1,
      stats: {
        activityCoverage,
        activityRule,
        connectedActivityCount: boundaryEdges.length,
        pathCoverage: 0,
        pathRule: "empty"
      }
    };
  }

  const effectivePathMode = activityScope === "specific" ? "specific" : pathMode;
  let pathRule: DefaultVisibleLimitStats["pathRule"] = "importance-coverage";
  let pathCoverage = 0;
  let pathLimit = 1;
  if (activityScope === "specific" || effectivePathMode === "specific") {
    pathRule = "specific-paths";
    pathLimit = candidateEdges.length;
    pathCoverage = 1;
  } else {
    const coverageTarget = activityScope === "common" ? 0.4 : 0.5;
    const coverageResult = prefixLimitForItemCoverage(candidateEdges, selectedIds, coverageTarget);
    pathLimit = coverageResult.limit;
    pathCoverage = coverageResult.coverage;
  }
  pathLimit = Math.min(candidateEdges.length, Math.max(pathLimit, activityLimit));

  const selectedEdgeIndexes = new Set<number>();
  for (let index = 0; index < Math.min(pathLimit, candidateEdges.length); index += 1) {
    selectedEdgeIndexes.add(index);
  }
  const activitiesConnectedByBoundary = new Set<string>();
  for (const edge of boundaryEdges) {
    if (!isBoundaryActivityName(edge.source)) activitiesConnectedByBoundary.add(edge.source);
    if (!isBoundaryActivityName(edge.target)) activitiesConnectedByBoundary.add(edge.target);
  }
  for (const activity of visibleActivities) {
    const hasBusinessPath = [...selectedEdgeIndexes].some((index) => {
      const edge = candidateEdges[index];
      return edge.source === activity || edge.target === activity;
    });
    if (hasBusinessPath || activitiesConnectedByBoundary.has(activity)) continue;
    const incidentIndex = strongestIncidentEdgeIndex(activity, candidateEdges, selectedIds);
    if (incidentIndex >= 0) selectedEdgeIndexes.add(incidentIndex);
  }
  const connectedActivities = new Set(activitiesConnectedByBoundary);
  for (const index of selectedEdgeIndexes) {
    const edge = candidateEdges[index];
    if (!edge) continue;
    if (!isBoundaryActivityName(edge.source)) connectedActivities.add(edge.source);
    if (!isBoundaryActivityName(edge.target)) connectedActivities.add(edge.target);
  }
  const connectedActivityCount = connectedActivities.size;
  const maxSelectedEdgeIndex = selectedEdgeIndexes.size ? Math.max(...selectedEdgeIndexes) : 0;
  pathLimit = Math.min(candidateEdges.length, Math.max(1, maxSelectedEdgeIndex + 1));

  return {
    activityLimit,
    pathLimit,
    stats: {
      activityCoverage,
      activityRule,
      connectedActivityCount,
      pathCoverage,
      pathRule
    }
  };
}

export function deriveSharedDfgView({
  activityCaseShareThreshold,
  activityScope,
  dfg,
  hiddenActivities,
  hiddenPaths,
  maxVisibleActivities,
  maxVisiblePaths,
  pathCaseShareThreshold,
  pathMode,
  selectedIds
}: SharedDfgViewInput): SharedDfgView {
  const hiddenActivitySet = new Set(hiddenActivities);
  const hiddenPathSet = new Set(hiddenPaths);
  const effectivePathMode = activityScope === "specific" ? "specific" : pathMode;

  if (!selectedIds.length) {
    return {
      candidateEdges: [],
      displayNodes: [],
      effectivePathMode,
      scopedEdges: [],
      scopedNodes: [],
      visibleEdges: [],
      visibleEdgePairs: new Set(),
      visiblePairKeys: new Set()
    };
  }

  const scopedNodes = sortNodesByPriority(
    dfg.nodes
      .filter((node) => !isBoundaryActivityName(node.activity))
      .filter((node) => !hiddenActivitySet.has(node.activity))
      .filter((node) => visibleForActivityScope(node, selectedIds, activityScope))
      .filter((node) => nodePassesThreshold(node, selectedIds, activityCaseShareThreshold)),
    selectedIds
  );
  const scopedActivitySet = new Set(scopedNodes.map((node) => node.activity));
  const visibleBusinessNodes = scopedNodes.slice(0, Math.max(0, maxVisibleActivities));
  const visibleActivitySet = new Set(visibleBusinessNodes.map((node) => node.activity));

  const scopedEdges = sortEdgesByPriority(
    dfg.edges
      .filter((edge) => !hiddenPathSet.has(edge.id))
      .filter((edge) => !hiddenActivitySet.has(edge.source) && !hiddenActivitySet.has(edge.target))
      .filter((edge) => endpointsInSet(edge, scopedActivitySet))
      .filter((edge) => visibleForPathMode(edge, selectedIds, effectivePathMode))
      .filter((edge) => edgePassesThreshold(edge, selectedIds, pathCaseShareThreshold)),
    selectedIds
  );
  const visibleCandidates = scopedEdges.filter((edge) => endpointsInSet(edge, visibleActivitySet));
  const boundaryEdges = visibleCandidates.filter(isBoundaryEdge);
  const candidateEdges = visibleCandidates.filter((edge) => !isBoundaryEdge(edge));
  const visibleEdgesById = new Map<string, SharedDfgEdge>();
  for (const edge of boundaryEdges) {
    visibleEdgesById.set(edge.id, edge);
  }
  for (const edge of candidateEdges.slice(0, Math.max(0, maxVisiblePaths))) {
    visibleEdgesById.set(edge.id, edge);
  }
  const visibleEdges = [...visibleEdgesById.values()];

  const displayActivitySet = new Set(visibleBusinessNodes.map((node) => node.activity));
  for (const edge of visibleEdges) {
    if (isBoundaryActivityName(edge.source)) displayActivitySet.add(edge.source);
    if (isBoundaryActivityName(edge.target)) displayActivitySet.add(edge.target);
  }

  const visiblePairKeys = new Set<string>();
  for (const edge of visibleEdges) {
    for (const subsetId of subsetIdsForEdge(edge, selectedIds)) {
      visiblePairKeys.add(`${edge.id}-${subsetId}`);
    }
  }

  return {
    candidateEdges,
    displayNodes: dfg.nodes.filter((node) => displayActivitySet.has(node.activity)),
    effectivePathMode,
    scopedEdges,
    scopedNodes,
    visibleEdges,
    visibleEdgePairs: new Set(visibleEdges.map((edge) => `${edge.source}__${edge.target}`)),
    visiblePairKeys
  };
}
