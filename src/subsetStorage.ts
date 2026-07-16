import type { CaseAttributeFilter, SubsetDefinition } from "./types";
import { attributeConfigStorageKey, colors, defaultBuilderAttributes, defaultSelectedSubsetIds, defaultSubsets, subsetStorageKey } from "./logisticsConfig";
import { visibleBuilderAttributes } from "./facetStats";
import { subsetFormula } from "./subsetDraft";

export type Page = "builder" | "analysis" | "configuration";

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function sanitizeAttributeFilter(value: unknown): CaseAttributeFilter | null {
  if (!value || typeof value !== "object") return null;
  const filter = value as Partial<CaseAttributeFilter>;
  if (typeof filter.field !== "string") return null;
  if (filter.operator === "in") {
    return { field: filter.field, operator: "in", values: stringArray(filter.values), negated: filter.negated === true };
  }
  if (filter.operator === "range") {
    return {
      field: filter.field,
      operator: "range",
      negated: filter.negated === true,
      min: typeof filter.min === "number" || typeof filter.min === "string" ? filter.min : undefined,
      max: typeof filter.max === "number" || typeof filter.max === "string" ? filter.max : undefined
    };
  }
  return null;
}

export function sanitizeDurationRange(value: unknown): SubsetDefinition["durationRangeHours"] {
  if (!value || typeof value !== "object") return undefined;
  const range = value as { min?: unknown; max?: unknown };
  return {
    min: typeof range.min === "number" ? range.min : undefined,
    max: typeof range.max === "number" ? range.max : undefined
  };
}

export function sanitizeSharedSubset(value: unknown, index: number): SubsetDefinition | null {
  if (!value || typeof value !== "object") return null;
  const subset = value as Partial<SubsetDefinition>;
  if (typeof subset.id !== "string" || typeof subset.name !== "string") return null;
  const attributeFilters = Array.isArray(subset.attributeFilters)
    ? subset.attributeFilters.map(sanitizeAttributeFilter).filter((filter): filter is CaseAttributeFilter => Boolean(filter))
    : [];
  const timeWindow =
    subset.timeWindow && typeof subset.timeWindow === "object"
      ? {
          from: typeof subset.timeWindow.from === "string" ? subset.timeWindow.from : undefined,
          to: typeof subset.timeWindow.to === "string" ? subset.timeWindow.to : undefined,
          startFrom: typeof subset.timeWindow.startFrom === "string" ? subset.timeWindow.startFrom : undefined,
          startTo: typeof subset.timeWindow.startTo === "string" ? subset.timeWindow.startTo : undefined,
          endFrom: typeof subset.timeWindow.endFrom === "string" ? subset.timeWindow.endFrom : undefined,
          endTo: typeof subset.timeWindow.endTo === "string" ? subset.timeWindow.endTo : undefined,
          invertStartRange: subset.timeWindow.invertStartRange === true,
          invertEndRange: subset.timeWindow.invertEndRange === true
        }
      : undefined;
  const descriptionFallback = subsetFormula({
    id: "shared-query-subset",
    name: subset.name,
    description: "",
    color: colors[index % colors.length],
    requiredActivities: stringArray(subset.requiredActivities),
    excludedActivities: stringArray(subset.excludedActivities),
    reworkActivities: stringArray(subset.reworkActivities),
    attributeFilters
  });
  return {
    id: subset.id,
    name: subset.name,
    description: typeof subset.description === "string" ? subset.description : descriptionFallback,
    color: isHexColor(subset.color) ? subset.color : colors[index % colors.length],
    requiredActivities: stringArray(subset.requiredActivities),
    excludedActivities: stringArray(subset.excludedActivities),
    reworkActivities: stringArray(subset.reworkActivities),
    attributeFilters,
    timeWindow,
    durationRangeHours: sanitizeDurationRange(subset.durationRangeHours)
  };
}

export function parseStoredSubsets(raw: string | null): SubsetDefinition[] {
  try {
    if (!raw) return defaultSubsets();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return defaultSubsets();
    const sanitized = parsed.map(sanitizeSharedSubset).filter((subset): subset is SubsetDefinition => Boolean(subset));
    return sanitized.length ? sanitized : defaultSubsets();
  } catch {
    return defaultSubsets();
  }
}

export function parseQuerySubsetPayload(search: string): SubsetDefinition[] {
  try {
    const raw = new URLSearchParams(search).get("subsetPayload");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item, index) => sanitizeSharedSubset(item, index))
      .filter((subset): subset is SubsetDefinition => Boolean(subset));
  } catch {
    return [];
  }
}

export function mergeInitialSubsets(stored: SubsetDefinition[], sharedSubsets: SubsetDefinition[]): SubsetDefinition[] {
  if (!sharedSubsets.length) return stored;
  const byId = new Map(stored.map((subset) => [subset.id, subset]));
  for (const subset of sharedSubsets) byId.set(subset.id, subset);
  return [...byId.values()];
}

export function loadStoredSubsets(storage: Storage = window.localStorage): SubsetDefinition[] {
  return parseStoredSubsets(storage.getItem(subsetStorageKey));
}

export function loadInitialSubsets(search = window.location.search, storage: Storage = window.localStorage): SubsetDefinition[] {
  return mergeInitialSubsets(loadStoredSubsets(storage), parseQuerySubsetPayload(search));
}

export function loadStoredBuilderAttributes(storage: Storage = window.localStorage): string[] {
  try {
    const raw = storage.getItem(attributeConfigStorageKey);
    if (!raw) return defaultBuilderAttributes;
    const parsed = JSON.parse(raw) as string[];
    return visibleBuilderAttributes(parsed, defaultBuilderAttributes);
  } catch {
    return defaultBuilderAttributes;
  }
}

export function initialPageFromQuery(search = window.location.search): Page {
  try {
    const pageValue = new URLSearchParams(search).get("page");
    if (pageValue === "builder") return "builder";
    if (pageValue === "analysis" || pageValue === "shared-dfg") return "analysis";
    if (pageValue === "configuration") return "configuration";
    return "analysis";
  } catch {
    return "analysis";
  }
}

export function queryChoice<T extends string>(name: string, allowed: readonly T[], fallback: T, search = window.location.search): T {
  try {
    const value = new URLSearchParams(search).get(name);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export function queryNumber(name: string, fallback: number, min: number, max: number, search = window.location.search): number {
  try {
    const value = Number(new URLSearchParams(search).get(name));
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  } catch {
    return fallback;
  }
}

export function querySelectedSubsetIds(search = window.location.search): string[] {
  try {
    const value = new URLSearchParams(search).get("selected");
    const ids = value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
    return ids.length ? ids : defaultSelectedSubsetIds;
  } catch {
    return defaultSelectedSubsetIds;
  }
}
