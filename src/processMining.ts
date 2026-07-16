import type {
  CaseAttributeFilter,
  CaseRecord,
  DfgEdge,
  DfgEdgeMetrics,
  DfgNode,
  DfgNodeMetrics,
  SharedDfg,
  SubsetDefinition,
  SubsetDfg,
  SubsetMetrics
} from "./types";

const emptyEdgeMetrics: DfgEdgeMetrics = {
  count: 0,
  caseCount: 0,
  frequencyShare: 0,
  caseShare: 0,
  avgWaitingHours: null,
  medianWaitingHours: null,
  sumWaitingHours: null,
  waitingTimeBinsHours: []
};

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function fixedDayBins(values: number[]): number[] {
  const bins = Array.from({ length: 10 }, () => 0);
  for (const value of values) {
    const days = value / 24;
    const index = days >= 90 ? bins.length - 1 : Math.max(0, Math.min(8, Math.floor(days / 10)));
    bins[index] += 1;
  }
  return bins;
}

function caseAttribute(caseRecord: CaseRecord, field: string): string | number | null {
  if (field === "caseDurationHours") return caseRecord.caseDurationHours;
  return caseRecord.attributes[field] ?? null;
}

const activityCountCache = new WeakMap<CaseRecord, Map<string, number>>();

function caseActivityCounts(caseRecord: CaseRecord): Map<string, number> {
  const cached = activityCountCache.get(caseRecord);
  if (cached) return cached;

  const activityCounts = new Map<string, number>();
  for (const event of caseRecord.events) {
    activityCounts.set(event.activity, (activityCounts.get(event.activity) ?? 0) + 1);
  }
  activityCountCache.set(caseRecord, activityCounts);
  return activityCounts;
}

function matchesAttributeFilter(caseRecord: CaseRecord, filter: CaseAttributeFilter): boolean {
  const value = caseAttribute(caseRecord, filter.field);
  const hasValue = value !== null && value !== "";
  let matched = false;
  if (filter.operator === "in") {
    matched = Boolean(filter.values?.length) ? hasValue && filter.values!.includes(String(value)) : true;
  } else if (typeof value === "number") {
    const min = typeof filter.min === "number" ? filter.min : undefined;
    const max = typeof filter.max === "number" ? filter.max : undefined;
    const minOk = min === undefined || value >= min;
    const maxOk = max === undefined || value <= max;
    matched = minOk && maxOk;
  } else if (typeof value === "string") {
    const min = typeof filter.min === "string" ? filter.min : undefined;
    const max = typeof filter.max === "string" ? filter.max : undefined;
    const minOk = min === undefined || value >= min;
    const maxOk = max === undefined || value <= max;
    matched = minOk && maxOk;
  }
  return filter.negated ? hasValue && !matched : matched;
}

export function filterCases(cases: CaseRecord[], subset: SubsetDefinition): CaseRecord[] {
  const required = new Set(subset.requiredActivities);
  const excluded = new Set(subset.excludedActivities);
  const rework = new Set(subset.reworkActivities);

  return cases.filter((caseRecord) => {
    const activityCounts = caseActivityCounts(caseRecord);

    for (const activity of required) {
      if (!activityCounts.has(activity)) return false;
    }
    for (const activity of excluded) {
      if (activityCounts.has(activity)) return false;
    }
    for (const activity of rework) {
      if ((activityCounts.get(activity) ?? 0) < 2) return false;
    }

    const startFrom = subset.timeWindow?.startFrom ?? subset.timeWindow?.from;
    const startTo = subset.timeWindow?.startTo;
    const endFrom = subset.timeWindow?.endFrom;
    const endTo = subset.timeWindow?.endTo ?? subset.timeWindow?.to;
    const startInRange = (!startFrom || caseRecord.caseStart >= startFrom) && (!startTo || caseRecord.caseStart <= startTo);
    const endInRange = (!endFrom || caseRecord.caseEnd >= endFrom) && (!endTo || caseRecord.caseEnd <= endTo);
    if ((startFrom || startTo) && (subset.timeWindow?.invertStartRange ? startInRange : !startInRange)) return false;
    if ((endFrom || endTo) && (subset.timeWindow?.invertEndRange ? endInRange : !endInRange)) return false;

    if (subset.durationRangeHours?.min !== undefined && caseRecord.caseDurationHours < subset.durationRangeHours.min) {
      return false;
    }
    if (subset.durationRangeHours?.max !== undefined && caseRecord.caseDurationHours > subset.durationRangeHours.max) {
      return false;
    }

    return subset.attributeFilters.every((filter) => matchesAttributeFilter(caseRecord, filter));
  });
}

export function summarizeSubset(subsetId: string, cases: CaseRecord[]): SubsetMetrics {
  const durations = cases.map((caseRecord) => caseRecord.caseDurationHours);
  return {
    subsetId,
    caseCount: cases.length,
    eventCount: cases.reduce((sum, caseRecord) => sum + caseRecord.events.length, 0),
    avgCaseDurationHours: mean(durations),
    medianCaseDurationHours: median(durations),
    avgTransportationTimeDays: meanNumericAttribute(cases, "transportationTimeDays"),
    avgAdvanceNoticeTimeDays: meanNumericAttribute(cases, "advanceNoticeTimeDays")
  };
}

export function computeDfg(subset: SubsetDefinition, cases: CaseRecord[]): SubsetDfg {
  const nodeStats = new Map<string, { eventCount: number; cases: Set<string>; positions: number[] }>();
  const edgeStats = new Map<string, { source: string; target: string; count: number; cases: Set<string>; waiting: number[] }>();

  for (const caseRecord of cases) {
    const eventCount = caseRecord.events.length;
    const firstEvent = caseRecord.events[0];
    const lastEvent = caseRecord.events[caseRecord.events.length - 1];

    if (firstEvent && lastEvent) {
      const startStats = nodeStats.get("Start") ?? { eventCount: 0, cases: new Set<string>(), positions: [] };
      startStats.eventCount += 1;
      startStats.cases.add(caseRecord.caseId);
      startStats.positions.push(0);
      nodeStats.set("Start", startStats);

      const endStats = nodeStats.get("End") ?? { eventCount: 0, cases: new Set<string>(), positions: [] };
      endStats.eventCount += 1;
      endStats.cases.add(caseRecord.caseId);
      endStats.positions.push(1);
      nodeStats.set("End", endStats);

      addEdgeStat(edgeStats, "Start", firstEvent.activity, caseRecord.caseId, 0);
      addEdgeStat(edgeStats, lastEvent.activity, "End", caseRecord.caseId, 0);
    }

    caseRecord.events.forEach((event, index) => {
      const stats = nodeStats.get(event.activity) ?? { eventCount: 0, cases: new Set<string>(), positions: [] };
      stats.eventCount += 1;
      stats.cases.add(caseRecord.caseId);
      stats.positions.push(eventCount > 1 ? index / (eventCount - 1) : 0);
      nodeStats.set(event.activity, stats);
    });

    for (let index = 0; index < caseRecord.events.length - 1; index += 1) {
      const current = caseRecord.events[index];
      const next = caseRecord.events[index + 1];
      const waitingHours = Math.max(0, (Date.parse(next.timestamp) - Date.parse(current.timestamp)) / 36e5);
      addEdgeStat(edgeStats, current.activity, next.activity, caseRecord.caseId, waitingHours);
    }
  }

  const denominator = Math.max(1, cases.length);
  const totalNodeFrequency = Math.max(1, [...nodeStats.values()].reduce((sum, stats) => sum + stats.eventCount, 0));
  const totalEdgeFrequency = Math.max(1, [...edgeStats.values()].reduce((sum, stats) => sum + stats.count, 0));
  const nodes: DfgNode[] = [...nodeStats.entries()]
    .map(([activity, stats]) => ({
      activity,
      metrics: {
        eventCount: stats.eventCount,
        caseCount: stats.cases.size,
        frequencyShare: stats.eventCount / totalNodeFrequency,
        caseShare: stats.cases.size / denominator,
        avgPosition: mean(stats.positions)
      }
    }))
    .sort((a, b) => a.metrics.avgPosition - b.metrics.avgPosition || a.activity.localeCompare(b.activity));

  const edges: DfgEdge[] = [...edgeStats.values()]
    .map((stats) => ({
      id: `${stats.source}__${stats.target}`,
      source: stats.source,
      target: stats.target,
      metrics: {
        count: stats.count,
        caseCount: stats.cases.size,
        frequencyShare: stats.count / totalEdgeFrequency,
        caseShare: stats.cases.size / denominator,
        avgWaitingHours: stats.waiting.length ? mean(stats.waiting) : null,
        medianWaitingHours: stats.waiting.length ? median(stats.waiting) : null,
        sumWaitingHours: stats.waiting.length ? stats.waiting.reduce((sum, value) => sum + value, 0) : null,
        waitingTimeBinsHours: fixedDayBins(stats.waiting)
      }
    }))
    .sort((a, b) => b.metrics.caseShare - a.metrics.caseShare || a.id.localeCompare(b.id));

  return {
    subset,
    metrics: summarizeSubset(subset.id, cases),
    nodes,
    edges
  };
}

function addEdgeStat(
  edgeStats: Map<string, { source: string; target: string; count: number; cases: Set<string>; waiting: number[] }>,
  source: string,
  target: string,
  caseId: string,
  waitingHours: number
) {
  const key = `${source}__${target}`;
  const stats = edgeStats.get(key) ?? {
    source,
    target,
    count: 0,
    cases: new Set<string>(),
    waiting: []
  };
  stats.count += 1;
  stats.cases.add(caseId);
  stats.waiting.push(waitingHours);
  edgeStats.set(key, stats);
}

function meanNumericAttribute(cases: CaseRecord[], field: string): number | null {
  const values = cases
    .map((caseRecord) => caseAttribute(caseRecord, field))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length ? mean(values) : null;
}

export function mergeDfgs(dfgs: SubsetDfg[]): SharedDfg {
  const nodes = new Map<string, Record<string, DfgNodeMetrics>>();
  const edges = new Map<string, { source: string; target: string; metricsBySubset: Record<string, DfgEdgeMetrics> }>();

  for (const dfg of dfgs) {
    for (const node of dfg.nodes) {
      const metricsBySubset = nodes.get(node.activity) ?? {};
      metricsBySubset[dfg.subset.id] = node.metrics;
      nodes.set(node.activity, metricsBySubset);
    }
    for (const edge of dfg.edges) {
      const sharedEdge = edges.get(edge.id) ?? {
        source: edge.source,
        target: edge.target,
        metricsBySubset: {}
      };
      sharedEdge.metricsBySubset[dfg.subset.id] = edge.metrics;
      edges.set(edge.id, sharedEdge);
    }
  }

  return {
    nodes: [...nodes.entries()]
      .map(([activity, metricsBySubset]) => ({ activity, metricsBySubset }))
      .sort((a, b) => avgNodePosition(a.metricsBySubset) - avgNodePosition(b.metricsBySubset) || a.activity.localeCompare(b.activity)),
    edges: [...edges.entries()].map(([id, edge]) => ({ id, ...edge }))
  };
}

function avgNodePosition(metricsBySubset: Record<string, DfgNodeMetrics>): number {
  const values = Object.values(metricsBySubset).map((metrics) => metrics.avgPosition);
  return mean(values);
}

export function metricOrEmpty(edge: { metricsBySubset: Record<string, DfgEdgeMetrics> }, subsetId: string): DfgEdgeMetrics {
  return edge.metricsBySubset[subsetId] ?? emptyEdgeMetrics;
}

export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || Number.isNaN(hours)) return "n/a";
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function topActivities(cases: CaseRecord[], limit = 5): Array<{ activity: string; count: number }> {
  const counts = new Map<string, number>();
  for (const caseRecord of cases) {
    for (const event of caseRecord.events) {
      counts.set(event.activity, (counts.get(event.activity) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([activity, count]) => ({ activity, count }))
    .sort((a, b) => b.count - a.count || a.activity.localeCompare(b.activity))
    .slice(0, limit);
}
