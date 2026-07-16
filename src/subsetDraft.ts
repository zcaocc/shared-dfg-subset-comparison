import type { EventLog, SubsetDefinition } from "./types";

export type ActivityMode = "ignore" | "required" | "excluded" | "rework";
export type NumericRangeDraft = { min: string; max: string };
export type InvertedDateRanges = { start: boolean; end: boolean };
const CASE_DURATION_FIELD = "caseDurationHours";
const HOURS_PER_DAY = 24;

export interface DraftSubsetInput {
  activityModes: Record<string, ActivityMode>;
  attributeValues: Record<string, string[]>;
  builderAttributeFields: string[];
  color: string;
  endDateRange: NumericRangeDraft;
  invertedAttributes: Record<string, boolean>;
  invertedDateRanges: InvertedDateRanges;
  log: EventLog | null;
  numericRanges: Record<string, NumericRangeDraft>;
  startDateRange: NumericRangeDraft;
  subsetDescription: string;
  subsetName: string;
}

export interface BuilderStateFromSubset {
  activityModes: Record<string, ActivityMode>;
  attributeValues: Record<string, string[]>;
  builderAttributeFields: string[];
  endDateRange: NumericRangeDraft;
  invertedAttributes: Record<string, boolean>;
  invertedDateRanges: InvertedDateRanges;
  numericRanges: Record<string, NumericRangeDraft>;
  startDateRange: NumericRangeDraft;
  subsetDescription: string;
  subsetName: string;
}

export function createEmptyModes(activities: string[]): Record<string, ActivityMode> {
  return Object.fromEntries(activities.map((activity) => [activity, "ignore"]));
}

export function attributeLabel(log: EventLog, field: string): string {
  if (field === CASE_DURATION_FIELD) return "Case duration (days)";
  return log.schema.caseAttributes.find((item) => item.name === field)?.label ?? field;
}

export function formatRangeBound(value: number | string | undefined): string {
  if (value === undefined || value === "") return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    const [year, month, day] = value.slice(0, 10).split("-");
    return `${day}/${month}/${year}`;
  }
  return value;
}

function formatAttributeRangeBound(field: string, value: number | string | undefined): string {
  if (field !== CASE_DURATION_FIELD || value === undefined || value === "") return formatRangeBound(value);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return formatRangeBound(value);
  return formatRangeBound(parsed / HOURS_PER_DAY);
}

export function datePart(value: string | undefined): string | undefined {
  return value?.slice(0, 10);
}

export function dateRangeFromLog(log: EventLog): NumericRangeDraft {
  return {
    min: log.metadata.timeRange.from.slice(0, 10),
    max: log.metadata.timeRange.to.slice(0, 10)
  };
}

export function rangeTimestamp(value: string, side: "start" | "end"): string | undefined {
  if (!value) return undefined;
  return `${value}T${side === "start" ? "00:00:00" : "23:59:59"}`;
}

export function timeWindowFormulaParts(subset: SubsetDefinition, log?: EventLog | null): string[] {
  const startFrom = datePart(subset.timeWindow?.startFrom ?? subset.timeWindow?.from);
  const startTo = datePart(subset.timeWindow?.startTo);
  const endFrom = datePart(subset.timeWindow?.endFrom);
  const endTo = datePart(subset.timeWindow?.endTo ?? subset.timeWindow?.to);
  const defaultMin = log?.metadata.timeRange.from.slice(0, 10);
  const defaultMax = log?.metadata.timeRange.to.slice(0, 10);
  const parts: string[] = [];
  const hasCustomStart = startFrom && (startFrom !== defaultMin || (startTo && startTo !== defaultMax));
  const hasCustomEnd = endTo && ((endFrom && endFrom !== defaultMin) || endTo !== defaultMax);

  if (hasCustomStart) {
    parts.push(`${subset.timeWindow?.invertStartRange ? "exclude " : ""}start date ${formatRangeBound(startFrom) || "-"}-${formatRangeBound(startTo ?? defaultMax) || "-"}`);
  }
  if (hasCustomEnd) {
    parts.push(`${subset.timeWindow?.invertEndRange ? "exclude " : ""}end date ${formatRangeBound(endFrom ?? defaultMin) || "-"}-${formatRangeBound(endTo) || "-"}`);
  }
  return parts;
}

export function subsetFormula(subset: SubsetDefinition, log?: EventLog | null): string {
  const parts = [
    ...subset.requiredActivities.map((activity) => `has ${activity}`),
    ...subset.excludedActivities.map((activity) => `no ${activity}`),
    ...subset.reworkActivities.map((activity) => `rework ${activity}`),
    ...timeWindowFormulaParts(subset, log)
  ];
  for (const filter of subset.attributeFilters) {
    const prefix = filter.negated ? "exclude " : "";
    if (filter.operator === "in" && filter.values?.length) parts.push(`${prefix}${filter.field} in ${filter.values.join(", ")}`);
    if (filter.operator === "range") {
      const label = log ? attributeLabel(log, filter.field) : filter.field;
      parts.push(`${prefix}${label} ${formatAttributeRangeBound(filter.field, filter.min) || "-"}-${formatAttributeRangeBound(filter.field, filter.max) || "-"}`);
    }
  }
  return parts.length ? parts.join(" AND ") : "all cases";
}

export function generatedSubsetName(log: EventLog | null, subset: SubsetDefinition): string {
  const valueParts: string[] = [];
  const rangeParts: string[] = [];

  for (const filter of subset.attributeFilters) {
    if (filter.operator === "in" && filter.values?.length) {
      valueParts.push(...filter.values.map((value) => (filter.negated ? `Exclude ${value}` : value)));
    }
    if (filter.operator === "range") {
      const label = log ? attributeLabel(log, filter.field) : filter.field;
      const min = formatAttributeRangeBound(filter.field, filter.min);
      const max = formatAttributeRangeBound(filter.field, filter.max);
      rangeParts.push(`${filter.negated ? "Exclude " : ""}${label} ${min}-${max}`.trim());
    }
  }

  const activityParts = [
    ...subset.requiredActivities.map((activity) => `Has ${activity}`),
    ...subset.excludedActivities.map((activity) => `No ${activity}`),
    ...subset.reworkActivities.map((activity) => `Rework ${activity}`)
  ];
  const parts = [...valueParts, ...activityParts, ...rangeParts].filter(Boolean);
  if (!parts.length) return "All cases";
  return parts.slice(0, 4).join(" + ") + (parts.length > 4 ? ` + ${parts.length - 4} more` : "");
}

export function buildDraftSubset({
  activityModes,
  attributeValues,
  builderAttributeFields,
  color,
  endDateRange,
  invertedAttributes,
  invertedDateRanges,
  log,
  numericRanges,
  startDateRange,
  subsetDescription,
  subsetName
}: DraftSubsetInput): SubsetDefinition {
  const requiredActivities = Object.entries(activityModes)
    .filter(([, mode]) => mode === "required")
    .map(([activity]) => activity);
  const excludedActivities = Object.entries(activityModes)
    .filter(([, mode]) => mode === "excluded")
    .map(([activity]) => activity);
  const reworkActivities = Object.entries(activityModes)
    .filter(([, mode]) => mode === "rework")
    .map(([activity]) => activity);

  const attributeFilters: SubsetDefinition["attributeFilters"] = [];
  for (const field of builderAttributeFields) {
    const schema = log?.schema.caseAttributes.find((item) => item.name === field);
    if (!schema) continue;
    if (schema.type === "categorical" || field === "salesCompany") {
      const values = attributeValues[field] ?? [];
      if (values.length) attributeFilters.push({ field, operator: "in", values, negated: invertedAttributes[field] === true });
    } else if (schema.type === "numeric") {
      const range = numericRanges[field];
      const min = range?.min === "" || range?.min === undefined ? undefined : Number(range.min);
      const max = range?.max === "" || range?.max === undefined ? undefined : Number(range.max);
      if (min !== undefined || max !== undefined) attributeFilters.push({ field, operator: "range", min, max, negated: invertedAttributes[field] === true });
    } else {
      const range = numericRanges[field];
      const min = range?.min || undefined;
      const max = range?.max || undefined;
      if (min !== undefined || max !== undefined) attributeFilters.push({ field, operator: "range", min, max, negated: invertedAttributes[field] === true });
    }
  }

  return {
    id: "draft",
    name: subsetName.trim() || "Untitled subset",
    description: subsetDescription.trim(),
    color,
    requiredActivities,
    excludedActivities,
    reworkActivities,
    attributeFilters,
    timeWindow: {
      startFrom: rangeTimestamp(startDateRange.min, "start"),
      startTo: rangeTimestamp(startDateRange.max, "end"),
      endFrom: rangeTimestamp(endDateRange.min, "start"),
      endTo: rangeTimestamp(endDateRange.max, "end"),
      invertStartRange: invertedDateRanges.start,
      invertEndRange: invertedDateRanges.end
    },
    durationRangeHours: undefined
  };
}

export function builderStateFromSubset(log: EventLog, subset: SubsetDefinition, currentBuilderFields: string[]): BuilderStateFromSubset {
  const activityModes = createEmptyModes(log.activities);
  for (const activity of subset.requiredActivities) {
    if (activity in activityModes) activityModes[activity] = "required";
  }
  for (const activity of subset.excludedActivities) {
    if (activity in activityModes) activityModes[activity] = "excluded";
  }
  for (const activity of subset.reworkActivities) {
    if (activity in activityModes) activityModes[activity] = "rework";
  }

  const attributeValues: Record<string, string[]> = {};
  const invertedAttributes: Record<string, boolean> = {};
  const numericRanges: Record<string, NumericRangeDraft> = {};
  const knownFields = new Set(log.schema.caseAttributes.map((attribute) => attribute.name));
  const loadedFields: string[] = [];

  for (const filter of subset.attributeFilters) {
    if (!knownFields.has(filter.field)) continue;
    loadedFields.push(filter.field);
    if (filter.negated) invertedAttributes[filter.field] = true;
    if (filter.operator === "in") {
      attributeValues[filter.field] = filter.values ?? [];
    } else {
      numericRanges[filter.field] = {
        min: filter.min === undefined ? "" : String(filter.min).slice(0, 10),
        max: filter.max === undefined ? "" : String(filter.max).slice(0, 10)
      };
    }
  }

  const fullRange = dateRangeFromLog(log);
  const builderAttributeFields = [...currentBuilderFields];
  for (const field of loadedFields) {
    if (!builderAttributeFields.includes(field)) builderAttributeFields.push(field);
  }

  return {
    activityModes,
    attributeValues,
    builderAttributeFields,
    endDateRange: {
      min: datePart(subset.timeWindow?.endFrom) ?? fullRange.min,
      max: datePart(subset.timeWindow?.endTo ?? subset.timeWindow?.to) ?? fullRange.max
    },
    invertedAttributes,
    invertedDateRanges: {
      start: subset.timeWindow?.invertStartRange === true,
      end: subset.timeWindow?.invertEndRange === true
    },
    numericRanges,
    startDateRange: {
      min: datePart(subset.timeWindow?.startFrom ?? subset.timeWindow?.from) ?? fullRange.min,
      max: datePart(subset.timeWindow?.startTo) ?? fullRange.max
    },
    subsetDescription: subset.description || subsetFormula(subset, log),
    subsetName: `${subset.name} refined`
  };
}
