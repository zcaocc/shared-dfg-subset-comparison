import type { CaseRecord, SubsetDefinition } from "./types";
import { filterCases } from "./processMining";

export type FacetScope =
  | { kind: "attribute"; field: string }
  | { kind: "startDate" }
  | { kind: "endDate" };

export type OptionStat = {
  count: number;
  share: number;
  value: string;
};

export type FacetDistribution = {
  avg: number;
  bins: number[];
  count: number;
  max: number;
  median: number;
  min: number;
};

function caseValue(caseRecord: CaseRecord, field: string): string | number | null {
  if (field === "caseDurationHours") return caseRecord.caseDurationHours;
  return caseRecord.attributes[field] ?? null;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function isoDateToDay(value: string): number | null {
  const parsed = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 86400000);
}

function distribution(values: number[], binCount = 10): FacetDistribution | null {
  const cleanValues = values.filter((value) => Number.isFinite(value));
  if (!cleanValues.length) return null;
  const min = Math.min(...cleanValues);
  const max = Math.max(...cleanValues);
  const range = Math.max(0.001, max - min);
  const bins = Array.from({ length: binCount }, () => 0);
  for (const value of cleanValues) {
    const index = Math.min(binCount - 1, Math.floor(((value - min) / range) * binCount));
    bins[index] += 1;
  }
  return {
    avg: cleanValues.reduce((sum, value) => sum + value, 0) / cleanValues.length,
    bins,
    count: cleanValues.length,
    max,
    median: median(cleanValues),
    min
  };
}

export function subsetWithoutFacet(subset: SubsetDefinition, scope: FacetScope): SubsetDefinition {
  if (scope.kind === "attribute") {
    return {
      ...subset,
      attributeFilters: subset.attributeFilters.filter((filter) => filter.field !== scope.field)
    };
  }

  const timeWindow = { ...subset.timeWindow };
  if (scope.kind === "startDate") {
    delete timeWindow.from;
    delete timeWindow.startFrom;
    delete timeWindow.startTo;
  } else {
    delete timeWindow.to;
    delete timeWindow.endFrom;
    delete timeWindow.endTo;
  }

  return {
    ...subset,
    timeWindow
  };
}

export function facetBaseCases(cases: CaseRecord[], subset: SubsetDefinition, scope: FacetScope): CaseRecord[] {
  return filterCases(cases, subsetWithoutFacet(subset, scope));
}

export function categoricalFacetStats(cases: CaseRecord[], field: string, values: string[]): OptionStat[] {
  const denominator = Math.max(1, cases.length);
  const counts = new Map<string, number>();
  for (const caseRecord of cases) {
    const value = caseValue(caseRecord, field);
    if (value === null || value === "") continue;
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return values.map((value) => {
    const count = counts.get(value) ?? 0;
    return {
      count,
      share: count / denominator,
      value
    };
  });
}

export function numericFacetDistribution(cases: CaseRecord[], field: string, binCount = 10): FacetDistribution | null {
  return distribution(
    cases
      .map((caseRecord) => caseValue(caseRecord, field))
      .filter((value): value is number => typeof value === "number"),
    binCount
  );
}

export function dateFacetDistribution(cases: CaseRecord[], field: string, binCount = 10): FacetDistribution | null {
  return distribution(
    cases
      .map((caseRecord) => (field === "caseStart" || field === "caseEnd" ? caseRecord[field] : caseValue(caseRecord, field)))
      .filter((value): value is string => typeof value === "string")
      .map((value) => isoDateToDay(value))
      .filter((value): value is number => value !== null),
    binCount
  );
}

export function visibleBuilderAttributes(storedFields: string[], defaultFields: string[]): string[] {
  const stored = new Set(storedFields);
  const visible = defaultFields.filter((field) => stored.has(field));
  return visible.length ? visible : defaultFields;
}
