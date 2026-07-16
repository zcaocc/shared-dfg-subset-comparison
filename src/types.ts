export type AttributeType = "categorical" | "numeric" | "date";

export interface CaseAttributeSchema {
  name: string;
  label: string;
  type: AttributeType;
  values?: string[];
  min?: number | string;
  max?: number | string;
}

export interface EventRecord {
  activity: string;
  timestamp: string;
  assignmentGroup?: string;
}

export interface CaseRecord {
  caseId: string;
  attributes: Record<string, string | number | null>;
  caseStart: string;
  caseEnd: string;
  caseDurationHours: number;
  events: EventRecord[];
}

export interface EventLog {
  metadata: {
    logName: string;
    source: string;
    doi: string;
    caseCount: number;
    eventCount: number;
    activityCount: number;
    timeRange: { from: string; to: string };
    sampleNote: string;
    generatedAt: string;
    avgCaseDurationHours: number;
    medianCaseDurationHours: number;
  };
  schema: {
    caseAttributes: CaseAttributeSchema[];
  };
  activities: string[];
  cases: CaseRecord[];
}

export interface CaseAttributeFilter {
  field: string;
  operator: "in" | "range";
  negated?: boolean;
  values?: string[];
  min?: number | string;
  max?: number | string;
}

export interface SubsetDefinition {
  id: string;
  name: string;
  description: string;
  color: string;
  requiredActivities: string[];
  excludedActivities: string[];
  reworkActivities: string[];
  attributeFilters: CaseAttributeFilter[];
  timeWindow?: {
    from?: string;
    to?: string;
    startFrom?: string;
    startTo?: string;
    endFrom?: string;
    endTo?: string;
    invertStartRange?: boolean;
    invertEndRange?: boolean;
  };
  durationRangeHours?: { min?: number; max?: number };
}

export interface SubsetMetrics {
  subsetId: string;
  caseCount: number;
  eventCount: number;
  avgCaseDurationHours: number;
  medianCaseDurationHours: number;
  avgTransportationTimeDays?: number | null;
  avgAdvanceNoticeTimeDays?: number | null;
}

export interface DfgNodeMetrics {
  eventCount: number;
  caseCount: number;
  frequencyShare: number;
  caseShare: number;
  avgPosition: number;
}

export interface DfgEdgeMetrics {
  count: number;
  caseCount: number;
  frequencyShare: number;
  caseShare: number;
  avgWaitingHours: number | null;
  medianWaitingHours: number | null;
  sumWaitingHours: number | null;
  waitingTimeBinsHours?: number[];
}

export interface DfgNode {
  activity: string;
  metrics: DfgNodeMetrics;
}

export interface DfgEdge {
  id: string;
  source: string;
  target: string;
  metrics: DfgEdgeMetrics;
}

export interface SubsetDfg {
  subset: SubsetDefinition;
  metrics: SubsetMetrics;
  nodes: DfgNode[];
  edges: DfgEdge[];
}

export interface SharedDfgNode {
  activity: string;
  metricsBySubset: Record<string, DfgNodeMetrics>;
}

export interface SharedDfgEdge {
  id: string;
  source: string;
  target: string;
  metricsBySubset: Record<string, DfgEdgeMetrics>;
}

export interface SharedDfg {
  nodes: SharedDfgNode[];
  edges: SharedDfgEdge[];
}
