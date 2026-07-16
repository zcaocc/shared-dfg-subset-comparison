import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import {
  Card,
  Checkbox,
  Group,
  HoverCard,
  Paper,
  Progress,
  RangeSlider,
  RingProgress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Slider,
  Stack,
  Text,
  Tooltip,
  Menu,
  MultiSelect,
  Switch
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { geoMercator, geoPath } from "d3-geo";
import { Activity, ArrowDown, Box, ChevronDown, CornerRightDown, Download, Ellipsis, EyeOff, Gauge, GitCompare, Hourglass, Info, PieChart, Pin, PinOff, RefreshCw, RotateCcw, Save, SlidersHorizontal, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import { feature } from "topojson-client";
import countries110m from "world-atlas/countries-110m.json";
import type { FeatureCollection, Geometry } from "geojson";
import type {
  CaseAttributeSchema,
  CaseRecord,
  EventLog,
  SharedDfg,
  SharedDfgEdge,
  SharedDfgNode,
  SubsetDefinition,
  SubsetDfg
} from "./types";
import {
  computeDfg,
  filterCases,
  formatHours,
  formatPercent,
  mergeDfgs,
  metricOrEmpty
} from "./processMining";
import { loadEventLog } from "./dataLoader";
import { effectiveActivityScope, effectiveConnectionMode, nextManualConnectionMode } from "./appearsInMode";
import { opacityFromNormalizedValue } from "./visualEncoding";
import {
  categoricalFacetStats,
  facetBaseCases,
  numericFacetDistribution,
  type FacetDistribution,
  type OptionStat
} from "./facetStats";
import { runBrowserGraphvizLayout, type GraphvizLayoutEdgeRole, type GraphvizLayoutNodeRole, type GraphvizLayoutRequest, type GraphvizLayoutResult } from "./graphvizLayout";
import {
  deriveDefaultVisibleLimits,
  deriveSharedDfgView,
  isBoundaryActivityName,
  maxEdgeCaseShare,
  nodeAveragePosition,
  subsetIdsForEdge,
  type ActivityScope,
  type PathMode
} from "./sharedDfgView";
import {
  attributeConfigStorageKey,
  colors,
  defaultBuilderAttributes,
  defaultSubsets,
  invertibleAttributeFields,
  marketByTopoId,
  marketLabelCoordinates,
  marketLabelOffsets,
  marketTopoIds,
  realtimeFacetFields,
  subsetStorageKey,
  subsetStyleStorageKey
} from "./logisticsConfig";
import {
  attributeLabel,
  buildDraftSubset,
  builderStateFromSubset,
  createEmptyModes,
  dateRangeFromLog,
  formatRangeBound,
  generatedSubsetName,
  subsetFormula,
  type ActivityMode,
  type NumericRangeDraft
} from "./subsetDraft";
import {
  initialPageFromQuery,
  loadInitialSubsets,
  loadStoredBuilderAttributes,
  queryChoice,
  queryNumber,
  querySelectedSubsetIds,
  type Page
} from "./subsetStorage";

dayjs.extend(customParseFormat);

type ActivityLabelMetric = "caseCount" | "caseShare" | "eventCount";
type ActivityLabelDisplay = "sum" | "perSubset";
type PathMetric = "frequency" | "caseCount" | "caseShare" | "avgWaitingTime" | "medianWaitingTime" | "sumWaitingTime";
type PathDensityMode = "auto" | "manual";
type ComputeMode = "local" | "server";
type LinePattern = "solid" | "dashed" | "dotted" | "dashdot";
type PathShape = "straight" | "curved" | "elbow";
type WidthMetric = PathMetric;
type WidthScale = "linear" | "log10" | "sqrt" | "exponential";
const API_TOKEN = String(import.meta.env.VITE_PMT_API_TOKEN ?? "").trim();
const STUDY_ACCESS_PARAM = "shareddfgsurvey";
const STUDY_ACCESS_STORAGE_KEY = "pmt-study-access-granted";

function apiJsonHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;
  return headers;
}

async function fetchServerDfgs(body: string, signal: AbortSignal): Promise<{ engine: string; subsetDfgs: SubsetDfg[] }> {
  const response = await fetch("/api/mine", {
    body,
    headers: apiJsonHeaders(),
    method: "POST",
    signal
  });
  if (!response.ok) throw new Error(await response.text());
  const data = (await response.json()) as { engine?: string; subsetDfgs?: SubsetDfg[] };
  if (!data.subsetDfgs?.length) throw new Error("Backend returned no subset DFGs.");
  return {
    engine: data.engine ?? "Vercel API",
    subsetDfgs: data.subsetDfgs
  };
}

function hasStoredStudyAccess(): boolean {
  try {
    return window.sessionStorage.getItem(STUDY_ACCESS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function grantStudyAccessFromUrl(): boolean {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("access") !== STUDY_ACCESS_PARAM) return false;
    try {
      window.sessionStorage.setItem(STUDY_ACCESS_STORAGE_KEY, "true");
    } catch {
      // Allow the current survey session even if storage is unavailable.
    }
    url.searchParams.delete("access");
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl || "/");
    return true;
  } catch {
    return false;
  }
}

function initialStudyAccessGranted(): boolean {
  return import.meta.env.DEV || hasStoredStudyAccess() || grantStudyAccessFromUrl();
}

type NumericDistribution = {
  avg: number;
  bins: number[];
  count: number;
  max: number;
  median: number;
  min: number;
} | null;
type SubsetVisualStyle = {
  color: string;
  linePattern: LinePattern;
  pathShape: PathShape;
};
type DetailSelection =
  | { type: "node"; activity: string }
  | { type: "edge"; edgeId: string; source: string; target: string }
  | null;
type ActivePopover =
  | ({ maxHeight: number; x: number; y: number } & Exclude<DetailSelection, null>)
  | null;
type PinnedEdge = { edgeId: string; source: string; target: string };
type GraphNodeDrag = {
  activities: string[];
  clientX: number;
  clientY: number;
  positions: Record<string, { x: number; y: number }>;
};
type GraphSelectionDrag = {
  startGraphX: number;
  startGraphY: number;
  currentGraphX: number;
  currentGraphY: number;
};
type ConnectionStrokeStyle = {
  dashArray: string;
  width: number;
};
type StrokeWidthRange = {
  max: number;
  min: number;
};
type DashPattern = {
  dash: number;
  gap: number;
};
const defaultPathShape: PathShape = "elbow";
const defaultActivityCaseShareThreshold = 0.05;
const defaultPathCaseShareThreshold = 0.02;
const defaultArcCurvature = 0.5;
const defaultComputeMode: ComputeMode = "local";
const svgWidth = 1580;
const svgHeight = 1420;
const graphPanPadding = 220;
const maxActivityCaseShareThresholdPercent = 100;
const maxPathCaseShareThresholdPercent = 100;
const connectionStrokeWidthRange: StrokeWidthRange = { min: 1.5, max: 10 };
const boundaryLinkStrokeWidthRange: StrokeWidthRange = { min: 2, max: 5 };
const connectionDashPatterns = {
  dashed: { dash: 1.5, gap: 2 },
  dotted: { dash: 0.01, gap: 2 },
  dashdot: { dash: 2, dotGap: 1.5, gap: 1.5 }
} satisfies Record<Exclude<LinePattern, "solid">, DashPattern | { dash: number; dotGap: number; gap: number }>;
const boundaryLinkDashPattern: DashPattern = { dash: 0.9, gap: 2.8 };
const nodeHalfWidth = 58;
const nodeHalfHeight = 31;
const boundaryNodeRadius = 16;
const edgeLaneSpacing = 10;
const graphPopoverWidth = 340;
const graphPopoverEstimatedHeight = 380;
const caseDurationField = "caseDurationHours";
const hoursPerDay = 24;
function numericMax(log: EventLog | null, field: string): number {
  if (!log) return 0;
  const schema = log.schema.caseAttributes.find((item) => item.name === field);
  return typeof schema?.max === "number" ? schema.max : 0;
}

function numericMin(log: EventLog | null, field: string): number {
  if (!log) return 0;
  const schema = log.schema.caseAttributes.find((item) => item.name === field);
  return typeof schema?.min === "number" ? schema.min : 0;
}

function caseAttributeValue(caseRecord: CaseRecord, field: string): string | number | null {
  if (field === "caseDurationHours") return caseRecord.caseDurationHours;
  return caseRecord.attributes[field] ?? null;
}

function nullAttributeCount(cases: CaseRecord[], field: string): number {
  return cases.filter((caseRecord) => {
    const value = caseAttributeValue(caseRecord, field);
    return value === null || value === "";
  }).length;
}

function nullAttributeCountsByField(cases: CaseRecord[], fields: string[]): Map<string, number> {
  const counts = new Map(fields.map((field) => [field, 0]));
  if (!fields.length) return counts;

  for (const caseRecord of cases) {
    for (const field of fields) {
      const value = caseAttributeValue(caseRecord, field);
      if (value === null || value === "") {
        counts.set(field, (counts.get(field) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function attributeOptionValues(log: EventLog, field: string, schemaValues?: string[]): string[] {
  if (schemaValues?.length) return schemaValues;
  const values = log.cases
    .map((caseRecord) => caseAttributeValue(caseRecord, field))
    .filter((value): value is string | number => value !== null && value !== "")
    .map(String);
  const unique = [...new Set(values)];
  return field === "salesCompany" ? unique.sort((a, b) => Number(a) - Number(b)) : unique.sort((a, b) => a.localeCompare(b));
}

function optionStatsWithoutCounts(values: string[]): OptionStat[] {
  return values.map((value) => ({ count: 0, share: 0, value }));
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatFloat(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value)) return new Intl.NumberFormat("en-US").format(value);
  const absValue = Math.abs(value);
  if (absValue > 0 && absValue < 0.1) {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);
  }
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1
  }).format(value);
}

function isIsoDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function formatDateForDisplay(value: string | undefined): string {
  if (!value) return "";
  const date = value.slice(0, 10);
  if (!isIsoDateOnly(date)) return value;
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

function formatNumericInputValue(value: string): string {
  if (!value.trim()) return "";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  if (Number.isInteger(parsed)) return String(parsed);
  const absValue = Math.abs(parsed);
  if (absValue > 0 && absValue < 0.1) return String(Number(parsed.toFixed(3)));
  return parsed.toFixed(1);
}

function numericFacetDisplayLabel(field: string, fallback: string): string {
  return field === caseDurationField ? "Case duration (days)" : fallback;
}

function numericValueForDisplay(field: string, value: number): number {
  return field === caseDurationField ? value / hoursPerDay : value;
}

function numericRangeForDisplay(field: string, range: NumericRangeDraft): NumericRangeDraft {
  if (field !== caseDurationField) return range;
  const min = Number(range.min);
  const max = Number(range.max);
  return {
    min: range.min === "" || !Number.isFinite(min) ? "" : formatNumericInputValue(String(min / hoursPerDay)),
    max: range.max === "" || !Number.isFinite(max) ? "" : formatNumericInputValue(String(max / hoursPerDay))
  };
}

function numericInputForStoredValue(field: string, value: string): string {
  if (field !== caseDurationField || value === "") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? formatNumericInputValue(String(parsed * hoursPerDay)) : value;
}

function numericDistributionForDisplay(field: string, distribution: FacetDistribution | null): FacetDistribution | null {
  if (field !== caseDurationField || !distribution) return distribution;
  return {
    ...distribution,
    avg: distribution.avg / hoursPerDay,
    max: distribution.max / hoursPerDay,
    median: distribution.median / hoursPerDay,
    min: distribution.min / hoursPerDay
  };
}

function hexToRgb(hex: unknown): { r: number; g: number; b: number } | null {
  if (typeof hex !== "string") return null;
  const normalized = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16)
  };
}

function subsetTint(hex: unknown, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(63, 111, 166, ${alpha})`;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function readableSubsetTextColor(hex: unknown): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#2f5b8f";
  const darken = 0.62;
  return `rgb(${Math.round(rgb.r * darken)}, ${Math.round(rgb.g * darken)}, ${Math.round(rgb.b * darken)})`;
}

function activityMetricLabel(metric: ActivityLabelMetric, display: ActivityLabelDisplay): string {
  void display;
  if (metric === "caseShare") return "Case coverage";
  return metric === "eventCount" ? "Event count" : "Case count";
}

function linePatternLabel(pattern: LinePattern): string {
  if (pattern === "dashed") return "Dashed";
  if (pattern === "dotted") return "Dotted";
  if (pattern === "dashdot") return "Dash-dot";
  return "Solid";
}

function validLinePattern(value: unknown): value is LinePattern {
  return value === "solid" || value === "dashed" || value === "dotted" || value === "dashdot";
}

function validPathShape(value: unknown): value is PathShape {
  return value === "straight" || value === "curved" || value === "elbow";
}

function dashLength(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function lineDashArray(pattern: LinePattern, strokeWidth: number): string {
  const width = Math.max(1, strokeWidth);
  if (pattern === "solid") return "";
  const dashPattern = connectionDashPatterns[pattern];
  if ("dotGap" in dashPattern) {
    return `${dashLength(width * dashPattern.dash)} ${dashLength(width * dashPattern.gap)} 0.01 ${dashLength(width * dashPattern.dotGap)}`;
  }
  if (dashPattern.dash === 0.01) return `0.01 ${dashLength(width * dashPattern.gap)}`;
  return `${dashLength(width * dashPattern.dash)} ${dashLength(width * dashPattern.gap)}`;
}

function boundaryDashArray(strokeWidth: number): string {
  const width = Math.max(1, strokeWidth);
  return `${dashLength(width * boundaryLinkDashPattern.dash)} ${dashLength(width * boundaryLinkDashPattern.gap)}`;
}

function strokeWidthForMetric(
  metrics: { count: number; caseCount: number; caseShare: number; avgWaitingHours: number | null; medianWaitingHours: number | null; sumWaitingHours: number | null },
  widthMetric: WidthMetric,
  widthScale: WidthScale,
  maxValue: number,
  range: StrokeWidthRange
): number {
  const value = edgeWidthValue(metrics, widthMetric);
  if (value <= 0 || maxValue <= 0) return range.min;
  let scaled = value / maxValue;
  if (widthScale === "log10") scaled = Math.log10(value + 1) / Math.log10(maxValue + 1);
  if (widthScale === "sqrt") scaled = Math.sqrt(scaled);
  if (widthScale === "exponential") scaled = scaled ** 2;
  const normalized = Math.min(1, Math.max(0, scaled));
  return range.min + normalized * (range.max - range.min);
}

function connectionStrokeStyle(
  metrics: { count: number; caseCount: number; caseShare: number; avgWaitingHours: number | null; medianWaitingHours: number | null; sumWaitingHours: number | null },
  widthMetric: WidthMetric,
  widthScale: WidthScale,
  maxValue: number,
  linePattern: LinePattern,
  isBoundaryLink: boolean
): ConnectionStrokeStyle {
  const width = strokeWidthForMetric(metrics, widthMetric, widthScale, maxValue, isBoundaryLink ? boundaryLinkStrokeWidthRange : connectionStrokeWidthRange);
  return {
    dashArray: isBoundaryLink ? boundaryDashArray(width) : lineDashArray(linePattern, width),
    width
  };
}

function widthMetricLabel(metric: WidthMetric): string {
  if (metric === "caseCount") return "Case count";
  if (metric === "caseShare") return "Case coverage";
  if (metric === "avgWaitingTime") return "Avg waiting time";
  if (metric === "medianWaitingTime") return "Median waiting time";
  if (metric === "sumWaitingTime") return "Sum waiting time";
  return "Connection count";
}

function metricIconType(metric: ActivityLabelMetric | PathMetric): "count" | "ratio" | "time" {
  if (metric === "caseShare") return "ratio";
  if (metric === "avgWaitingTime" || metric === "medianWaitingTime" || metric === "sumWaitingTime") return "time";
  return "count";
}

function MetricTypeIcon({ metric, size = 14 }: { metric: ActivityLabelMetric | PathMetric; size?: number }) {
  const type = metricIconType(metric);
  if (type === "ratio") return <PieChart size={size} strokeWidth={2.2} />;
  if (type === "time") return <Hourglass size={size} strokeWidth={2.2} />;
  return <Gauge size={size} strokeWidth={2.2} />;
}

function MetricSelectOption({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-select-option">
      <MetricTypeIcon metric={value as ActivityLabelMetric | PathMetric} />
      <span>{label}</span>
    </div>
  );
}

function ConnectionWidthIcon({ size = 16 }: { size?: number }) {
  return (
    <svg className="connection-width-icon" height={size} viewBox="0 0 24 24" width={size} aria-hidden="true">
      <path d="M4 7H20" />
      <path d="M4 12H20" />
      <path d="M4 17H20" />
    </svg>
  );
}

function widthScaleLabel(scale: WidthScale): string {
  if (scale === "log10") return "10-based magnitude";
  if (scale === "sqrt") return "Square root";
  if (scale === "exponential") return "Exponential";
  return "Linear";
}

const widthScaleOptions: { value: WidthScale; label: string }[] = [
  { value: "exponential", label: "Exponential" },
  { value: "linear", label: "Linear" },
  { value: "sqrt", label: "Square root" },
  { value: "log10", label: "10-based magnitude" }
];

const pathShapeOptions: { value: PathShape; label: string }[] = [
  { value: "elbow", label: "Elbow" },
  { value: "straight", label: "Straight" },
  { value: "curved", label: "Curved" }
];

const activityVisibilityOptions: { value: ActivityScope; label: string }[] = [
  { value: "all", label: "Any Selected Subset" },
  { value: "common", label: "Shared by All Selected Subsets" },
  { value: "specific", label: "Unique to One Subset" }
];

const connectionVisibilityOptions: { value: PathMode; label: string }[] = [
  { value: "all", label: "Any Selected Subset" },
  { value: "shared", label: "Shared by All Selected Subsets" },
  { value: "specific", label: "Unique to One Subset" }
];

function clampPercent(value: number, max = 100): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.round(value)));
}

const widthScaleSensitivityLabels: Record<WidthScale, string> = {
  exponential: "Most sensitive",
  linear: "Direct change",
  sqrt: "Compressed",
  log10: "Most compressed"
};

function WidthScaleSparkline({ scale }: { scale: WidthScale }) {
  const path =
    scale === "exponential"
      ? "M2 22 C11 22 19 21 28 4"
      : scale === "sqrt"
        ? "M2 22 C7 10 17 5 28 4"
        : scale === "log10"
          ? "M2 22 C5 7 17 4 28 4"
          : "M2 22 L28 4";

  return (
    <span className="width-scale-sparkline" aria-hidden="true">
      <svg viewBox="0 0 30 24" role="img">
        <path d={path} />
        <polyline points="25,4 28,4 28,7" />
      </svg>
    </span>
  );
}

function PathShapePreview({ shape }: { shape: PathShape }) {
  return (
    <span className="path-shape-preview" aria-hidden="true">
      <svg viewBox="0 0 52 20" role="img">
        <path d={legendPathShape(shape)} />
      </svg>
    </span>
  );
}

function PathShapeOption({ label, shape }: { label: string; shape: PathShape }) {
  return (
    <div className="path-shape-option">
      <PathShapePreview shape={shape} />
      <span>{label}</span>
    </div>
  );
}

function formatDays(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return `${value.toFixed(1)}d`;
}

function legendPathShape(shape: PathShape): string {
  if (shape === "straight") return "M 2 4 L 44 4";
  if (shape === "elbow") return "M 2 6 L 23 6 L 23 2 L 44 2";
  return "M 2 6 C 14 0, 32 0, 44 6";
}

function formatPathMetric(
  metrics: { count: number; caseCount: number; caseShare: number; avgWaitingHours: number | null; medianWaitingHours: number | null; sumWaitingHours: number | null },
  metric: PathMetric
): string {
  if (metric === "caseCount") return `${formatNumber(metrics.caseCount)} cases`;
  if (metric === "caseShare") return formatPercent(metrics.caseShare);
  if (metric === "avgWaitingTime") return formatHours(metrics.avgWaitingHours);
  if (metric === "medianWaitingTime") return formatHours(metrics.medianWaitingHours);
  if (metric === "sumWaitingTime") return formatHours(metrics.sumWaitingHours);
  return `${formatNumber(metrics.count)}x`;
}

function formatActivityMetric(metrics: { eventCount: number; caseCount: number; caseShare: number }, metric: ActivityLabelMetric): string {
  if (metric === "caseShare") return formatPercent(metrics.caseShare);
  return formatNumber(metric === "eventCount" ? metrics.eventCount : metrics.caseCount);
}

function aggregateNodeMetric(node: SharedDfgNode, selectedIds: string[], metric: ActivityLabelMetric): string {
  const metrics = selectedIds.map((id) => node.metricsBySubset[id]).filter(Boolean);
  if (!metrics.length) return "";
  if (metric === "caseShare") return formatPercent(Math.max(...metrics.map((item) => item.caseShare)));
  const caseCount = metrics.reduce((sum, item) => sum + item.caseCount, 0);
  const eventCount = metrics.reduce((sum, item) => sum + item.eventCount, 0);
  return formatNumber(metric === "eventCount" ? eventCount : caseCount);
}

function defaultSubsetStyle(subset: SubsetDefinition, index: number): SubsetVisualStyle {
  const safeIndex = Math.max(0, index);
  return {
    color: typeof subset.color === "string" && hexToRgb(subset.color) ? subset.color : colors[safeIndex % colors.length],
    linePattern: "solid",
    pathShape: defaultPathShape
  };
}

function subsetStyle(subset: SubsetDefinition, index: number, styles: Record<string, Partial<SubsetVisualStyle>>): SubsetVisualStyle {
  const defaults = defaultSubsetStyle(subset, index);
  const stored = styles[subset.id] ?? {};
  return {
    color: typeof stored.color === "string" && hexToRgb(stored.color) ? stored.color : defaults.color,
    linePattern: validLinePattern(stored.linePattern) ? stored.linePattern : defaults.linePattern,
    pathShape: validPathShape(stored.pathShape) ? stored.pathShape : defaults.pathShape
  };
}

function edgeWidthValue(
  metrics: { count: number; caseCount: number; caseShare: number; avgWaitingHours: number | null; medianWaitingHours: number | null; sumWaitingHours: number | null },
  metric: WidthMetric
): number {
  if (metric === "caseCount") return metrics.caseCount;
  if (metric === "caseShare") return metrics.caseShare;
  if (metric === "avgWaitingTime") return metrics.avgWaitingHours ?? 0;
  if (metric === "medianWaitingTime") return metrics.medianWaitingHours ?? 0;
  if (metric === "sumWaitingTime") return metrics.sumWaitingHours ?? 0;
  return metrics.count;
}

function edgeStrokeWidth(
  metrics: { count: number; caseCount: number; caseShare: number; avgWaitingHours: number | null; medianWaitingHours: number | null; sumWaitingHours: number | null },
  widthMetric: WidthMetric,
  widthScale: WidthScale,
  maxValue: number
): number {
  return strokeWidthForMetric(metrics, widthMetric, widthScale, maxValue, connectionStrokeWidthRange);
}

function edgeOpacity(
  metrics: { count: number; caseCount: number; caseShare: number; avgWaitingHours: number | null; medianWaitingHours: number | null; sumWaitingHours: number | null },
  opacityMetric: PathMetric,
  maxValue: number
): number {
  const value = edgeWidthValue(metrics, opacityMetric);
  const normalized = opacityMetric === "caseShare" ? value : maxValue > 0 ? value / maxValue : 1;
  return opacityFromNormalizedValue(normalized);
}

function loadStoredSubsetStyles(): Record<string, Partial<SubsetVisualStyle>> {
  try {
    const raw = window.localStorage.getItem(subsetStyleStorageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<SubsetVisualStyle>>;
    return Object.fromEntries(
      Object.entries(parsed).map(([id, style]) => {
        const safeStyle = style && typeof style === "object" ? style : {};
        return [
          id,
          {
            color: typeof safeStyle.color === "string" && hexToRgb(safeStyle.color) ? safeStyle.color : undefined,
            linePattern: validLinePattern(safeStyle.linePattern) ? safeStyle.linePattern : undefined,
            pathShape: validPathShape(safeStyle.pathShape) ? safeStyle.pathShape : undefined
          }
        ];
      })
    );
  } catch {
    return {};
  }
}

function persistSubsetStyles(styles: Record<string, Partial<SubsetVisualStyle>>) {
  try {
    window.localStorage.setItem(subsetStyleStorageKey, JSON.stringify(styles));
  } catch {
    /* Ignore private browsing storage errors. */
  }
}

function medianNumber(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function numericDistributionFromValues(values: number[]): NumericDistribution {
  if (!values.length) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(0.001, max - min);
  const binCount = 12;
  const bins = Array.from({ length: binCount }, () => 0);
  for (const value of values) {
    const index = Math.min(binCount - 1, Math.floor(((value - min) / range) * binCount));
    bins[index] += 1;
  }
  return {
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    bins,
    count: values.length,
    max,
    median: medianNumber(values),
    min
  };
}

function transportTimeDistribution(cases: CaseRecord[]): NumericDistribution {
  const values = cases
    .map((caseRecord) => caseRecord.attributes.transportationTimeDays)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!values.length) return null;
  const bins = Array.from({ length: 10 }, () => 0);
  const regularBins = bins.length - 1;
  for (const value of values) {
    const index = value >= 90 ? regularBins : Math.max(0, Math.min(regularBins - 1, Math.floor(value / 10)));
    bins[index] += 1;
  }
  return {
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    bins,
    count: values.length,
    max: Math.max(...values),
    median: medianNumber(values),
    min: Math.min(...values)
  };
}

function activityPreviewRows(
  metrics: Map<string, { caseCount: number; eventCount: number }>
): Array<{ activity: string; count: number; kind: "activity" | "gap" }> {
  const rows = Array.from(metrics.entries())
    .map(([activity, summary]) => ({ activity, count: summary.eventCount, kind: "activity" as const }))
    .sort((a, b) => b.count - a.count || a.activity.localeCompare(b.activity));

  if (rows.length <= 8) return rows;

  const top = rows.slice(0, 5);
  const bottom = [...rows].sort((a, b) => a.count - b.count || a.activity.localeCompare(b.activity)).slice(0, 3);
  return [...top, { activity: "Other activities", count: 0, kind: "gap" as const }, ...bottom.reverse()];
}

function builderPreviewSummary(cases: CaseRecord[]) {
  const activityMetrics = new Map<string, { caseCount: number; eventCount: number }>();
  const transportValues: number[] = [];
  const noticeValues: number[] = [];
  let previewEvents = 0;

  for (const caseRecord of cases) {
    previewEvents += caseRecord.events.length;

    const transportTime = caseRecord.attributes.transportationTimeDays;
    if (typeof transportTime === "number" && Number.isFinite(transportTime)) {
      transportValues.push(transportTime);
    }

    const noticeBuffer = caseRecord.attributes.advanceNoticeTimeDays;
    if (typeof noticeBuffer === "number" && Number.isFinite(noticeBuffer)) {
      noticeValues.push(noticeBuffer);
    }

    const caseActivities = new Set<string>();
    for (const event of caseRecord.events) {
      caseActivities.add(event.activity);
      const summary = activityMetrics.get(event.activity) ?? { caseCount: 0, eventCount: 0 };
      summary.eventCount += 1;
      activityMetrics.set(event.activity, summary);
    }
    for (const activity of caseActivities) {
      const summary = activityMetrics.get(activity) ?? { caseCount: 0, eventCount: 0 };
      summary.caseCount += 1;
      activityMetrics.set(activity, summary);
    }
  }

  const activityPreview = activityPreviewRows(activityMetrics);
  return {
    activityMetrics,
    activityPreview,
    maxPreviewActivityCount: Math.max(1, ...activityPreview.map((item) => item.count)),
    noticeBufferStats: numericDistributionFromValues(noticeValues),
    previewEvents,
    transportTimeStats: numericDistributionFromValues(transportValues)
  };
}

function dateToDay(value: string): number {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 86400000);
}

function dayToDate(day: number): string {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function parseEuropeanDateInput(value: string): string | null {
  if (!value.trim()) return null;
  const parsed = dayjs(value.trim(), ["DD/MM/YYYY", "D/M/YYYY", "YYYY-MM-DD"], true);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : null;
}

function isBusinessPath(edge: Pick<SharedDfgEdge, "source" | "target">): boolean {
  return !isBoundaryActivityName(edge.source) && !isBoundaryActivityName(edge.target);
}

function isBoundaryLink(edge: Pick<SharedDfgEdge, "source" | "target">): boolean {
  return isBoundaryActivityName(edge.source) || isBoundaryActivityName(edge.target);
}

function countBusinessConnections(cases: CaseRecord[]): number {
  const connections = new Set<string>();
  for (const caseRecord of cases) {
    for (let index = 0; index < caseRecord.events.length - 1; index += 1) {
      const source = caseRecord.events[index]?.activity;
      const target = caseRecord.events[index + 1]?.activity;
      if (source && target) {
        connections.add(`${source}__${target}`);
      }
    }
  }
  return connections.size;
}

function formatThresholdPercent(value: number): string {
  return (value * 100).toFixed(1);
}

function App() {
  const [studyAccessGranted] = useState(initialStudyAccessGranted);
  const [page, setPage] = useState<Page>(initialPageFromQuery);
  const [log, setLog] = useState<EventLog | null>(null);
  const [loadError, setLoadError] = useState("");
  const [subsets, setSubsets] = useState<SubsetDefinition[]>(loadInitialSubsets);
  const [selectedIds, setSelectedIds] = useState<string[]>(querySelectedSubsetIds);
  const [notice, setNotice] = useState("");
  const [activityModes, setActivityModes] = useState<Record<string, ActivityMode>>({});
  const [subsetName, setSubsetName] = useState("All cases");
  const [subsetDescription, setSubsetDescription] = useState("all cases");
  const [builderAttributeFields, setBuilderAttributeFields] = useState<string[]>(loadStoredBuilderAttributes);
  const [attributeValues, setAttributeValues] = useState<Record<string, string[]>>({});
  const [invertedAttributes, setInvertedAttributes] = useState<Record<string, boolean>>({});
  const [numericRanges, setNumericRanges] = useState<Record<string, NumericRangeDraft>>({});
  const [startDateRange, setStartDateRange] = useState<NumericRangeDraft>({ min: "", max: "" });
  const [endDateRange, setEndDateRange] = useState<NumericRangeDraft>({ min: "", max: "" });
  const [invertedDateRanges, setInvertedDateRanges] = useState({ start: false, end: false });
  const [activityCaseShareThreshold, setActivityCaseShareThreshold] = useState(() => queryNumber("activityThreshold", defaultActivityCaseShareThreshold * 100, 0, maxActivityCaseShareThresholdPercent) / 100);
  const [pathCaseShareThreshold, setPathCaseShareThreshold] = useState(() => queryNumber("pathThreshold", defaultPathCaseShareThreshold * 100, 0, maxPathCaseShareThresholdPercent) / 100);
  const [activityScope, setActivityScope] = useState<ActivityScope>(() => queryChoice("activityScope", ["all", "common", "specific"], "all"));
  const [maxVisibleActivities, setMaxVisibleActivities] = useState(() => queryNumber("activityLimit", 16, 4, 32));
  const [maxVisiblePaths, setMaxVisiblePaths] = useState(() => queryNumber("pathLimit", 36, 6, 80));
  const [pathMode, setPathMode] = useState<PathMode>(() => queryChoice("pathMode", ["all", "shared", "specific"], "all"));
  const [activityLabelMetric, setActivityLabelMetric] = useState<ActivityLabelMetric>("caseShare");
  const [activityLabelDisplay, setActivityLabelDisplay] = useState<ActivityLabelDisplay>("perSubset");
  const [pathLabelMetric, setPathLabelMetric] = useState<PathMetric>("caseShare");
  const [globalPathShape, setGlobalPathShape] = useState<PathShape>(() => queryChoice("shape", ["straight", "curved", "elbow"], "elbow"));
  const [edgeWidthMetric, setEdgeWidthMetric] = useState<WidthMetric>("frequency");
  const [edgeWidthScale, setEdgeWidthScale] = useState<WidthScale>("linear");
  const [arcCurvature, setArcCurvature] = useState(defaultArcCurvature);
  const [computeMode, setComputeMode] = useState<ComputeMode>(defaultComputeMode);
  const [computeFallbackActive, setComputeFallbackActive] = useState(false);
  const [backendDfgs, setBackendDfgs] = useState<SubsetDfg[] | null>(null);
  const [backendDfgSignature, setBackendDfgSignature] = useState("");
  const [backendStatus, setBackendStatus] = useState("Local compute active.");
  const [subsetStyles, setSubsetStyles] = useState<Record<string, Partial<SubsetVisualStyle>>>(loadStoredSubsetStyles);
  const [, setLayoutStatus] = useState("");
  const [pinnedActivities, setPinnedActivities] = useState<string[]>([]);
  const [pinnedPaths, setPinnedPaths] = useState<PinnedEdge[]>([]);
  const [graphResetToken, setGraphResetToken] = useState(0);
  const skipNextBuilderAutoText = useRef(false);
  const previousSelectedSubsetSignature = useRef<string | null>(null);
  const initializedAnalysisSignatures = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!studyAccessGranted) return;
    loadEventLog()
      .then((data: EventLog) => {
        setLog(data);
        setActivityModes(createEmptyModes(data.activities));
        const fullRange = dateRangeFromLog(data);
        setStartDateRange(fullRange);
        setEndDateRange(fullRange);
      })
      .catch((error) => setLoadError(String(error)));
  }, [studyAccessGranted]);

  useEffect(() => {
    window.localStorage.setItem(subsetStorageKey, JSON.stringify(subsets));
  }, [subsets]);

  useEffect(() => {
    window.localStorage.setItem(attributeConfigStorageKey, JSON.stringify(builderAttributeFields));
  }, [builderAttributeFields]);

  useEffect(() => {
    persistSubsetStyles(subsetStyles);
  }, [subsetStyles]);

  useEffect(() => {
    const validIds = new Set(subsets.map((subset) => subset.id));
    setSelectedIds((current) => {
      const next = current.filter((id) => validIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [subsets]);

  const draftSubset = useMemo<SubsetDefinition>(() => {
    return buildDraftSubset({
      activityModes,
      attributeValues,
      builderAttributeFields,
      color: colors[subsets.length % colors.length],
      endDateRange,
      invertedAttributes,
      invertedDateRanges,
      log,
      numericRanges,
      startDateRange,
      subsetDescription,
      subsetName
    });
  }, [
    activityModes,
    attributeValues,
    builderAttributeFields,
    invertedAttributes,
    invertedDateRanges.end,
    invertedDateRanges.start,
    log,
    numericRanges,
    subsetDescription,
    subsetName,
    subsets.length,
    startDateRange,
    endDateRange
  ]);

  const previewCases = useMemo(() => (log ? filterCases(log.cases, draftSubset) : []), [draftSubset, log]);
  const autoSubsetName = useMemo(() => generatedSubsetName(log, draftSubset), [draftSubset, log]);
  const autoSubsetDescription = useMemo(() => subsetFormula(draftSubset, log), [draftSubset, log]);

  useEffect(() => {
    if (skipNextBuilderAutoText.current) {
      skipNextBuilderAutoText.current = false;
      return;
    }
    setSubsetName(autoSubsetName);
    setSubsetDescription(autoSubsetDescription);
  }, [autoSubsetDescription, autoSubsetName]);

  const selectedSubsets = useMemo(() => subsets.filter((subset) => selectedIds.includes(subset.id)), [selectedIds, subsets]);
  const selectedSubsetSignature = useMemo(() => {
    const validIds = new Set(subsets.map((subset) => subset.id));
    return selectedIds.filter((id) => validIds.has(id)).join("|");
  }, [selectedIds, subsets]);
  const analysisInitializationSignature = selectedSubsetSignature || "__none__";

  function resetSharedDfgDefaults() {
    setGlobalPathShape(defaultPathShape);
    setArcCurvature(defaultArcCurvature);
    setActivityScope("all");
    setPathMode("all");
    setActivityCaseShareThreshold(defaultActivityCaseShareThreshold);
    setPathCaseShareThreshold(defaultPathCaseShareThreshold);
    setComputeMode(defaultComputeMode);
    setComputeFallbackActive(false);
    setBackendDfgs(null);
    setBackendStatus("Local compute active.");
    setActivityLabelMetric("caseShare");
    setActivityLabelDisplay("perSubset");
    setPathLabelMetric("caseShare");
    setEdgeWidthMetric("frequency");
    setEdgeWidthScale("linear");
    setPinnedActivities([]);
    setPinnedPaths([]);
    setGraphResetToken((current) => current + 1);
  }

  useEffect(() => {
    if (previousSelectedSubsetSignature.current === null) {
      previousSelectedSubsetSignature.current = selectedSubsetSignature;
      return;
    }
    if (previousSelectedSubsetSignature.current === selectedSubsetSignature) return;
    previousSelectedSubsetSignature.current = selectedSubsetSignature;
    initializedAnalysisSignatures.current.add(analysisInitializationSignature);
    resetSharedDfgDefaults();
  }, [analysisInitializationSignature, selectedSubsetSignature]);

  useEffect(() => {
    if (page !== "analysis") return;
    if (initializedAnalysisSignatures.current.has(analysisInitializationSignature)) return;
    initializedAnalysisSignatures.current.add(analysisInitializationSignature);
    resetSharedDfgDefaults();
  }, [analysisInitializationSignature, page]);

  const shouldUseLocalDfg = computeMode !== "server" || computeFallbackActive;
  const localDfgs = useMemo<SubsetDfg[] | null>(() => {
    if (!log || !shouldUseLocalDfg) return null;
    return selectedSubsets.map((subset) => computeDfg(subset, filterCases(log.cases, subset)));
  }, [log, selectedSubsets, shouldUseLocalDfg]);
  const backendMineSignature = useMemo(() => JSON.stringify({ subsets: selectedSubsets, miner: "directly-follows" }), [selectedSubsets]);

  const activateLocalFallback = useCallback(() => {
    setBackendDfgs(null);
    setBackendDfgSignature("");
    setComputeFallbackActive(true);
    setComputeMode("local");
    setBackendStatus("Local fallback active.");
  }, []);

  const changeComputeMode = useCallback((value: ComputeMode) => {
    setComputeFallbackActive(false);
    setComputeMode(value);
    if (value === "local") {
      setBackendDfgs(null);
      setBackendDfgSignature("");
      setBackendStatus("Local compute active.");
    } else {
      setBackendStatus("Server compute active.");
    }
  }, []);

  useEffect(() => {
    if (computeMode !== "server") {
      setBackendStatus(computeFallbackActive ? "Local fallback active." : "Local compute active.");
      return;
    }
    if (!selectedSubsets.length) {
      setBackendDfgs(null);
      setBackendStatus("Select subsets before using Server compute.");
      return;
    }

    const controller = new AbortController();
    setBackendDfgs(null);
    setBackendDfgSignature("");
    setBackendStatus("Requesting Server DFG compute...");
    fetchServerDfgs(backendMineSignature, controller.signal)
      .then(({ engine, subsetDfgs }) => {
        setBackendDfgs(subsetDfgs);
        setBackendDfgSignature(backendMineSignature);
        setComputeFallbackActive(false);
        setBackendStatus(`Server compute ready via ${engine}.`);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        activateLocalFallback();
      });

    return () => controller.abort();
  }, [activateLocalFallback, backendMineSignature, computeFallbackActive, computeMode, selectedSubsets.length]);

  const subsetDfgs =
    computeMode === "server" && backendDfgSignature === backendMineSignature && backendDfgs?.length === selectedSubsets.length
      ? backendDfgs
      : localDfgs ?? [];
  const sharedDfg = useMemo(() => mergeDfgs(subsetDfgs), [subsetDfgs]);

  function changeActivityScope(nextScope: ActivityScope) {
    setActivityScope(nextScope);
    if (nextScope === "specific") setPathMode("specific");
  }

  function changePathMode(nextMode: PathMode) {
    if (nextMode === "shared") setActivityScope("common");
    setPathMode((current) => nextManualConnectionMode(nextMode === "shared" ? "common" : activityScope, current, nextMode));
  }

  function setActivityMode(activity: string, mode: ActivityMode) {
    setActivityModes((current) => ({ ...current, [activity]: current[activity] === mode ? "ignore" : mode }));
  }

  function toggleAttributeValue(field: string, value: string) {
    setAttributeValues((current) => {
      const selected = current[field] ?? [];
      const values = selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value];
      return { ...current, [field]: values };
    });
  }

  function setAttributeValueList(field: string, values: string[]) {
    setAttributeValues((current) => ({ ...current, [field]: values }));
  }

  function toggleAttributeInversion(field: string) {
    setInvertedAttributes((current) => ({ ...current, [field]: !current[field] }));
  }

  function setNumericRange(field: string, side: keyof NumericRangeDraft, value: string) {
    setNumericRanges((current) => {
      const existing = current[field];
      const next: NumericRangeDraft = { min: existing?.min ?? "", max: existing?.max ?? "" };
      next[side] = value;
      return { ...current, [field]: next };
    });
  }

  function toggleBuilderAttribute(field: string) {
    setBuilderAttributeFields((current) => {
      if (current.includes(field)) return current.filter((item) => item !== field);
      return [...current, field];
    });
  }

  function updateSubsetStyle(subsetId: string, patch: Partial<SubsetVisualStyle>) {
    setSubsetStyles((current) => ({ ...current, [subsetId]: { ...current[subsetId], ...patch } }));
  }

  function saveSubset() {
    const next: SubsetDefinition = {
      ...draftSubset,
      id: `subset-${Date.now()}`,
      color: colors[subsets.length % colors.length]
    };
    setSubsets((current) => [...current, next]);
    setSelectedIds((current) => (current.includes(next.id) ? current : [...current, next.id]));
    setNotice(`${next.name} saved for comparison.`);
  }

  function loadSubsetIntoBuilder(subset: SubsetDefinition) {
    if (!log) return;
    skipNextBuilderAutoText.current = true;
    const next = builderStateFromSubset(log, subset, builderAttributeFields);
    setActivityModes(next.activityModes);
    setAttributeValues(next.attributeValues);
    setInvertedAttributes(next.invertedAttributes);
    setNumericRanges(next.numericRanges);
    setStartDateRange(next.startDateRange);
    setEndDateRange(next.endDateRange);
    setInvertedDateRanges(next.invertedDateRanges);
    setBuilderAttributeFields(next.builderAttributeFields);
    setSubsetName(next.subsetName);
    setSubsetDescription(next.subsetDescription);
    setPage("builder");
    setNotice(`${subset.name} loaded into the subset builder. Save it to create a new subset.`);
  }

  function deleteSubset(id: string) {
    const deleted = subsets.find((subset) => subset.id === id);
    if (!deleted) return;
    const confirmed = window.confirm(`Delete subset "${deleted.name}"? This removes it from the saved subset list and comparison view.`);
    if (!confirmed) return;
    setSubsets((current) => current.filter((subset) => subset.id !== id));
    setSelectedIds((current) => current.filter((selectedId) => selectedId !== id));
    setSubsetStyles((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setNotice(`${deleted.name} deleted.`);
  }

  function addInsightPresets() {
    const currentIds = new Set(subsets.map((subset) => subset.id));
    const missing = defaultSubsets().filter((subset) => !currentIds.has(subset.id));
    if (!missing.length) {
      setNotice("All insight presets are already in the saved subset list.");
      return;
    }
    setSubsets((current) => [...current, ...missing]);
    setSelectedIds((current) => {
      const next = [...current];
      for (const subset of missing) {
        if (next.length >= 3) break;
        if (!next.includes(subset.id)) next.push(subset.id);
      }
      return next;
    });
    setNotice(`${missing.length} insight presets added.`);
  }

  function resetBuilder() {
    if (log) {
      const fullRange = dateRangeFromLog(log);
      setActivityModes(createEmptyModes(log.activities));
      setStartDateRange(fullRange);
      setEndDateRange(fullRange);
    }
    setAttributeValues({});
    setInvertedAttributes({});
    setNumericRanges({});
    setInvertedDateRanges({ start: false, end: false });
    setSubsetName("All cases");
    setSubsetDescription("all cases");
  }

  function pinActivity(activity: string) {
    setPinnedActivities((current) => (current.includes(activity) ? current : [...current, activity]));
  }

  function unpinActivity(activity: string) {
    setPinnedActivities((current) => current.filter((item) => item !== activity));
  }

  function pinPath(path: PinnedEdge) {
    setPinnedPaths((current) => (current.some((item) => item.edgeId === path.edgeId) ? current : [...current, path]));
  }

  function unpinPath(edgeId: string) {
    setPinnedPaths((current) => current.filter((item) => item.edgeId !== edgeId));
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      return [...current, id];
    });
  }

  if (!studyAccessGranted) {
    return (
      <main className="access-shell">
        <section className="access-card" role="status" aria-live="polite">
          <h1>Access restricted</h1>
          <p>This prototype is accessible only through the study survey link.</p>
        </section>
      </main>
    );
  }

  if (loadError) {
    return <main className="empty-state">Unable to load event log data: {loadError}</main>;
  }

  if (!log) {
    return <main className="empty-state">Loading logistics event log...</main>;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <img className="topbar-logo" src="/shared-dfg-logo.svg" alt="" aria-hidden="true" />
          <div>
            <div className="eyebrow">{log.metadata.logName}</div>
            <h1>Multi-Faceted Process Subset Comparison</h1>
            <p>Case-attribute subset construction and shared DFG comparison for exploratory process mining.</p>
          </div>
        </div>
        <nav className="tabs" aria-label="Prototype pages">
          <button className={page === "builder" ? "active" : ""} onClick={() => setPage("builder")} type="button">
            <Activity size={16} /> Subset builder
          </button>
          <button className={page === "analysis" ? "active" : ""} onClick={() => setPage("analysis")} type="button">
            <GitCompare size={16} /> Shared DFG
          </button>
          <button className={page === "configuration" ? "active" : ""} onClick={() => setPage("configuration")} type="button">
            <SlidersHorizontal size={16} /> Configuration
          </button>
        </nav>
      </header>

      {notice ? (
        <div className="notice" role="status">
          {notice}
          <button type="button" onClick={() => setNotice("")}>Dismiss</button>
        </div>
      ) : null}

      {page === "builder" ? (
        <BuilderPage
          log={log}
          activityModes={activityModes}
          setActivityMode={setActivityMode}
          subsetName={subsetName}
          setSubsetName={setSubsetName}
          subsetDescription={subsetDescription}
          setSubsetDescription={setSubsetDescription}
          builderAttributeFields={builderAttributeFields}
          attributeValues={attributeValues}
          invertedAttributes={invertedAttributes}
          numericRanges={numericRanges}
          toggleAttributeValue={toggleAttributeValue}
          setAttributeValueList={setAttributeValueList}
          toggleAttributeInversion={toggleAttributeInversion}
          setNumericRange={setNumericRange}
          startDateRange={startDateRange}
          setStartDateRange={setStartDateRange}
          endDateRange={endDateRange}
          setEndDateRange={setEndDateRange}
          invertedDateRanges={invertedDateRanges}
          setInvertedDateRanges={setInvertedDateRanges}
          draftSubset={draftSubset}
          previewCases={previewCases}
          subsets={subsets}
          selectedIds={selectedIds}
          saveSubset={saveSubset}
          deleteSubset={deleteSubset}
          resetBuilder={resetBuilder}
          addInsightPresets={addInsightPresets}
          toggleSelected={toggleSelected}
          loadSubsetIntoBuilder={loadSubsetIntoBuilder}
          openAnalysis={() => setPage("analysis")}
        />
      ) : page === "analysis" ? (
        <AnalysisPage
          log={log}
          subsets={subsets}
          selectedIds={selectedIds}
          toggleSelected={toggleSelected}
          subsetDfgs={subsetDfgs}
          sharedDfg={sharedDfg}
          computeMode={computeMode}
          setComputeMode={changeComputeMode}
          onComputeFallback={activateLocalFallback}
          backendStatus={backendStatus}
          activityCaseShareThreshold={activityCaseShareThreshold}
          setActivityCaseShareThreshold={setActivityCaseShareThreshold}
          pathCaseShareThreshold={pathCaseShareThreshold}
          setPathCaseShareThreshold={setPathCaseShareThreshold}
          activityScope={activityScope}
          setActivityScope={changeActivityScope}
          maxVisibleActivities={maxVisibleActivities}
          setMaxVisibleActivities={setMaxVisibleActivities}
          maxVisiblePaths={maxVisiblePaths}
          setMaxVisiblePaths={setMaxVisiblePaths}
          pathMode={pathMode}
          setPathMode={changePathMode}
          activityLabelMetric={activityLabelMetric}
          setActivityLabelMetric={setActivityLabelMetric}
          activityLabelDisplay={activityLabelDisplay}
          setActivityLabelDisplay={setActivityLabelDisplay}
          pathLabelMetric={pathLabelMetric}
          setPathLabelMetric={setPathLabelMetric}
          globalPathShape={globalPathShape}
          setGlobalPathShape={setGlobalPathShape}
          edgeWidthMetric={edgeWidthMetric}
          setEdgeWidthMetric={setEdgeWidthMetric}
          edgeWidthScale={edgeWidthScale}
          setEdgeWidthScale={setEdgeWidthScale}
          arcCurvature={arcCurvature}
          setArcCurvature={setArcCurvature}
          subsetStyles={subsetStyles}
          updateSubsetStyle={updateSubsetStyle}
          addInsightPresets={addInsightPresets}
          setLayoutStatus={setLayoutStatus}
          pinnedActivities={pinnedActivities}
          pinnedPaths={pinnedPaths}
          graphResetToken={graphResetToken}
          pinActivity={pinActivity}
          unpinActivity={unpinActivity}
          pinPath={pinPath}
          unpinPath={unpinPath}
        />
      ) : (
        <ConfigurationPage
          log={log}
          builderAttributeFields={builderAttributeFields}
          toggleBuilderAttribute={toggleBuilderAttribute}
          resetBuilderAttributes={() => setBuilderAttributeFields(defaultBuilderAttributes)}
        />
      )}
      <footer className="app-footer">© 2026 Zhichao Yao. All rights reserved. Academic research prototype.</footer>
    </main>
  );
}

interface BuilderProps {
  log: EventLog;
  activityModes: Record<string, ActivityMode>;
  setActivityMode: (activity: string, mode: ActivityMode) => void;
  subsetName: string;
  setSubsetName: (value: string) => void;
  subsetDescription: string;
  setSubsetDescription: (value: string) => void;
  builderAttributeFields: string[];
  attributeValues: Record<string, string[]>;
  invertedAttributes: Record<string, boolean>;
  numericRanges: Record<string, NumericRangeDraft>;
  toggleAttributeValue: (field: string, value: string) => void;
  setAttributeValueList: (field: string, values: string[]) => void;
  toggleAttributeInversion: (field: string) => void;
  setNumericRange: (field: string, side: keyof NumericRangeDraft, value: string) => void;
  startDateRange: NumericRangeDraft;
  setStartDateRange: (value: NumericRangeDraft) => void;
  endDateRange: NumericRangeDraft;
  setEndDateRange: (value: NumericRangeDraft) => void;
  invertedDateRanges: { start: boolean; end: boolean };
  setInvertedDateRanges: (value: { start: boolean; end: boolean }) => void;
  draftSubset: SubsetDefinition;
  previewCases: CaseRecord[];
  subsets: SubsetDefinition[];
  selectedIds: string[];
  saveSubset: () => void;
  deleteSubset: (id: string) => void;
  resetBuilder: () => void;
  addInsightPresets: () => void;
  toggleSelected: (id: string) => void;
  loadSubsetIntoBuilder: (subset: SubsetDefinition) => void;
  openAnalysis: () => void;
}

function BuilderPage(props: BuilderProps) {
  const {
    log,
    activityModes,
    setActivityMode,
    subsetName,
    setSubsetName,
    subsetDescription,
    setSubsetDescription,
    builderAttributeFields,
    attributeValues,
    invertedAttributes,
    numericRanges,
    toggleAttributeValue,
    setAttributeValueList,
    toggleAttributeInversion,
    setNumericRange,
    startDateRange,
    setStartDateRange,
    endDateRange,
    setEndDateRange,
    invertedDateRanges,
    setInvertedDateRanges,
    draftSubset,
    previewCases,
    subsets,
    selectedIds,
    saveSubset,
    deleteSubset,
    resetBuilder,
    addInsightPresets,
    toggleSelected,
    loadSubsetIntoBuilder,
    openAnalysis
  } = props;

  const previewSummary = useMemo(() => builderPreviewSummary(previewCases), [previewCases]);
  const { activityMetrics, activityPreview, maxPreviewActivityCount, noticeBufferStats, previewEvents, transportTimeStats } = previewSummary;
  const orderedActivities = useMemo(
    () =>
      [...log.activities].sort((a, b) => {
        const aCount = activityMetrics.get(a)?.eventCount ?? 0;
        const bCount = activityMetrics.get(b)?.eventCount ?? 0;
        return bCount - aCount || a.localeCompare(b);
      }),
    [activityMetrics, log.activities]
  );
  const schemaByField = useMemo(() => new Map(log.schema.caseAttributes.map((schema) => [schema.name, schema])), [log.schema.caseAttributes]);
  const attributeOptionValuesByField = useMemo(() => {
    const cache = new Map<string, string[]>();
    for (const schema of log.schema.caseAttributes) {
      cache.set(schema.name, attributeOptionValues(log, schema.name, schema.values));
    }
    return cache;
  }, [log]);
  const previewNullCountsByField = useMemo(
    () => nullAttributeCountsByField(previewCases, builderAttributeFields.filter((field) => !realtimeFacetFields.has(field))),
    [builderAttributeFields, previewCases]
  );
  const facetDataByField = useMemo(() => {
    const cache = new Map<
      string,
      {
        facetCases: CaseRecord[];
        nullCount: number;
        optionStats: OptionStat[];
        schema: CaseAttributeSchema;
        showFacetStats: boolean;
        valuesForFacet: string[];
      }
    >();

    for (const field of builderAttributeFields) {
      const schema = schemaByField.get(field);
      if (!schema) continue;
      const showFacetStats = realtimeFacetFields.has(field);
      const facetCases = showFacetStats ? facetBaseCases(log.cases, draftSubset, { kind: "attribute", field }) : previewCases;
      const valuesForFacet = attributeOptionValuesByField.get(field) ?? [];
      const needsOptionStats = showFacetStats && (schema.type === "categorical" || field === "salesCompany");
      cache.set(field, {
        facetCases,
        nullCount: showFacetStats ? nullAttributeCount(facetCases, field) : previewNullCountsByField.get(field) ?? 0,
        optionStats: needsOptionStats ? categoricalFacetStats(facetCases, field, valuesForFacet) : optionStatsWithoutCounts(valuesForFacet),
        schema,
        showFacetStats,
        valuesForFacet
      });
    }

    return cache;
  }, [attributeOptionValuesByField, builderAttributeFields, draftSubset, log.cases, previewCases, previewNullCountsByField, schemaByField]);
  return (
    <section className="builder-grid">
      <aside className="stack">
        <Panel title="Subset Preview">
          <div className="metric-grid">
            <Metric color={draftSubset.color} label="Matched cases" share={previewCases.length / log.metadata.caseCount} value={formatNumber(previewCases.length)} />
            <Metric color={draftSubset.color} label="Matched events" share={previewEvents / log.metadata.eventCount} value={formatNumber(previewEvents)} />
          </div>
          <div className="kpi-distribution-list">
            <KpiDistributionCard
              color={draftSubset.color}
              help="Actual time from vehicle arrival at port to final delivery to the end customer. Shorter transport time usually means less storage time and faster fulfilment."
              label="Transport time"
              stats={transportTimeStats}
            />
            <KpiDistributionCard
              color={draftSubset.color}
              help="Lead time for the operator to synchronize logistics information to the system and related parties. Longer notice buffer can give stakeholders more preparation time, so it is not automatically worse."
              label="Notice buffer"
              stats={noticeBufferStats}
            />
          </div>
          <div className="activity-preview-card" title="Activity categories in the current subset preview. Shows all activities when there are 8 or fewer; otherwise the 5 most frequent and 3 least frequent activities.">
            <div className="activity-preview-title">
              <span>Activity categories</span>
              <strong>{formatNumber(activityMetrics.size)}</strong>
            </div>
            <div className="activity-bar-list">
              {activityPreview.map((item, index) => item.kind === "gap" ? (
                <div className="activity-bar-gap" key="activity-preview-gap">...</div>
              ) : (
                <div
                  className="activity-bar-row"
                  key={item.activity}
                  style={{ "--activity-share": `${(item.count / maxPreviewActivityCount) * 100}%` } as CSSProperties}
                >
                  <span>{item.activity}</span>
                  <strong>{formatNumber(item.count)}</strong>
                  <i className={index % 2 === 0 ? "primary" : "secondary"} />
                </div>
              ))}
            </div>
          </div>
        </Panel>
      </aside>

      <div className="stack">
        <Panel title="Time and Attribute Canvas">
          <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <DateRangeField
              inverted={invertedDateRanges.start}
              label="Start date"
              maxDate={log.metadata.timeRange.to.slice(0, 10)}
              minDate={log.metadata.timeRange.from.slice(0, 10)}
              onChange={setStartDateRange}
              onToggleInverted={() => setInvertedDateRanges({ ...invertedDateRanges, start: !invertedDateRanges.start })}
              range={startDateRange}
            />
            <DateRangeField
              inverted={invertedDateRanges.end}
              label="End date"
              maxDate={log.metadata.timeRange.to.slice(0, 10)}
              minDate={log.metadata.timeRange.from.slice(0, 10)}
              onChange={setEndDateRange}
              onToggleInverted={() => setInvertedDateRanges({ ...invertedDateRanges, end: !invertedDateRanges.end })}
              range={endDateRange}
            />
          </SimpleGrid>
          {builderAttributeFields.length ? (
            <SimpleGrid className="attribute-builder-grid mantine-facet-grid" cols={{ base: 1, md: 2 }} spacing="sm">
              {builderAttributeFields.map((field) => {
                const facetData = facetDataByField.get(field);
                if (!facetData) return null;
                const { facetCases, nullCount, optionStats, schema, showFacetStats, valuesForFacet } = facetData;
                const isInvertible = invertibleAttributeFields.has(field);
                if (schema.type === "categorical" || field === "salesCompany") {
                  const values = attributeValues[field] ?? [];
                  if (field === "salesCompany") {
                    return (
                      <SalesCompanyFacetCard
                        color={draftSubset.color}
                        inverted={invertedAttributes[field] === true}
                        key={field}
                        label={schema.label}
                        nullCount={nullCount}
                        onChange={(nextValues) => setAttributeValueList(field, nextValues)}
                        onToggleInverted={() => toggleAttributeInversion(field)}
                        selectedValues={values}
                        stats={optionStats}
                        totalCount={facetCases.length}
                      />
                    );
                  }
                  return (
                    <CategoricalFacetCard
                      color={draftSubset.color}
                      compact={field === "inventoryCategory" || valuesForFacet.length <= 3}
                      inverted={invertedAttributes[field] === true}
                      key={field}
                      label={schema.label}
                      nullCount={nullCount}
                      onToggle={(value) => toggleAttributeValue(field, value)}
                      onToggleInverted={isInvertible ? () => toggleAttributeInversion(field) : undefined}
                      selectedValues={values}
                      showStats={showFacetStats}
                      sortByCount={field === "inventoryCategory"}
                      stats={optionStats}
                      totalCount={facetCases.length}
                      variant={field === "market" ? "market" : "default"}
                    />
                  );
                }
                if (schema.type === "date") {
                  const minDate = typeof schema.min === "string" ? schema.min : "";
                  const maxDate = typeof schema.max === "string" ? schema.max : "";
                  const range = numericRanges[field] ?? { min: "", max: "" };
                  return (
                    <DateAttributeFacetCard
                      color={draftSubset.color}
                      key={field}
                      label={schema.label}
                      maxDate={maxDate}
                      minDate={minDate}
                      inverted={invertedAttributes[field] === true}
                      nullCount={nullCount}
                      onChange={(side, value) => setNumericRange(field, side, value)}
                      onToggleInverted={isInvertible ? () => toggleAttributeInversion(field) : undefined}
                      range={range}
                      showStats={showFacetStats}
                      totalCount={facetCases.length}
                    />
                  );
                }
                const range = numericRanges[field] ?? { min: "", max: "" };
                const displayRange = numericRangeForDisplay(field, range);
                const distribution = showFacetStats ? numericFacetDistribution(facetCases, field) : null;
                return (
                  <NumericFacetCard
                    color={draftSubset.color}
                    distribution={numericDistributionForDisplay(field, distribution)}
                    key={field}
                    label={numericFacetDisplayLabel(field, schema.label)}
                    max={numericValueForDisplay(field, numericMax(log, field))}
                    min={numericValueForDisplay(field, numericMin(log, field))}
                    inverted={invertedAttributes[field] === true}
                    nullCount={nullCount}
                    onChange={(side, value) => setNumericRange(field, side, numericInputForStoredValue(field, value))}
                    onToggleInverted={isInvertible ? () => toggleAttributeInversion(field) : undefined}
                    range={displayRange}
                    showStats={showFacetStats}
                    totalCount={facetCases.length}
                  />
                );
              })}
            </SimpleGrid>
          ) : (
            <div className="empty-detail">No case attributes are enabled. Open Configuration to add fields to the subset builder.</div>
          )}
          </Stack>
        </Panel>

        <Panel title="Optional Activity Constraints">
          <div className="activity-list">
            {orderedActivities.map((activity) => {
              const metrics = activityMetrics.get(activity) ?? { caseCount: 0, eventCount: 0 };
              return (
                <div className="activity-rule" key={activity}>
                  <div className="activity-rule-main">
                    <span title={activity}>{activity}</span>
                    <em>
                      {formatNumber(metrics.caseCount)} cases · {formatNumber(metrics.eventCount)} events
                    </em>
                    <Progress
                      aria-label={`${activity} event count within the current preview`}
                      className="activity-rule-progress"
                      color={draftSubset.color}
                      radius="xl"
                      size={5}
                      value={(metrics.eventCount / maxPreviewActivityCount) * 100}
                    />
                  </div>
                  <SegmentedControl
                    className="activity-mode-control"
                    data={[
                      { label: "Off", value: "ignore" },
                      {
                        label: (
                          <Tooltip label="Required: keep only cases that contain this activity." openDelay={250} withArrow>
                            <span>Required</span>
                          </Tooltip>
                        ),
                        value: "required"
                      },
                      {
                        label: (
                          <Tooltip label="Excluded: keep only cases that do not contain this activity." openDelay={250} withArrow>
                            <span>Excluded</span>
                          </Tooltip>
                        ),
                        value: "excluded"
                      },
                      {
                        label: (
                          <Tooltip label="Rework: keep only cases where this activity occurs at least twice." openDelay={250} withArrow>
                            <span>Rework</span>
                          </Tooltip>
                        ),
                        value: "rework"
                      }
                    ]}
                    onChange={(value) => setActivityMode(activity, value as ActivityMode)}
                    size="xs"
                    value={activityModes[activity] ?? "ignore"}
                  />
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel title="Subset Logic">
          <div className="logic-box">
            <strong>Logic</strong>
            <span>{subsetFormula(draftSubset, log)}</span>
          </div>
        </Panel>

      </div>

      <aside className="stack">
        <Panel title="Subset Definition">
          <label className="field">
            <span>Name</span>
            <input value={subsetName} onChange={(event) => setSubsetName(event.target.value)} />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea value={subsetDescription} onChange={(event) => setSubsetDescription(event.target.value)} />
          </label>
          <div className="button-row">
            <button className="secondary" onClick={resetBuilder} type="button">
              <RotateCcw size={15} /> Reset
            </button>
            <button className="primary" onClick={saveSubset} type="button">
              <Save size={15} /> Save subset
            </button>
          </div>
        </Panel>
        <Panel title="Saved Subsets">
          <SubsetList
            deleteSubset={deleteSubset}
            loadSubsetIntoBuilder={loadSubsetIntoBuilder}
            selectedIds={selectedIds}
            subsets={subsets}
            toggleSelected={toggleSelected}
          />
          <button className="secondary full" onClick={addInsightPresets} type="button">
            Add insight presets
          </button>
          <button className="primary full" onClick={openAnalysis} type="button">
            Open shared DFG
          </button>
        </Panel>
      </aside>
    </section>
  );
}

function ConfigurationPage({
  log,
  builderAttributeFields,
  toggleBuilderAttribute,
  resetBuilderAttributes
}: {
  log: EventLog;
  builderAttributeFields: string[];
  toggleBuilderAttribute: (field: string) => void;
  resetBuilderAttributes: () => void;
}) {
  const selected = new Set(builderAttributeFields);
  return (
    <section className="configuration-grid">
      <Panel title="Subset Builder Attributes">
        <div className="source-card">
          Choose which case-level attributes appear in the subset builder. Disabled attributes are not removed from saved subsets; they are only hidden from the builder canvas.
        </div>
        <div className="attribute-config-list">
          {log.schema.caseAttributes.map((attribute) => (
            <label className="attribute-config-card" key={attribute.name}>
              <Checkbox
                aria-label={`Show ${attribute.label} in subset builder`}
                checked={selected.has(attribute.name)}
                className="theme-checkbox"
                color="blue"
                onChange={() => toggleBuilderAttribute(attribute.name)}
                size="xs"
              />
              <span>
                <strong>{attribute.label}</strong>
                <em>
                  {attribute.type === "categorical"
                    ? `Categorical · ${(attribute.values ?? []).length} values`
                    : attribute.type === "date"
                    ? `Date · ${formatRangeBound(attribute.min)} to ${formatRangeBound(attribute.max)}`
                    : `Numeric · ${formatRangeBound(attribute.min) || "0"} to ${formatRangeBound(attribute.max) || "0"}`}
                </em>
              </span>
            </label>
          ))}
        </div>
        <div className="button-row">
          <button className="secondary" onClick={resetBuilderAttributes} type="button">
            <RotateCcw size={15} /> Restore default attributes
          </button>
        </div>
      </Panel>
      <Panel title="Current Builder Fields">
        <div className="top-activities">
          {builderAttributeFields.map((field) => (
            <div key={field}>
              <span>{attributeLabel(log, field)}</span>
              <strong>{field}</strong>
            </div>
          ))}
        </div>
      </Panel>
    </section>
  );
}

interface AnalysisProps {
  log: EventLog;
  subsets: SubsetDefinition[];
  selectedIds: string[];
  toggleSelected: (id: string) => void;
  subsetDfgs: SubsetDfg[];
  sharedDfg: SharedDfg;
  computeMode: ComputeMode;
  setComputeMode: (value: ComputeMode) => void;
  onComputeFallback: () => void;
  backendStatus: string;
  activityCaseShareThreshold: number;
  setActivityCaseShareThreshold: (value: number) => void;
  pathCaseShareThreshold: number;
  setPathCaseShareThreshold: (value: number) => void;
  activityScope: ActivityScope;
  setActivityScope: (value: ActivityScope) => void;
  maxVisibleActivities: number;
  setMaxVisibleActivities: (value: number) => void;
  maxVisiblePaths: number;
  setMaxVisiblePaths: (value: number) => void;
  pathMode: PathMode;
  setPathMode: (value: PathMode) => void;
  activityLabelMetric: ActivityLabelMetric;
  setActivityLabelMetric: (value: ActivityLabelMetric) => void;
  activityLabelDisplay: ActivityLabelDisplay;
  setActivityLabelDisplay: (value: ActivityLabelDisplay) => void;
  pathLabelMetric: PathMetric;
  setPathLabelMetric: (value: PathMetric) => void;
  globalPathShape: PathShape;
  setGlobalPathShape: (value: PathShape) => void;
  edgeWidthMetric: WidthMetric;
  setEdgeWidthMetric: (value: WidthMetric) => void;
  edgeWidthScale: WidthScale;
  setEdgeWidthScale: (value: WidthScale) => void;
  arcCurvature: number;
  setArcCurvature: (value: number) => void;
  subsetStyles: Record<string, Partial<SubsetVisualStyle>>;
  updateSubsetStyle: (subsetId: string, patch: Partial<SubsetVisualStyle>) => void;
  addInsightPresets: () => void;
  setLayoutStatus: (value: string) => void;
  pinnedActivities: string[];
  pinnedPaths: PinnedEdge[];
  graphResetToken: number;
  pinActivity: (activity: string) => void;
  unpinActivity: (activity: string) => void;
  pinPath: (path: PinnedEdge) => void;
  unpinPath: (edgeId: string) => void;
}

function AnalysisPage(props: AnalysisProps) {
  const [collapsedPanels, setCollapsedPanels] = useState<Record<string, boolean>>({
    pinnedActivities: true,
    pinnedPaths: true,
    subsetAdjustment: true
  });
  const [showReadingCues, setShowReadingCues] = useState(false);
  const {
    log,
    subsets,
    selectedIds,
    toggleSelected,
    subsetDfgs,
    sharedDfg,
    computeMode,
    setComputeMode,
    onComputeFallback,
    backendStatus,
    activityCaseShareThreshold,
    setActivityCaseShareThreshold,
    pathCaseShareThreshold,
    setPathCaseShareThreshold,
    activityScope,
    setActivityScope,
    maxVisibleActivities,
    setMaxVisibleActivities,
    maxVisiblePaths,
    setMaxVisiblePaths,
    pathMode,
    setPathMode,
    activityLabelMetric,
    setActivityLabelMetric,
    activityLabelDisplay,
    setActivityLabelDisplay,
    pathLabelMetric,
    setPathLabelMetric,
    globalPathShape,
    setGlobalPathShape,
    edgeWidthMetric,
    setEdgeWidthMetric,
    edgeWidthScale,
    setEdgeWidthScale,
    arcCurvature,
    setArcCurvature,
    subsetStyles,
    updateSubsetStyle,
    addInsightPresets,
    setLayoutStatus,
    pinnedActivities,
    pinnedPaths,
    graphResetToken,
    pinActivity,
    unpinActivity,
    pinPath,
    unpinPath
  } = props;
  const selectedSubsets = useMemo(() => subsets.filter((subset) => selectedIds.includes(subset.id)), [selectedIds, subsets]);
  const activeSelectedIds = useMemo(() => selectedSubsets.map((subset) => subset.id), [selectedSubsets]);
  const hasSelectedSubsets = selectedSubsets.length > 0;
  const hasPinnedActivities = pinnedActivities.length > 0;
  const hasPinnedPaths = pinnedPaths.length > 0;
  const sharedProcessPanelRef = useRef<HTMLDivElement | null>(null);
  const lastManualActivityCoverageThreshold = useRef(activityCaseShareThreshold);
  const lastManualConnectionCoverageThreshold = useRef(pathCaseShareThreshold);
  const effectiveActivityScopeValue = effectiveActivityScope(activityScope, pathMode);
  const effectivePathMode = effectiveConnectionMode(activityScope, pathMode);
  const activityScopeLockedBySharedConnections = effectivePathMode === "shared" && effectiveActivityScopeValue === "common";
  const connectionModeLockedByUniqueActivities = effectiveActivityScopeValue === "specific";
  useEffect(() => {
    if (activityScope !== "specific") {
      lastManualActivityCoverageThreshold.current = activityCaseShareThreshold;
    }
    if (activityScope !== "specific" && effectivePathMode !== "specific") {
      lastManualConnectionCoverageThreshold.current = pathCaseShareThreshold;
    }
  }, [activityCaseShareThreshold, activityScope, effectivePathMode, pathCaseShareThreshold]);
  const changeActivityScope = (nextScope: ActivityScope) => {
    setActivityScope(nextScope);
    if (nextScope === "specific") {
      if (activityScope !== "specific") {
        lastManualActivityCoverageThreshold.current = activityCaseShareThreshold;
        lastManualConnectionCoverageThreshold.current = pathCaseShareThreshold;
      }
      setActivityCaseShareThreshold(0.01);
      setPathCaseShareThreshold(0);
      setPathMode("specific");
      return;
    }

    if (activityScope === "specific") {
      setActivityCaseShareThreshold(lastManualActivityCoverageThreshold.current ?? defaultActivityCaseShareThreshold);
      setPathCaseShareThreshold(lastManualConnectionCoverageThreshold.current ?? defaultPathCaseShareThreshold);
    }
  };
  const changePathMode = (nextMode: PathMode) => {
    if (effectiveActivityScopeValue === "specific") {
      return;
    }
    if (nextMode === "shared" && activityScope !== "common") {
      setActivityScope("common");
    }
    if (nextMode === "specific") {
      lastManualConnectionCoverageThreshold.current = pathCaseShareThreshold;
      setPathCaseShareThreshold(0);
    } else if (effectivePathMode === "specific") {
      setPathCaseShareThreshold(lastManualConnectionCoverageThreshold.current ?? defaultPathCaseShareThreshold);
    }
    setPathMode(nextMode);
  };
  const selectedCaseTotal = Math.max(1, subsetDfgs.reduce((sum, dfg) => sum + dfg.metrics.caseCount, 0));
  const selectedCasesBySubset = useMemo(
    () => new Map(selectedSubsets.map((subset) => [subset.id, filterCases(log.cases, subset)])),
    [log.cases, selectedSubsets]
  );
  const fullLogBusinessConnectionCount = useMemo(() => countBusinessConnections(log.cases), [log.cases]);
  const readingStats = useMemo(() => {
    const readingView = deriveSharedDfgView({
      activityCaseShareThreshold,
      activityScope: effectiveActivityScopeValue,
      dfg: sharedDfg,
      hiddenActivities: [],
      hiddenPaths: [],
      maxVisibleActivities: Number.MAX_SAFE_INTEGER,
      maxVisiblePaths: Number.MAX_SAFE_INTEGER,
      pathCaseShareThreshold,
      pathMode: effectivePathMode,
      selectedIds: activeSelectedIds
    });
    const eligiblePaths = readingView.scopedEdges.filter(isBusinessPath);
    const sharedPaths = eligiblePaths.filter((edge) => subsetIdsForEdge(edge, activeSelectedIds).length === activeSelectedIds.length);
    const subsetSpecificPaths = eligiblePaths.filter((edge) => subsetIdsForEdge(edge, activeSelectedIds).length === 1);
    const eligiblePathPairs = new Set(eligiblePaths.map((edge) => `${edge.source}__${edge.target}`));
    const twoWayPathPairs = new Set<string>();
    for (const edge of eligiblePaths) {
      if (edge.source >= edge.target) continue;
      if (eligiblePathPairs.has(`${edge.target}__${edge.source}`)) {
        twoWayPathPairs.add(`${edge.source}__${edge.target}`);
      }
    }
    return {
      eligibleActivities: readingView.scopedNodes.length,
      eligiblePaths: eligiblePaths.length,
      sharedPaths: sharedPaths.length,
      subsetSpecificPaths: subsetSpecificPaths.length,
      twoWayPathPairs: twoWayPathPairs.size,
      totalActivities: Math.max(1, log.activities.filter((activity) => !isBoundaryActivityName(activity)).length),
      totalPaths: Math.max(1, fullLogBusinessConnectionCount)
    };
  }, [activeSelectedIds, activityCaseShareThreshold, effectiveActivityScopeValue, effectivePathMode, fullLogBusinessConnectionCount, log.activities, pathCaseShareThreshold, sharedDfg]);
  const readingCues = useMemo(() => {
    const cues: string[] = [];
    const sharedShare = readingStats.eligiblePaths ? readingStats.sharedPaths / readingStats.eligiblePaths : 0;
    const pathReduction = 1 - readingStats.eligiblePaths / readingStats.totalPaths;
    const activityReduction = 1 - readingStats.eligibleActivities / readingStats.totalActivities;

    if (!readingStats.eligiblePaths) {
      cues.push("No connections match these settings. Lower the connection coverage or switch Connection Visibility back to any subset.");
      return cues;
    }
    if (sharedShare >= 0.6) {
      cues.push("Most connections are shared. Compare line width and labels first.");
    } else if (sharedShare <= 0.25) {
      cues.push("Many connections belong to only one subset. Use the colors to see which subset drives each branch.");
    } else {
      cues.push("There is a mix of shared and subset-only connections. Read common connections first, then inspect the colored differences.");
    }
    if (readingStats.twoWayPathPairs > 0) {
      cues.push("Some activity pairs go both ways. Check them for rework or back-and-forth movement.");
    }
    if (readingStats.eligiblePaths > 45) {
      cues.push("The map is dense. Raise the connection coverage or lower the connection slider before reading details.");
    } else if (pathReduction > 0.4 || activityReduction > 0.4) {
      cues.push("The filters hide a lot of detail. Mention the current scope when you use this screenshot.");
    }
    return cues;
  }, [readingStats]);
  const togglePanel = (panelId: string) => {
    setCollapsedPanels((current) => ({ ...current, [panelId]: !current[panelId] }));
  };
  useEffect(() => {
    setCollapsedPanels((current) => ({
      ...current,
      pinnedActivities: hasPinnedActivities ? false : true,
      pinnedPaths: hasPinnedPaths ? false : true
    }));
  }, [hasPinnedActivities, hasPinnedPaths]);
  useEffect(() => {
    const scrollTimer = window.setTimeout(() => {
      sharedProcessPanelRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 80);
    return () => window.clearTimeout(scrollTimer);
  }, [graphResetToken]);
  const pinnedActivityPanel = (
    <CollapsiblePanel collapsed={Boolean(collapsedPanels.pinnedActivities)} onToggle={() => togglePanel("pinnedActivities")} title="Pinned Activities">
      <PinnedActivityCards
        activities={pinnedActivities}
        dfg={sharedDfg}
        selectedSubsets={selectedSubsets}
        subsetStyles={subsetStyles}
        unpinActivity={unpinActivity}
      />
    </CollapsiblePanel>
  );
  const pinnedPathPanel = (
    <CollapsiblePanel collapsed={Boolean(collapsedPanels.pinnedPaths)} onToggle={() => togglePanel("pinnedPaths")} title="Pinned Connections">
      <PinnedPathCards
        dfg={sharedDfg}
        paths={pinnedPaths}
        selectedSubsets={selectedSubsets}
        subsetStyles={subsetStyles}
        unpinPath={unpinPath}
      />
    </CollapsiblePanel>
  );

  return (
    <section className="analysis-grid">
      <aside className="stack">
        <CollapsiblePanel collapsed={Boolean(collapsedPanels.subsetAdjustment)} onToggle={() => togglePanel("subsetAdjustment")} title="Subset Adjustment">
          {!hasSelectedSubsets ? <div className="control-blocker-note">Select at least one subset before changing model or DFG controls.</div> : null}
          <SubsetList
            selectedIds={selectedIds}
            subsetStyles={subsetStyles}
            subsets={subsets}
            toggleSelected={toggleSelected}
            updateSubsetStyle={updateSubsetStyle}
          />
          <PanelFooterCollapse onCollapse={() => togglePanel("subsetAdjustment")} />
        </CollapsiblePanel>

        <CollapsiblePanel
          collapsed={Boolean(collapsedPanels.graphAdjustment)}
          help="Control which activities and connections are visible in the shared DFG."
          helpLabel="Show graph adjustment note"
          onToggle={() => togglePanel("graphAdjustment")}
          title="Graph Adjustment"
        >
          {!hasSelectedSubsets ? <div className="control-blocker-note">Select at least one subset before changing graph controls.</div> : null}
          <fieldset className="panel-control-group" disabled={!hasSelectedSubsets}>
            <div className="field">
              <FieldLabel help="Choose how connections are drawn.">Connection Shape</FieldLabel>
              <Select
                allowDeselect={false}
                comboboxProps={{ withinPortal: false }}
                data={pathShapeOptions}
                leftSection={<PathShapePreview shape={globalPathShape} />}
                leftSectionWidth={70}
                onChange={(value) => value && setGlobalPathShape(value as PathShape)}
                renderOption={({ option }) => <PathShapeOption label={option.label} shape={option.value as PathShape} />}
                size="sm"
                value={globalPathShape}
                withCheckIcon={false}
              />
            </div>
            {globalPathShape === "curved" ? (
              <div className="control-slider-card">
                <div className="control-slider-header">
                  <FieldLabel help="Controls path bend.">Arc Curvature</FieldLabel>
                  <b>{Math.round(arcCurvature * 100)}%</b>
                </div>
                <Slider
                  aria-label="Arc curvature"
                  className="control-slider"
                  color="blue"
                  label={(value) => `${value}%`}
                  max={180}
                  min={10}
                  onChange={(value) => setArcCurvature(value / 100)}
                  step={5}
                  value={Math.round(arcCurvature * 100)}
                />
              </div>
            ) : null}
            <div className="visibility-control-card">
              <div className="visibility-control-title">
                <span className="graph-activity-glyph" aria-hidden="true">
                  <span />
                </span>
                <FieldLabel help="Choose whether activities appear in any selected subset, all selected subsets, or only one subset.">Activity Visibility</FieldLabel>
              </div>
              <div className="field compact-field">
                <span>Appears in</span>
                {activityScopeLockedBySharedConnections ? <em className="constraint-hint">Shared connections require shared activities.</em> : null}
                <Select
                  allowDeselect={false}
                  comboboxProps={{ withinPortal: false }}
                  data={activityVisibilityOptions.map((option) => ({
                    ...option,
                    disabled: activityScopeLockedBySharedConnections && option.value !== "common"
                  }))}
                  onChange={(value) => {
                    if (value) {
                      changeActivityScope(value as ActivityScope);
                    }
                  }}
                  size="xs"
                  value={effectiveActivityScopeValue}
                  withCheckIcon={false}
                />
              </div>
              <div className="coverage-control">
                <div className="coverage-control-row">
                  <FieldLabel help="Percentage of cases in a subset that contain this activity.">Case Coverage</FieldLabel>
                  <span className="coverage-operator">&gt;</span>
                  <input
                    aria-label="Activity coverage percentage"
                    className="coverage-input"
                    max={100}
                    min={0}
                    onChange={(event) => setActivityCaseShareThreshold(clampPercent(Number(event.target.value)) / 100)}
                    step={1}
                    type="number"
                    value={clampPercent(activityCaseShareThreshold * 100)}
                  />
                  <span className="coverage-percent">%</span>
                </div>
                <span className="coverage-control-hint">In at least one subset</span>
              </div>
              <Slider
                aria-label="Activity coverage"
                className="control-slider mantine-threshold-slider"
                color="blue"
                label={(value) => `${value}%`}
                max={maxActivityCaseShareThresholdPercent}
                min={0}
                onChange={(value) => setActivityCaseShareThreshold(clampPercent(value) / 100)}
                step={1}
                value={clampPercent(activityCaseShareThreshold * 100)}
              />
            </div>
            <div className="visibility-control-card">
              <div className="visibility-control-title">
                <CornerRightDown aria-hidden="true" size={16} strokeWidth={3} />
                <FieldLabel help="Choose whether direct connections appear in any selected subset, all selected subsets, or only one subset.">Connection Visibility</FieldLabel>
              </div>
              <div className="field compact-field">
                <span>Appears in</span>
                {connectionModeLockedByUniqueActivities ? <em className="constraint-hint">Connection visibility follows unique activities.</em> : null}
                <Select
                  allowDeselect={false}
                  comboboxProps={{ withinPortal: false }}
                  data={connectionVisibilityOptions.map((option) => ({
                    ...option,
                    disabled: connectionModeLockedByUniqueActivities && option.value !== "specific"
                  }))}
                  onChange={(value) => {
                    if (value) {
                      changePathMode(value as PathMode);
                    }
                  }}
                  size="xs"
                  value={effectivePathMode}
                  withCheckIcon={false}
                />
              </div>
              <div className="coverage-control">
                <div className="coverage-control-row">
                  <FieldLabel help="Percentage of cases in a subset that contain this connection.">Case Coverage</FieldLabel>
                  <span className="coverage-operator">&gt;</span>
                  <input
                    aria-label="Connection coverage percentage"
                    className="coverage-input"
                    max={100}
                    min={0}
                    onChange={(event) => setPathCaseShareThreshold(clampPercent(Number(event.target.value)) / 100)}
                    step={1}
                    type="number"
                    value={clampPercent(pathCaseShareThreshold * 100)}
                  />
                  <span className="coverage-percent">%</span>
                </div>
                <span className="coverage-control-hint">In at least one subset</span>
              </div>
              <Slider
                aria-label="Connection coverage"
                className="control-slider mantine-threshold-slider"
                color="blue"
                label={(value) => `${value}%`}
                max={maxPathCaseShareThresholdPercent}
                min={0}
                onChange={(value) => setPathCaseShareThreshold(clampPercent(value) / 100)}
                step={1}
                value={clampPercent(pathCaseShareThreshold * 100)}
              />
            </div>
            <details className="compute-mode-control">
              <summary>
                <Tooltip label="Switch only if the DFG fails to load." position="top" withArrow>
                  <span className="compute-mode-title">Computation</span>
                </Tooltip>
                <span className={`compute-mode-badge ${computeMode}`}>{computeMode === "server" ? "Server" : "Local"}</span>
              </summary>
              <SegmentedControl
                data={[
                  { label: "Server", value: "server" },
                  { label: "Local", value: "local" }
                ]}
                fullWidth
                onChange={(value) => setComputeMode(value as ComputeMode)}
                size="xs"
                value={computeMode}
              />
              <em>{backendStatus}</em>
            </details>
          </fieldset>
          <PanelFooterCollapse onCollapse={() => togglePanel("graphAdjustment")} />
        </CollapsiblePanel>
      </aside>

      <div className="stack" ref={sharedProcessPanelRef}>
        <Panel title="Shared Process View">
          <SharedDfgSvg
            dfg={sharedDfg}
            activityScope={effectiveActivityScopeValue}
            activityCaseShareThreshold={activityCaseShareThreshold}
            maxVisibleActivities={maxVisibleActivities}
            setMaxVisibleActivities={setMaxVisibleActivities}
            maxVisiblePaths={maxVisiblePaths}
            setMaxVisiblePaths={setMaxVisiblePaths}
            pathCaseShareThreshold={pathCaseShareThreshold}
            activityLabelMetric={activityLabelMetric}
            activityLabelDisplay={activityLabelDisplay}
            pathLabelMetric={pathLabelMetric}
            setPathLabelMetric={setPathLabelMetric}
            pathMode={effectivePathMode}
            globalPathShape={globalPathShape}
            selectedSubsets={selectedSubsets}
            edgeWidthMetric={edgeWidthMetric}
            setEdgeWidthMetric={setEdgeWidthMetric}
            edgeWidthScale={edgeWidthScale}
            setEdgeWidthScale={setEdgeWidthScale}
            arcCurvature={arcCurvature}
            subsetStyles={subsetStyles}
            setActivityLabelMetric={setActivityLabelMetric}
            setActivityLabelDisplay={setActivityLabelDisplay}
            setLayoutStatus={setLayoutStatus}
            computeMode={computeMode}
            onComputeFallback={onComputeFallback}
            graphResetToken={graphResetToken}
            pinActivity={pinActivity}
            pinPath={pinPath}
          />
        </Panel>
      </div>

      <aside className="stack">
        {hasPinnedActivities ? pinnedActivityPanel : null}
        {hasPinnedPaths ? pinnedPathPanel : null}
        <CollapsiblePanel collapsed={Boolean(collapsedPanels.performance)} onToggle={() => togglePanel("performance")} title="Performance Summary">
          <div className="kpi-summary">
            {subsetDfgs.map((dfg) => {
              const style = subsetStyle(dfg.subset, selectedSubsets.findIndex((subset) => subset.id === dfg.subset.id), subsetStyles);
              const caseShare = dfg.metrics.caseCount / selectedCaseTotal;
              const transportStats = transportTimeDistribution(selectedCasesBySubset.get(dfg.subset.id) ?? []);
              return (
                <div className="kpi-card" key={dfg.subset.id}>
                  <div className="kpi-card-title">
                    <i style={{ background: style.color }} />
                    <strong>{dfg.subset.name}</strong>
                  </div>
                  <div className="kpi-primary-row">
                    <Tooltip label="Case coverage means this subset's cases as a share of all currently selected cases." position="top" withArrow>
                      <div
                        className="kpi-case-summary"
                        style={
                          {
                            "--share-angle": `${Math.max(0, Math.min(1, caseShare)) * 360}deg`,
                            "--share-color": style.color
                          } as CSSProperties
                        }
                      >
                        <i aria-label={`${formatPercent(caseShare)} of selected cases`}>
                          <span>{formatPercent(caseShare)}</span>
                        </i>
                        <div className="kpi-case-total">
                          <span>Cases</span>
                          <strong>{formatNumber(dfg.metrics.caseCount)}</strong>
                        </div>
                      </div>
                    </Tooltip>
                    <CompactTransportDistribution color={style.color} stats={transportStats} />
                  </div>
                  <div className="kpi-secondary-row">
                    <KpiValue label="Avg events" value={formatFloat(dfg.metrics.caseCount ? dfg.metrics.eventCount / dfg.metrics.caseCount : 0)} color={style.color} />
                    <KpiValue label="Case duration" value={formatDays(dfg.metrics.avgCaseDurationHours / 24)} color={style.color} />
                    <KpiValue label="Notice buffer" value={formatDays(dfg.metrics.avgAdvanceNoticeTimeDays)} color={style.color} />
                  </div>
                </div>
              );
            })}
          </div>
        </CollapsiblePanel>
        <CollapsiblePanel
          collapsed={Boolean(collapsedPanels.modelReading)}
          help="The bars compare the selected subsets with the full log. For example, 26 / 28 means the selected subsets cover 26 of all 28 activities."
          helpLabel="Show model reading note"
          onToggle={() => togglePanel("modelReading")}
          title="Model Reading"
        >
          <div className="model-reading">
            <ReadingBar
              label="Selected activities"
              value={readingStats.eligibleActivities}
              total={readingStats.totalActivities}
            />
            <ReadingBar label="Selected connections" value={readingStats.eligiblePaths} total={readingStats.totalPaths} />
            <div className="reading-split">
              <ShareDonut
                caption="shared connections"
                color="var(--brand)"
                label={formatPercent(readingStats.eligiblePaths ? readingStats.sharedPaths / readingStats.eligiblePaths : 0)}
                share={readingStats.eligiblePaths ? readingStats.sharedPaths / readingStats.eligiblePaths : 0}
              />
              <div className="reading-copy">
                <strong>{formatNumber(readingStats.sharedPaths)} shared</strong>
                <span>{formatNumber(readingStats.subsetSpecificPaths)} subset-only connections with current settings</span>
              </div>
            </div>
            <div className="reading-note">
              Two-way connection pairs: {formatNumber(readingStats.twoWayPathPairs)}
            </div>
            <div className={`reading-cues${showReadingCues ? " open" : ""}`} aria-label="Suggested reading cues">
              <button
                aria-expanded={showReadingCues}
                className="reading-cues-toggle"
                onClick={() => setShowReadingCues((current) => !current)}
                title="Show quick reading tips for the current process map"
                type="button"
              >
                <strong>Reading cues</strong>
                <span>{readingCues.length} tips</span>
                <ChevronDown size={14} />
              </button>
              {showReadingCues ? (
                <div className="reading-cues-list">
                  {readingCues.map((cue) => (
                    <span key={cue}>{cue}</span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </CollapsiblePanel>
        {!hasPinnedActivities ? pinnedActivityPanel : null}
        {!hasPinnedPaths ? pinnedPathPanel : null}
      </aside>
    </section>
  );
}
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Paper className="panel" component="section" radius="md" shadow="xs" withBorder>
      <div className="panel-title">{title}</div>
      <div className="panel-body">{children}</div>
    </Paper>
  );
}

function CollapsiblePanel({
  title,
  collapsed,
  onToggle,
  help,
  helpLabel,
  children
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  help?: ReactNode;
  helpLabel?: string;
  children: ReactNode;
}) {
  return (
    <section className={collapsed ? "panel panel-collapsed" : "panel"}>
      <div className="panel-title panel-title-row">
        <button className="panel-title-main" onClick={onToggle} type="button" aria-expanded={!collapsed}>
          <span>{title}</span>
        </button>
        {help ? <InfoTip label={helpLabel ?? `Show ${title} note`}>{help}</InfoTip> : null}
        <button aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`} className="panel-title-chevron" onClick={onToggle} type="button">
          <ChevronDown className={collapsed ? "collapse-icon collapsed" : "collapse-icon"} size={16} />
        </button>
      </div>
      {collapsed ? null : <div className="panel-body">{children}</div>}
    </section>
  );
}

function PanelFooterCollapse({ onCollapse }: { onCollapse: () => void }) {
  return (
    <div className="panel-footer-actions">
      <button aria-label="Collapse panel" className="panel-collapse-inline" onClick={onCollapse} title="Collapse panel" type="button">
        <ChevronDown size={14} />
        <span>Collapse</span>
      </button>
    </div>
  );
}

function InfoTip({ children, label }: { children: ReactNode; label: string }) {
  return (
    <HoverCard closeDelay={120} openDelay={120} position="right" shadow="md" width={280} withArrow withinPortal>
      <HoverCard.Target>
      <button
        aria-label={label}
        className="info-icon-button"
        type="button"
      >
        <Info size={14} />
      </button>
      </HoverCard.Target>
      <HoverCard.Dropdown className="info-tip-card">
        {children}
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

function Metric({ color = "#3f6fa6", label, share, value }: { color?: string; label: string; share?: number; value: string }) {
  const normalizedShare = share === undefined || Number.isNaN(share) ? null : Math.max(0, Math.min(1, share));
  const ringStyle = normalizedShare === null
    ? undefined
    : ({
        "--metric-share": `${normalizedShare * 100}%`,
        "--metric-color": color,
        "--metric-color-soft": subsetTint(color, 0.14)
      } as CSSProperties);

  return (
    <div className={normalizedShare === null ? "metric" : "metric metric-with-share"}>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      {normalizedShare !== null ? (
        <div
          aria-label={`${label} ${formatPercent(normalizedShare)} of the full event log`}
          className="metric-share-ring"
          style={ringStyle}
          title={`${formatPercent(normalizedShare)} of the full event log`}
        >
          <small>{formatPercent(normalizedShare)}</small>
        </div>
      ) : null}
    </div>
  );
}

function KpiValue({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="kpi-value">
      <span>{label}</span>
      <strong style={{ color }}>{value}</strong>
    </div>
  );
}

function CompactTransportDistribution({ color, stats }: { color: string; stats: NumericDistribution }) {
  if (!stats) {
    return (
      <div className="compact-transport-distribution">
        <div className="compact-transport-title">
          <span>Avg transport time</span>
          <strong>n/a</strong>
        </div>
        <div className="kpi-histogram compact" aria-label="Transport time distribution histogram">
          {Array.from({ length: 10 }, (_, index) => (
            <i key={index} style={{ "--histogram-color": color, "--histogram-height": "3px" } as CSSProperties} />
          ))}
        </div>
      </div>
    );
  }
  const maxBin = Math.max(1, ...stats.bins);
  return (
    <div className="compact-transport-distribution" title="Transport time distribution uses 10 fixed columns: 0-10d, 10-20d, ... 80-90d, and 90d+ in the final column.">
      <div className="compact-transport-title">
        <span>Avg transport time</span>
        <strong>{formatDays(stats.avg)}</strong>
      </div>
      <div className="kpi-histogram compact" aria-label="Transport time distribution histogram">
        {stats.bins.map((count, index) => (
          <i
            key={index}
            style={
              {
                "--histogram-color": color,
                "--histogram-height": `${Math.max(3, (count / maxBin) * 24)}px`
              } as CSSProperties
            }
          />
        ))}
      </div>
    </div>
  );
}

function CompactTimeHistogram({ bins, color, label }: { bins: number[]; color: string; label: string }) {
  const safeBins = bins.length ? bins : Array.from({ length: 10 }, () => 0);
  const maxBin = Math.max(1, ...safeBins);
  return (
    <div
      className="kpi-histogram compact time-distribution"
      aria-label={label}
      title="Waiting-time distribution uses 10 fixed columns: 0-10d, 10-20d, ... 80-90d, and 90d+ in the final column."
    >
      {safeBins.map((count, index) => (
        <i
          key={index}
          style={
            {
              "--histogram-color": color,
              "--histogram-height": `${Math.max(3, (count / maxBin) * 24)}px`
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

function KpiDistributionCard({
  color,
  help,
  label,
  stats
}: {
  color: string;
  help: string;
  label: string;
  stats: NumericDistribution;
}) {
  if (!stats) {
    return (
      <div className="kpi-distribution-card">
        <div className="kpi-distribution-title">
          <span>{label}</span>
          <InfoTip label={`Show ${label} explanation`}>{help}</InfoTip>
        </div>
        <strong>n/a</strong>
      </div>
    );
  }
  const range = Math.max(0.001, stats.max - stats.min);
  const medianPosition = ((stats.median - stats.min) / range) * 100;
  const avgPosition = ((stats.avg - stats.min) / range) * 100;
  const maxBin = Math.max(1, ...stats.bins);
  return (
    <div className="kpi-distribution-card">
      <div className="kpi-distribution-title">
        <span>{label}</span>
        <InfoTip label={`Show ${label} explanation`}>{help}</InfoTip>
      </div>
      <strong>{formatDays(stats.avg)}</strong>
      <div className="kpi-histogram" aria-label={`${label} distribution histogram`}>
        {stats.bins.map((count, index) => (
          <i
            key={`${label}-bin-${index}`}
            style={
              {
                "--histogram-height": `${Math.max(8, (count / maxBin) * 100)}%`,
                "--histogram-color": color
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div className="kpi-range-bar" aria-hidden="true">
        <i style={{ background: color, left: `${Math.max(0, Math.min(100, medianPosition))}%` }} />
        <b style={{ background: color, left: `${Math.max(0, Math.min(100, avgPosition))}%` }} />
      </div>
      <div className="kpi-distribution-stats">
        <span>Min {formatDays(stats.min)}</span>
        <span>Median {formatDays(stats.median)}</span>
        <span>Max {formatDays(stats.max)}</span>
      </div>
    </div>
  );
}

function FacetHistogram({ color, stats }: { color: string; stats: { bins: number[] } | null }) {
  const bins = stats?.bins.length ? stats.bins : Array.from({ length: 10 }, () => 0);
  const maxBin = Math.max(1, ...bins);
  return (
    <div className="facet-histogram" aria-hidden="true">
      {bins.map((count, index) => (
        <i
          key={index}
          style={
            {
              "--facet-color": color,
              "--facet-height": `${Math.max(4, (count / maxBin) * 100)}%`
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

function FacetCardHeader({
  color,
  label,
  inverted,
  nullCount = 0,
  onToggleInverted,
  showCountBadge = true,
  totalCount
}: {
  color: string;
  inverted?: boolean;
  label: string;
  nullCount?: number;
  onToggleInverted?: () => void;
  showCountBadge?: boolean;
  totalCount: number;
}) {
  void color;
  void showCountBadge;
  void totalCount;
  return (
    <Group align="center" justify="space-between" gap="xs" wrap="nowrap">
      <Text className="facet-card-title">{label}</Text>
      <Group className="facet-header-actions" gap="xs" wrap="nowrap">
        {nullCount > 0 ? (
          <Tooltip label={`${formatNumber(nullCount)} cases have blank ${label}; they are excluded when this facet is used.`} openDelay={250} withArrow>
            <span className="facet-null-count">{formatNumber(nullCount)} blank</span>
          </Tooltip>
        ) : null}
        {onToggleInverted ? (
          <Switch
            checked={inverted}
            label="Exclude"
            onChange={onToggleInverted}
            size="xs"
          />
        ) : null}
      </Group>
    </Group>
  );
}

function EuropeMarketMap({
  color,
  onToggle,
  selectedValues,
  stats
}: {
  color: string;
  onToggle: (value: string) => void;
  selectedValues: string[];
  stats: OptionStat[];
}) {
  const statByMarket = new Map(stats.map((stat) => [stat.value, stat]));
  const maxCount = Math.max(1, ...stats.map((stat) => stat.count));
  const mapData = useMemo(() => {
    const topology = countries110m as unknown as { objects: { countries: unknown } };
    const collection = feature(topology as any, topology.objects.countries as any) as unknown as FeatureCollection<Geometry, { name?: string }>;
    const features = collection.features.filter((geo) => marketByTopoId[String(geo.id).padStart(3, "0")]);
    const projection = geoMercator()
      .center([9.5, 50.5])
      .clipExtent([
        [0, 0],
        [440, 310]
      ])
      .scale(420)
      .translate([220, 166]);
    const path = geoPath(projection);
    const markets = features.map((geo) => {
      const market = marketByTopoId[String(geo.id).padStart(3, "0")];
      return {
        geo,
        market,
        path: path(geo) ?? ""
      };
    });
    const labels = Object.entries(marketLabelCoordinates)
      .map(([market, coordinates]) => {
        const projected = projection(coordinates);
        if (!projected) return null;
        const [offsetX, offsetY] = marketLabelOffsets[market] ?? [0, 0];
        return {
          market,
          anchorX: projected[0],
          anchorY: projected[1],
          x: projected[0] + offsetX,
          y: projected[1] + offsetY
        };
      })
      .filter((label): label is { market: string; anchorX: number; anchorY: number; x: number; y: number } => Boolean(label));
    return { labels, markets };
  }, []);

  if (!mapData.markets.length) {
    const ringSections = stats
      .filter((stat) => stat.count > 0)
      .slice(0, 8)
      .map((stat, index) => ({ value: stat.share * 100, color: ["#3f6fa6", "#2ca25f", "#f0b400", "#ef4444", "#8b5cf6", "#f97316", "#14b8a6", "#64748b"][index % 8] }));
    return (
      <RingProgress
        className="market-ring"
        label={<Text className="market-ring-label">Share</Text>}
        sections={ringSections.length ? ringSections : [{ value: 100, color: "#d7e2eb" }]}
        size={78}
        thickness={9}
      />
    );
  }

  return (
    <div className="market-map-shell">
      <svg className="market-map" role="img" viewBox="0 0 440 310" aria-label="European market filter map">
        {mapData.markets.map(({ geo, market, path }) => {
          const stat = statByMarket.get(market) ?? { count: 0, share: 0, value: market };
          const active = selectedValues.includes(market);
          const strength = stat.count / maxCount;
          return (
            <path
              aria-label={`${market}: ${formatNumber(stat.count)} cases, ${formatPercent(stat.share)}`}
              className={active ? "market-map-country active" : "market-map-country"}
              d={path}
              key={String(geo.id)}
              onClick={() => onToggle(market)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onToggle(market);
                }
              }}
              role="button"
              style={
                {
                  "--market-color": color,
                  fill: subsetTint(color, 0.12 + strength * 0.78)
                } as CSSProperties
              }
              tabIndex={0}
            >
              <title>
                {market}: {formatNumber(stat.count)} cases, {formatPercent(stat.share)}
              </title>
            </path>
          );
        })}
        {mapData.labels.map(({ anchorX, anchorY, market, x, y }) => {
          const stat = statByMarket.get(market) ?? { count: 0, share: 0, value: market };
          const active = selectedValues.includes(market);
          const labelWidth = Math.max(48, market.length * 5.3 + 20);
          const needsLeader = Math.hypot(x - anchorX, y - anchorY) > 18;
          return (
            <g
              aria-label={`${market}: ${formatNumber(stat.count)} cases, ${formatPercent(stat.share)}`}
              className={active ? "market-map-label active" : "market-map-label"}
              key={`${market}-label`}
              onClick={() => onToggle(market)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onToggle(market);
                }
              }}
              role="button"
              tabIndex={0}
              transform={`translate(${x} ${y})`}
            >
              {needsLeader ? <line className="market-map-label-leader" x1={anchorX - x} x2={0} y1={anchorY - y} y2={0} /> : null}
              <rect height="24" rx="5" width={labelWidth} x={-labelWidth / 2} y="-12" />
              <text className="market-map-label-name" textAnchor="middle" y="-2.5">
                {market}
              </text>
              <text className="market-map-label-count" textAnchor="middle" y="8.5">
                {formatNumber(stat.count)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function MarketSharePie({ color, stats }: { color: string; stats: OptionStat[] }) {
  const palette = [
    color,
    subsetTint(color, 0.82),
    subsetTint(color, 0.68),
    subsetTint(color, 0.54),
    subsetTint(color, 0.4),
    subsetTint(color, 0.28),
    "#94a3b8"
  ];
  const positiveStats = stats.filter((stat) => stat.count > 0).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  const primary = positiveStats.slice(0, 5);
  const remainder = positiveStats.slice(5);
  const otherCount = remainder.reduce((sum, stat) => sum + stat.count, 0);
  const total = positiveStats.reduce((sum, stat) => sum + stat.count, 0);
  const items = otherCount > 0 ? [...primary, { value: "Others", count: otherCount, share: total ? otherCount / total : 0 }] : primary;
  let cursor = -90;
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  const segments = items.map((item, index) => {
    const angle = Math.max(0, item.share) * 360;
    const start = cursor;
    const mid = start + angle / 2;
    cursor += angle;
    const labelRadius = 84;
    const labelX = 110 + Math.cos((mid * Math.PI) / 180) * labelRadius;
    const labelY = 110 + Math.sin((mid * Math.PI) / 180) * labelRadius;
    const textAnchor: "start" | "middle" | "end" = labelX < 96 ? "end" : labelX > 124 ? "start" : "middle";
    return {
      ...item,
      color: palette[index % palette.length],
      dashArray: `${(Math.max(0, item.share) * circumference).toFixed(2)} ${circumference.toFixed(2)}`,
      dashOffset: -((start + 90) / 360) * circumference,
      labelX,
      labelY,
      textAnchor
    };
  });

  return (
    <div className="market-pie-card" aria-label="Market share pie chart">
      <svg className="market-pie-svg" role="img" viewBox="0 0 220 220" aria-label="Market share distribution">
        <circle className="market-pie-track" cx="110" cy="110" r={radius} />
        {segments.map((segment) => (
          <circle
            className="market-pie-segment"
            cx="110"
            cy="110"
            key={segment.value}
            r={radius}
            style={{
              stroke: segment.color,
              strokeDasharray: segment.dashArray,
              strokeDashoffset: segment.dashOffset
            }}
          >
            <title>
              {segment.value}: {formatPercent(segment.share)}
            </title>
          </circle>
        ))}
        {segments.map((segment) => (
          <text
            className="market-pie-label"
            key={`${segment.value}-label`}
            textAnchor={segment.textAnchor}
            x={segment.labelX}
            y={segment.labelY}
          >
            <tspan x={segment.labelX}>{segment.value}</tspan>
            <tspan className="market-pie-label-share" dy="11" x={segment.labelX}>
              {formatPercent(segment.share)}
            </tspan>
          </text>
        ))}
      </svg>
    </div>
  );
}

function CategoricalFacetCard({
  compact = false,
  color,
  inverted = false,
  label,
  nullCount = 0,
  onToggle,
  onToggleInverted,
  selectedValues,
  showStats = true,
  sortByCount = false,
  stats,
  totalCount,
  variant = "default"
}: {
  compact?: boolean;
  color: string;
  inverted?: boolean;
  label: string;
  nullCount?: number;
  onToggle: (value: string) => void;
  onToggleInverted?: () => void;
  selectedValues: string[];
  showStats?: boolean;
  sortByCount?: boolean;
  stats: OptionStat[];
  totalCount: number;
  variant?: "default" | "market";
}) {
  const orderedStats = sortByCount ? [...stats].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)) : stats;
  const shownStats = variant === "market" ? orderedStats.filter((stat) => marketTopoIds[stat.value]) : orderedStats.slice(0, 20);
  const maxCount = Math.max(1, ...shownStats.map((stat) => stat.count));

  return (
    <Card className={variant === "market" ? "facet-card market-facet-card" : "facet-card"} padding="sm" radius="md" withBorder>
      <Stack gap="xs">
        <FacetCardHeader
          color={color}
          inverted={inverted}
          label={label}
          nullCount={nullCount}
          onToggleInverted={onToggleInverted}
          showCountBadge={showStats}
          totalCount={totalCount}
        />
        {variant === "market" ? (
          <Group align="center" className="market-map-row" gap="sm" wrap="nowrap">
            <EuropeMarketMap color={color} onToggle={onToggle} selectedValues={selectedValues} stats={shownStats} />
            <MarketSharePie color={color} stats={shownStats} />
            <Text className="facet-helper-copy">
              Click a country label to filter Market. Color strength shows the current linked case count.
            </Text>
          </Group>
        ) : null}
        {variant !== "market" ? <div className={`${compact ? "facet-option-grid compact-three" : "facet-option-grid"} option-count-${Math.min(3, Math.max(1, shownStats.length))}${shownStats.length > 3 ? " option-many" : ""}`}>
          {shownStats.map((stat) => {
            const active = selectedValues.includes(stat.value);
            return (
              <button
                className={`${active ? "facet-option active" : "facet-option"}${showStats ? "" : " no-stats"}`}
                key={stat.value}
                onClick={() => onToggle(stat.value)}
                style={
                  {
                    "--facet-color": color,
                    "--facet-fill": showStats ? `${(stat.count / maxCount) * 100}%` : "0%"
                  } as CSSProperties
                }
                type="button"
              >
                <span>{stat.value}</span>
                {showStats ? (
                  <strong className="facet-option-metrics">
                    <em>{formatPercent(stat.share)}</em>
                    <small>{formatNumber(stat.count)}</small>
                  </strong>
                ) : null}
                <i aria-hidden="true" />
              </button>
            );
          })}
        </div> : null}
      </Stack>
    </Card>
  );
}

function SalesCompanyFacetCard({
  color,
  inverted,
  label,
  nullCount,
  onChange,
  onToggleInverted,
  selectedValues,
  stats,
  totalCount
}: {
  color: string;
  inverted: boolean;
  label: string;
  nullCount: number;
  onChange: (values: string[]) => void;
  onToggleInverted: () => void;
  selectedValues: string[];
  stats: OptionStat[];
  totalCount: number;
}) {
  const orderedStats = [...stats].sort((a, b) => Number(a.value) - Number(b.value));
  const statByValue = new Map(orderedStats.map((stat) => [stat.value, stat]));
  return (
    <Card className="facet-card sales-company-card" padding="sm" radius="md" withBorder>
      <Stack gap="xs">
        <FacetCardHeader
          color={color}
          inverted={inverted}
          label={label}
          nullCount={nullCount}
          onToggleInverted={onToggleInverted}
          showCountBadge
          totalCount={totalCount}
        />
        <MultiSelect
          clearable
          data={orderedStats.map((stat) => ({ value: stat.value, label: `Company ${stat.value}` }))}
          maxDropdownHeight={260}
          onChange={onChange}
          placeholder="Select companies"
          renderOption={({ option }) => {
            const stat = statByValue.get(option.value);
            return (
              <div className="company-option">
                <span>{option.label}</span>
                <strong>{stat ? formatNumber(stat.count) : "0"} cases</strong>
              </div>
            );
          }}
          searchable
          size="xs"
          value={selectedValues}
        />
      </Stack>
    </Card>
  );
}

function NumericFacetCard({
  color,
  distribution,
  inverted = false,
  label,
  max,
  min,
  nullCount = 0,
  onChange,
  onToggleInverted,
  range,
  showStats = false,
  totalCount
}: {
  color: string;
  distribution: FacetDistribution | null;
  inverted?: boolean;
  label: string;
  max: number;
  min: number;
  nullCount?: number;
  onChange: (side: keyof NumericRangeDraft, value: string) => void;
  onToggleInverted?: () => void;
  range: NumericRangeDraft;
  showStats?: boolean;
  totalCount: number;
}) {
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Number.isFinite(max) && max > safeMin ? max : safeMin + 1;
  const selectedMin = range.min === "" ? safeMin : Math.max(safeMin, Math.min(safeMax, Number(range.min)));
  const selectedMax = range.max === "" ? safeMax : Math.max(safeMin, Math.min(safeMax, Number(range.max)));
  const step = safeMax - safeMin > 100 ? 1 : 0.1;

  return (
    <Card className="facet-card numeric-facet-card" padding="sm" radius="md" withBorder>
      <Stack gap="xs">
        <FacetCardHeader color={color} inverted={inverted} label={label} nullCount={nullCount} onToggleInverted={onToggleInverted} showCountBadge={showStats} totalCount={totalCount} />
        {showStats ? <FacetHistogram color={color} stats={distribution} /> : null}
        <RangeSlider
          color="blue"
          label={(value) => formatRangeBound(value)}
          max={safeMax}
          min={safeMin}
          minRange={0}
          onChange={([nextMin, nextMax]) => {
            onChange("min", formatNumericInputValue(String(nextMin)));
            onChange("max", formatNumericInputValue(String(nextMax)));
          }}
          size="sm"
          step={step}
          value={[selectedMin, selectedMax]}
        />
        <Group className="facet-range-copy" justify="space-between" wrap="nowrap">
          <span>From {formatRangeBound(selectedMin)}</span>
          <span>To {formatRangeBound(selectedMax)}</span>
        </Group>
      </Stack>
    </Card>
  );
}

function DateAttributeFacetCard({
  color,
  inverted = false,
  label,
  maxDate,
  minDate,
  nullCount = 0,
  onChange,
  onToggleInverted,
  range,
  showStats = false,
  totalCount
}: {
  color: string;
  inverted?: boolean;
  label: string;
  maxDate: string;
  minDate: string;
  nullCount?: number;
  onChange: (side: keyof NumericRangeDraft, value: string) => void;
  onToggleInverted?: () => void;
  range: NumericRangeDraft;
  showStats?: boolean;
  totalCount: number;
}) {
  const minDay = dateToDay(minDate);
  const maxDay = Math.max(minDay + 1, dateToDay(maxDate));
  const selectedMinDay = range.min ? dateToDay(range.min) : minDay;
  const selectedMaxDay = range.max ? dateToDay(range.max) : maxDay;

  return (
    <Card className="facet-card date-facet-card" padding="sm" radius="md" withBorder>
      <Stack gap="xs">
        <FacetCardHeader color={color} inverted={inverted} label={label} nullCount={nullCount} onToggleInverted={onToggleInverted} showCountBadge={showStats} totalCount={totalCount} />
        <RangeSlider
          color="blue"
          label={(value) => formatDateForDisplay(dayToDate(value))}
          max={maxDay}
          min={minDay}
          minRange={0}
          onChange={([nextMin, nextMax]) => {
            onChange("min", dayToDate(nextMin));
            onChange("max", dayToDate(nextMax));
          }}
          size="sm"
          step={1}
          value={[selectedMinDay, selectedMaxDay]}
        />
        <Group className="facet-range-copy" justify="space-between" wrap="nowrap">
          <span>From {formatDateForDisplay(dayToDate(selectedMinDay))}</span>
          <span>To {formatDateForDisplay(dayToDate(selectedMaxDay))}</span>
        </Group>
      </Stack>
    </Card>
  );
}

function DateRangeField({
  inverted,
  label,
  minDate,
  maxDate,
  onToggleInverted,
  range,
  onChange
}: {
  inverted: boolean;
  label: string;
  minDate: string;
  maxDate: string;
  onToggleInverted: () => void;
  range: NumericRangeDraft;
  onChange: (value: NumericRangeDraft) => void;
}) {
  const safeMin = range.min || minDate;
  const safeMax = range.max || maxDate;

  function updateRange(side: keyof NumericRangeDraft, value: string | null) {
    const next = value || (side === "min" ? minDate : maxDate);
    const nextRange = { min: safeMin, max: safeMax, [side]: next };
    if (nextRange.min && nextRange.max && nextRange.min > nextRange.max) {
      onChange(side === "min" ? { min: next, max: next } : { min: next, max: next });
      return;
    }
    onChange(nextRange);
  }

  return (
    <Card className="facet-card date-picker-card" padding="sm" radius="md" withBorder>
      <Stack gap="xs">
      <Group align="flex-start" justify="space-between" gap="xs" wrap="nowrap">
        <div className="date-picker-title">
          <span>{label}</span>
          <em className="field-hint">From and To dates are included.</em>
        </div>
        <Switch checked={inverted} label="Exclude" onChange={onToggleInverted} size="xs" />
      </Group>
      <div className="date-picker-row">
        <DateInput
          aria-label={`${label} from`}
          className="mantine-date-input"
          dateParser={parseEuropeanDateInput}
          label="From"
          maxDate={safeMax}
          minDate={minDate}
          onChange={(value) => updateRange("min", value)}
          placeholder="dd/mm/yyyy"
          popoverProps={{ withinPortal: true }}
          value={safeMin}
          valueFormat="DD/MM/YYYY"
        />
        <DateInput
          aria-label={`${label} to`}
          className="mantine-date-input"
          dateParser={parseEuropeanDateInput}
          label="To"
          maxDate={maxDate}
          minDate={safeMin}
          onChange={(value) => updateRange("max", value)}
          placeholder="dd/mm/yyyy"
          popoverProps={{ withinPortal: true }}
          value={safeMax}
          valueFormat="DD/MM/YYYY"
        />
      </div>
      </Stack>
    </Card>
  );
}

function FieldLabel({ children, help }: { children: ReactNode; help: string }) {
  return (
    <span className="field-label-with-help">
      <span>{children}</span>
      <InfoTip label={`Show ${String(children)} explanation`}>{help}</InfoTip>
    </span>
  );
}

function ShareDonut({ caption, color, label, share }: { caption: string; color: string; label: string; share: number }) {
  const clampedShare = Math.max(0, Math.min(1, share));
  return (
    <div
      className="share-donut"
      style={
        {
          "--share-angle": `${clampedShare * 360}deg`,
          "--share-color": color
        } as CSSProperties
      }
    >
      <div className="share-donut-ring" aria-hidden="true" />
      <div className="share-donut-copy">
        <strong>{label}</strong>
        <span>{caption}</span>
      </div>
    </div>
  );
}

function ReadingBar({ label, total, value }: { label: string; total: number; value: number }) {
  const share = total ? Math.min(1, value / total) : 0;
  return (
    <div className="reading-row">
      <div>
        <span>{label}</span>
        <strong>
          {formatNumber(value)} / {formatNumber(total)}
        </strong>
      </div>
      <i className="reading-bar">
        <em style={{ width: `${share * 100}%` }} />
      </i>
    </div>
  );
}

function DetailComparisonBar({
  color,
  max,
  showValueLabel = true,
  value,
  valueLabel
}: {
  color: string;
  max: number;
  showValueLabel?: boolean;
  value: number;
  valueLabel: string;
}) {
  const share = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <div aria-label={valueLabel} className="detail-bar-row" title={valueLabel}>
      <i>
        <em style={{ backgroundColor: color, width: `${share * 100}%` }} />
        {showValueLabel ? <b>{valueLabel}</b> : null}
      </i>
    </div>
  );
}

function cssTextForExport(): string {
  return [...document.styleSheets]
    .map((sheet) => {
      try {
        return [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
      } catch {
        return "";
      }
    })
    .join("\n");
}

function filenameSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function sharedProcessViewFilename(subsets: SubsetDefinition[]): string {
  const prefix =
    subsets
      .map((subset) => filenameSlug(subset.name))
      .filter(Boolean)
      .slice(0, 4)
      .join("__") || "selected-subsets";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${prefix}__shared-process-view__${timestamp}.png`;
}

async function downloadSvgAsPng(svg: SVGSVGElement, filename: string) {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = cssTextForExport();
  clone.insertBefore(style, clone.firstChild);

  const viewBox = svg.viewBox.baseVal;
  const width = Math.max(1, Math.round(viewBox?.width || svg.clientWidth || svgWidth));
  const height = Math.max(1, Math.round(viewBox?.height || svg.clientHeight || svgHeight));
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));

  const svgBlob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("The process view image could not be rendered."));
    image.src = svgUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas export is not available in this browser.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  URL.revokeObjectURL(svgUrl);

  const link = document.createElement("a");
  link.download = filename;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

function SubsetList({
  subsets,
  selectedIds,
  toggleSelected,
  deleteSubset,
  loadSubsetIntoBuilder,
  subsetStyles,
  updateSubsetStyle
}: {
  subsets: SubsetDefinition[];
  selectedIds: string[];
  toggleSelected: (id: string) => void;
  deleteSubset?: (id: string) => void;
  loadSubsetIntoBuilder?: (subset: SubsetDefinition) => void;
  subsetStyles?: Record<string, Partial<SubsetVisualStyle>>;
  updateSubsetStyle?: (subsetId: string, patch: Partial<SubsetVisualStyle>) => void;
}) {
  const canEditStyles = Boolean(subsetStyles && updateSubsetStyle);
  const selectedOrder = new Map(selectedIds.map((id, index) => [id, index]));
  const orderedSubsets = [...subsets].sort((a, b) => {
    const aSelected = selectedOrder.has(a.id);
    const bSelected = selectedOrder.has(b.id);
    if (aSelected && bSelected) return (selectedOrder.get(a.id) ?? 0) - (selectedOrder.get(b.id) ?? 0);
    if (aSelected !== bSelected) return aSelected ? -1 : 1;
    return subsets.indexOf(a) - subsets.indexOf(b);
  });

  return (
    <div className="subset-list">
      {orderedSubsets.map((subset) => {
        const selected = selectedIds.includes(subset.id);
        const style = subsetStyle(subset, selectedIds.indexOf(subset.id), subsetStyles ?? {});
        return (
          <div className={selected && canEditStyles ? "subset-card editable" : "subset-card"} key={subset.id}>
            <div className="subset-card-header">
              <div className="subset-card-toggle" title={subset.description || subset.name}>
                <Checkbox
                  aria-label={`Select ${subset.name} for comparison`}
                  checked={selected}
                  className="theme-checkbox subset-select-checkbox"
                  color="blue"
                  onChange={() => toggleSelected(subset.id)}
                  size="xs"
                />
                <span className="subset-swatch" style={{ background: canEditStyles && selected ? style.color : subset.color }} />
                <span className="subset-card-main">
                  <span className="subset-name-row">
                    {loadSubsetIntoBuilder ? (
                      <button
                        className="subset-refine-button"
                        onClick={() => loadSubsetIntoBuilder(subset)}
                        title="Load this subset into the builder to refine it"
                        type="button"
                      >
                        <strong>{subset.name}</strong>
                      </button>
                    ) : (
                      <strong>{subset.name}</strong>
                    )}
                    <InfoTip label={`Show ${subset.name} description`}>
                      {subset.description || subsetFormula(subset)}
                    </InfoTip>
                  </span>
                  {subset.description ? <em className="sr-only">{subset.description}</em> : null}
                </span>
              </div>
              {deleteSubset ? (
                <button
                  aria-label={`Delete ${subset.name}`}
                  className="icon-danger"
                  onClick={() => deleteSubset(subset.id)}
                  title="Delete subset"
                  type="button"
                >
                  <Trash2 size={15} />
                </button>
              ) : null}
            </div>
            {canEditStyles && selected && updateSubsetStyle ? (
              <div className="subset-inline-style">
                <div className="color-grid" aria-label={`${subset.name} color`}>
                  {colors.map((color) => (
                    <button
                      aria-label={`Use ${color}`}
                      className={style.color === color ? "color-swatch selected" : "color-swatch"}
                      key={color}
                      onClick={() => updateSubsetStyle(subset.id, { color })}
                      style={{ background: color }}
                      type="button"
                    />
                  ))}
                </div>
                <details className="style-grid style-grid-collapsed">
                  <summary>Line Style</summary>
                  <div className="field">
                    <div className="style-choice-grid" role="group" aria-label={`${subset.name} line pattern`}>
                      {(["solid", "dashed", "dotted", "dashdot"] as LinePattern[]).map((pattern) => (
                        <button
                          aria-label={`${linePatternLabel(pattern)} line pattern`}
                          className={style.linePattern === pattern ? "style-choice selected" : "style-choice"}
                          key={pattern}
                          onClick={() => updateSubsetStyle(subset.id, { linePattern: pattern })}
                          type="button"
                        >
                          <svg aria-hidden="true" className="style-choice-preview" viewBox="0 0 58 10">
                            <line
                              stroke={style.color}
                              strokeDasharray={lineDashArray(pattern, 4)}
                              strokeLinecap="round"
                              strokeWidth="4"
                              x1="3"
                              x2="55"
                              y1="5"
                              y2="5"
                            />
                          </svg>
                          <span>{linePatternLabel(pattern)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </details>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function graphEmptyState({
  activityCaseShareThreshold,
  activityScope,
  baseNodeCount,
  candidateEdgeCount,
  pathCaseShareThreshold,
  pathMode
}: {
  activityCaseShareThreshold: number;
  activityScope: ActivityScope;
  baseNodeCount: number;
  candidateEdgeCount: number;
  pathCaseShareThreshold: number;
  pathMode: PathMode;
}): { title: string; detail: string } {
  const activityThreshold = formatThresholdPercent(activityCaseShareThreshold);
  const pathThreshold = formatThresholdPercent(pathCaseShareThreshold);
  if (baseNodeCount === 0) {
    if (activityScope === "specific") {
      return {
        title: "No activities to show",
        detail: `No unique activity passes the current ${activityThreshold}% activity coverage. Check whether Graph Adjustment coverage or the activity limit is too strict.`
      };
    }
    if (activityScope === "common") {
      return {
        title: "No activities to show",
        detail: `No shared activity passes the current ${activityThreshold}% activity coverage. Check whether Graph Adjustment coverage or the activity limit is too strict.`
      };
    }
    return {
      title: "No activities to show",
      detail: `No activity passes the current ${activityThreshold}% activity coverage. Check whether Graph Adjustment coverage or the activity limit is too strict.`
    };
  }
  if (candidateEdgeCount === 0) {
    if (pathMode === "specific") {
      return {
        title: "No unique connections at this coverage",
        detail: `Activities are visible, but no source-target connection qualifies in exactly one selected subset at the current ${pathThreshold}% connection coverage. Adjust the coverage or switch Connection Visibility back to any subset.`
      };
    }
    if (pathMode === "shared") {
      return {
        title: "No shared connections at this coverage",
        detail: `Activities are visible, but no source-target connection qualifies in every selected subset at the current ${pathThreshold}% connection coverage. Lower the coverage or use any selected subset.`
      };
    }
  }
  return {
    title: "No connections match the current graph controls",
    detail: "Increase the visible connection or activity limit, lower the coverage controls, or switch the visibility controls back to all eligible activities and connections."
  };
}

function totalEdgeCount(edge: SharedDfgEdge, selectedIds: string[]): number {
  return selectedIds.reduce((sum, id) => sum + metricOrEmpty(edge, id).count, 0);
}

function layoutEdgeWeight(edge: SharedDfgEdge, selectedIds: string[]): number {
  if (edge.source === edge.target) return 1;
  const shareWeight = maxEdgeCaseShare(edge, selectedIds) * 8;
  const frequencyWeight = Math.min(3, Math.floor(Math.log10(totalEdgeCount(edge, selectedIds) + 1)));
  return Math.max(1, Math.min(12, 1 + Math.round(shareWeight) + frequencyWeight));
}

type HorizontalReciprocalPair = {
  activities: [string, string];
  directionCount: number;
  isShared: boolean;
  maxCaseShare: number;
  totalFrequency: number;
};

type GraphvizLayoutEdgeRequest = GraphvizLayoutRequest["edges"][number];

type MainFlowCorridorLayout = {
  centerNodes: string[];
  compactMainFlow: boolean;
  nodeRoles: Record<string, GraphvizLayoutNodeRole>;
};

const maxHorizontalReciprocalPairs = 3;
const incidentalPathCaseShareThreshold = 0.02;
const strongRelativeEdgeRatio = 0.65;
const mediumRelativeEdgeRatio = 0.45;

function canonicalActivityPair(source: string, target: string): [string, string] {
  return source.localeCompare(target) <= 0 ? [source, target] : [target, source];
}

function reciprocalPairKey(source: string, target: string): string {
  return JSON.stringify(canonicalActivityPair(source, target));
}

function visibleBusinessIncidentCounts(edges: SharedDfgEdge[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    if (isBoundaryActivityName(edge.source) || isBoundaryActivityName(edge.target)) continue;
    counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
  }
  return counts;
}

function isIncidentalLayoutEdge(edge: SharedDfgEdge, selectedIds: string[], incidentCounts: Map<string, number>): boolean {
  if (edge.source === edge.target) return false;
  if (isBoundaryActivityName(edge.source) || isBoundaryActivityName(edge.target)) return false;
  if (maxEdgeCaseShare(edge, selectedIds) >= incidentalPathCaseShareThreshold) return false;
  return (incidentCounts.get(edge.source) ?? 0) > 1 && (incidentCounts.get(edge.target) ?? 0) > 1;
}

function layoutOrderPosition(activity: string, positionByActivity: Map<string, number>): number {
  if (activity === "Start") return -0.05;
  if (activity === "End") return 1.05;
  return positionByActivity.get(activity) ?? 0.5;
}

function selectHorizontalReciprocalGroups(
  visibleEdges: SharedDfgEdge[],
  visibleEdgePairs: Set<string>,
  selectedIds: string[],
  incidentCounts: Map<string, number>
): string[][] {
  const pairs = new Map<string, HorizontalReciprocalPair>();
  const pairEdges = new Map<string, SharedDfgEdge[]>();
  for (const edge of visibleEdges) {
    if (edge.source === edge.target) continue;
    if (isBoundaryActivityName(edge.source) || isBoundaryActivityName(edge.target)) continue;
    if (!visibleEdgePairs.has(`${edge.target}__${edge.source}`)) continue;
    if (isIncidentalLayoutEdge(edge, selectedIds, incidentCounts)) continue;
    const key = reciprocalPairKey(edge.source, edge.target);
    const activities = canonicalActivityPair(edge.source, edge.target);
    const current = pairs.get(key) ?? {
      activities,
      directionCount: 0,
      isShared: false,
      maxCaseShare: 0,
      totalFrequency: 0
    };
    current.directionCount += 1;
    current.isShared = current.isShared || (selectedIds.length > 1 && subsetIdsForEdge(edge, selectedIds).length === selectedIds.length);
    current.maxCaseShare = Math.max(current.maxCaseShare, maxEdgeCaseShare(edge, selectedIds));
    current.totalFrequency += totalEdgeCount(edge, selectedIds);
    pairs.set(key, current);
    pairEdges.set(key, [...(pairEdges.get(key) ?? []), edge]);
  }

  const usedActivities = new Set<string>();
  const groups: string[][] = [];
  for (const pair of [...pairs.values()]
    .filter((candidate) => candidate.directionCount >= 2)
    .filter((candidate) => {
      const edges = pairEdges.get(JSON.stringify(candidate.activities)) ?? [];
      if (edges.length < 2) return false;
      const shares = edges.map((edge) => maxEdgeCaseShare(edge, selectedIds));
      const strongest = Math.max(...shares);
      const weakest = Math.min(...shares);
      if (strongest <= 0) return false;
      return weakest >= incidentalPathCaseShareThreshold && weakest >= strongest * 0.25;
    })
    .sort(
      (a, b) =>
        b.maxCaseShare - a.maxCaseShare ||
        b.totalFrequency - a.totalFrequency ||
        Number(b.isShared) - Number(a.isShared) ||
        a.activities[0].localeCompare(b.activities[0]) ||
        a.activities[1].localeCompare(b.activities[1])
    )) {
    if (pair.activities.some((activity) => usedActivities.has(activity))) continue;
    groups.push(pair.activities);
    for (const activity of pair.activities) usedActivities.add(activity);
    if (groups.length >= maxHorizontalReciprocalPairs) break;
  }
  return groups;
}

function graphvizEdgeRole(
  edge: SharedDfgEdge,
  selectedIds: string[],
  sourcePosition: number,
  targetPosition: number,
  horizontalReciprocalPairKeys: Set<string>,
  isIncidentalPath: boolean,
  relativeWeightBoost: number
): GraphvizLayoutEdgeRole {
  if (edge.source === edge.target) return "self";
  if (isIncidentalPath && targetPosition - sourcePosition < -0.02) return "backward";
  if (isIncidentalPath) return "side";
  if (horizontalReciprocalPairKeys.has(reciprocalPairKey(edge.source, edge.target))) return "reciprocal";
  const isBoundaryPath = isBoundaryActivityName(edge.source) || isBoundaryActivityName(edge.target);
  const isSharedPath = selectedIds.length > 1 && subsetIdsForEdge(edge, selectedIds).length === selectedIds.length;
  const isStrongCurrentDirection = relativeWeightBoost >= 2 || maxEdgeCaseShare(edge, selectedIds) >= 0.08;
  if (targetPosition - sourcePosition < -0.02 && !isStrongCurrentDirection) return "backward";
  const isHighImportancePath = layoutEdgeWeight(edge, selectedIds) >= 7 || maxEdgeCaseShare(edge, selectedIds) >= 0.35 || relativeWeightBoost >= 2;
  return isBoundaryPath || isSharedPath || isHighImportancePath ? "main" : "side";
}

function graphvizRoleConstraint(role: GraphvizLayoutEdgeRole): boolean {
  return role === "main" || role === "side";
}

function graphvizRoleMinlen(role: GraphvizLayoutEdgeRole, positionDelta: number): number {
  if (!graphvizRoleConstraint(role)) return 1;
  const positiveDelta = Math.max(0, positionDelta);
  const maxExtra = role === "main" ? 4 : 2;
  const scale = role === "main" ? 6 : 4;
  return 1 + Math.min(maxExtra, Math.floor(positiveDelta * scale));
}

function relativeEdgeWeightBoost(edge: SharedDfgEdge, selectedIds: string[], maxVisibleCount: number, maxVisibleCaseShare: number): number {
  if (edge.source === edge.target) return 0;
  const countRatio = maxVisibleCount > 0 ? totalEdgeCount(edge, selectedIds) / maxVisibleCount : 0;
  const shareRatio = maxVisibleCaseShare > 0 ? maxEdgeCaseShare(edge, selectedIds) / maxVisibleCaseShare : 0;
  const relativeRatio = Math.max(countRatio, shareRatio);
  if (relativeRatio >= strongRelativeEdgeRatio) return 4;
  if (relativeRatio >= mediumRelativeEdgeRatio) return 2;
  return 0;
}

function graphvizEdgeMinlen(role: GraphvizLayoutEdgeRole, positionDelta: number, relativeWeightBoost: number): number {
  const baseMinlen = graphvizRoleMinlen(role, positionDelta);
  if (role !== "main" && role !== "side") return baseMinlen;
  if (relativeWeightBoost >= 2) return Math.max(baseMinlen, 2);
  return baseMinlen;
}

function isBusinessLayoutEdge(edge: Pick<SharedDfgEdge, "source" | "target">): boolean {
  return edge.source !== edge.target && !isBoundaryActivityName(edge.source) && !isBoundaryActivityName(edge.target);
}

function boundarylessRankHints(nodes: SharedDfgNode[], edges: GraphvizLayoutEdgeRequest[], useGlobalProcessOrder = true): GraphvizLayoutRequest["rankHints"] {
  const activities = nodes.map((node) => node.activity);
  if (!activities.length || activities.includes("Start") || activities.includes("End")) return [];
  const constrainedEdges = edges.filter((edge) => edge.constraint !== false && edge.source !== edge.target);
  if (!constrainedEdges.length) return [];
  const incoming = new Set(constrainedEdges.map((edge) => edge.target));
  const outgoing = new Set(constrainedEdges.map((edge) => edge.source));
  const topNodes = activities.filter((activity) => outgoing.has(activity) && !incoming.has(activity));
  const bottomNodes = activities.filter((activity) => incoming.has(activity) && !outgoing.has(activity));
  const ordered = useGlobalProcessOrder ? [...nodes].sort((a, b) => nodeAveragePosition(a) - nodeAveragePosition(b) || a.activity.localeCompare(b.activity)) : nodes;
  return [
    { rank: "min", nodes: topNodes.length ? topNodes : [ordered[0].activity] },
    { rank: "max", nodes: bottomNodes.length ? bottomNodes : [ordered[ordered.length - 1].activity] }
  ];
}

function boundarylessRankGuideEdges(nodes: SharedDfgNode[], edges: GraphvizLayoutEdgeRequest[]): GraphvizLayoutRequest["rankGuideEdges"] {
  const activities = new Set(nodes.map((node) => node.activity));
  if (!activities.size || activities.has("Start") || activities.has("End")) return [];
  return edges
    .filter((edge) => edge.constraint !== false && edge.source !== edge.target)
    .filter((edge) => activities.has(edge.source) && activities.has(edge.target))
    .filter((edge) => edge.role === "main" || edge.role === "side")
    .map((edge) => ({
      minlen: Math.max(2, edge.minlen ?? 1),
      source: edge.source,
      target: edge.target,
      weight: Math.max(12, edge.weight ?? 1)
    }));
}

function deriveMainFlowCorridorLayout(
  displayNodes: SharedDfgNode[],
  visibleEdges: SharedDfgEdge[],
  layoutEdges: GraphvizLayoutEdgeRequest[],
  selectedIds: string[]
): MainFlowCorridorLayout {
  const visibleBusinessEdgeCount = visibleEdges.filter(isBusinessLayoutEdge).length;
  const corridorEdges = visibleEdges.filter((edge, index) => layoutEdges[index]?.role === "main" && isBusinessLayoutEdge(edge));
  const corridorBusinessNodes = new Set<string>();
  for (const edge of corridorEdges) {
    corridorBusinessNodes.add(edge.source);
    corridorBusinessNodes.add(edge.target);
  }
  const requiredCorridorEdges = Math.max(2, Math.ceil(Math.max(1, visibleBusinessEdgeCount) * 0.35));
  const corridorEnabled = corridorBusinessNodes.size >= 3 && corridorEdges.length >= requiredCorridorEdges;
  const displayActivitySet = new Set(displayNodes.map((node) => node.activity));
  const nodeRoles: Record<string, GraphvizLayoutNodeRole> = {};

  if (corridorEnabled) {
    if (displayActivitySet.has("Start")) nodeRoles.Start = "main";
    if (displayActivitySet.has("End")) nodeRoles.End = "main";
    for (const activity of corridorBusinessNodes) {
      if (displayActivitySet.has(activity)) nodeRoles[activity] = "main";
    }
  }

  const incidentStats = new Map<string, { hasImportantIncident: boolean; incidentCount: number; totalWeight: number }>();
  for (const [index, edge] of visibleEdges.entries()) {
    const layoutEdge = layoutEdges[index];
    if (!layoutEdge) continue;
    const isImportantIncident =
      layoutEdge.role === "main" ||
      (selectedIds.length > 1 && subsetIdsForEdge(edge, selectedIds).length === selectedIds.length) ||
      (layoutEdge.weight ?? 1) >= 7 ||
      maxEdgeCaseShare(edge, selectedIds) >= 0.35;
    for (const activity of [edge.source, edge.target]) {
      if (isBoundaryActivityName(activity)) continue;
      const current = incidentStats.get(activity) ?? { hasImportantIncident: false, incidentCount: 0, totalWeight: 0 };
      current.hasImportantIncident = current.hasImportantIncident || isImportantIncident;
      current.incidentCount += 1;
      current.totalWeight += layoutEdge.weight ?? 1;
      incidentStats.set(activity, current);
    }
  }

  for (const node of displayNodes) {
    if (isBoundaryActivityName(node.activity) || nodeRoles[node.activity] === "main") continue;
    const stats = incidentStats.get(node.activity) ?? { hasImportantIncident: false, incidentCount: 0, totalWeight: 0 };
    nodeRoles[node.activity] = !stats.hasImportantIncident && (stats.incidentCount <= 2 || stats.totalWeight <= 8) ? "weak" : "side";
  }

  const visibleBusinessNodeCount = displayNodes.filter((node) => !isBoundaryActivityName(node.activity)).length;
  const reciprocalEdgeCount = layoutEdges.filter((edge) => edge.role === "reciprocal").length;
  const corridorCoverage = visibleBusinessNodeCount > 0 ? corridorBusinessNodes.size / visibleBusinessNodeCount : 0;
  const compactMainFlow =
    corridorEnabled &&
    visibleBusinessNodeCount > 0 &&
    visibleBusinessNodeCount <= 8 &&
    reciprocalEdgeCount <= 2 &&
    corridorCoverage >= 0.7 &&
    corridorEdges.length >= Math.max(2, Math.ceil(Math.max(1, visibleBusinessEdgeCount) * 0.55));

  return {
    centerNodes: corridorEnabled ? [...corridorBusinessNodes].filter((activity) => displayActivitySet.has(activity)) : [],
    compactMainFlow,
    nodeRoles
  };
}

function nodePosition(node: SharedDfgNode, _index: number, allNodes: SharedDfgNode[]) {
  const orderedNodes = [...allNodes].sort(
    (a, b) => nodeAveragePosition(a) - nodeAveragePosition(b) || a.activity.localeCompare(b.activity)
  );
  const rank = Math.max(0, orderedNodes.findIndex((candidate) => candidate.activity === node.activity));
  const yStart = 115;
  const yEnd = svgHeight - 120;
  const y = orderedNodes.length <= 1 ? (yStart + yEnd) / 2 : yStart + (yEnd - yStart) * (rank / (orderedNodes.length - 1));
  const x = svgWidth / 2;
  return { x, y };
}

function inferAddedNodePosition(
  activity: string,
  positioned: Map<string, { x: number; y: number }>,
  visibleEdges: SharedDfgEdge[]
) {
  const incoming = visibleEdges
    .filter((edge) => edge.target === activity && positioned.has(edge.source))
    .sort((a, b) => totalEdgeCount(b, Object.keys(b.metricsBySubset)) - totalEdgeCount(a, Object.keys(a.metricsBySubset)));
  const outgoing = visibleEdges
    .filter((edge) => edge.source === activity && positioned.has(edge.target))
    .sort((a, b) => totalEdgeCount(b, Object.keys(b.metricsBySubset)) - totalEdgeCount(a, Object.keys(a.metricsBySubset)));
  const strongestIncoming = incoming[0] ? positioned.get(incoming[0].source) : null;
  const strongestOutgoing = outgoing[0] ? positioned.get(outgoing[0].target) : null;
  if (strongestIncoming && strongestOutgoing) {
    return clampNodePosition({
      x: (strongestIncoming.x + strongestOutgoing.x) / 2,
      y: (strongestIncoming.y + strongestOutgoing.y) / 2
    });
  }
  if (strongestIncoming) {
    return clampNodePosition({ x: strongestIncoming.x, y: strongestIncoming.y + 135 });
  }
  if (strongestOutgoing) {
    return clampNodePosition({ x: strongestOutgoing.x, y: strongestOutgoing.y - 135 });
  }
  return null;
}

function displayNodePositions(
  displayNodes: SharedDfgNode[],
  visibleEdges: SharedDfgEdge[],
  nodePositions: Record<string, { x: number; y: number }>,
  graphvizPositions: Record<string, { x: number; y: number }> | null
) {
  const positioned = new Map<string, { x: number; y: number }>();
  displayNodes.forEach((node) => {
    const position = nodePositions[node.activity] ?? graphvizPositions?.[node.activity];
    if (isFiniteGraphPoint(position)) positioned.set(node.activity, position);
  });
  displayNodes.forEach((node, index) => {
    if (positioned.has(node.activity)) return;
    positioned.set(node.activity, inferAddedNodePosition(node.activity, positioned, visibleEdges) ?? nodePosition(node, index, displayNodes));
  });
  return positioned;
}

function isFiniteGraphPoint(point: unknown): point is { x: number; y: number } {
  return (
    Boolean(point) &&
    typeof point === "object" &&
    Number.isFinite((point as { x?: unknown }).x) &&
    Number.isFinite((point as { y?: unknown }).y)
  );
}

function visualNodeWidth(node: SharedDfgNode, selectedIds: string[], maxNodeShare: number): number {
  if (isBoundaryActivityName(node.activity)) return boundaryNodeRadius * 2;
  const nodeShare = Math.max(...selectedIds.map((id) => node.metricsBySubset[id]?.caseShare ?? 0));
  return 118 + Math.min(42, (nodeShare / maxNodeShare) * 34);
}

function roundedElbowPath(
  start: { x: number; y: number },
  cornerA: { x: number; y: number },
  cornerB: { x: number; y: number },
  end: { x: number; y: number },
  radius: number
): string {
  const firstLength = Math.abs(cornerA.y - start.y);
  const middleLength = Math.abs(cornerB.x - cornerA.x);
  const lastLength = Math.abs(end.y - cornerB.y);
  const firstRadius = Math.min(radius, firstLength / 2, middleLength / 2);
  const secondRadius = Math.min(radius, middleLength / 2, lastLength / 2);

  if (firstRadius < 2 || secondRadius < 2) {
    return `M ${start.x} ${start.y} L ${cornerA.x} ${cornerA.y} L ${cornerB.x} ${cornerB.y} L ${end.x} ${end.y}`;
  }

  const firstDirectionY = Math.sign(cornerA.y - start.y) || 1;
  const middleDirectionX = Math.sign(cornerB.x - cornerA.x) || 1;
  const lastDirectionY = Math.sign(end.y - cornerB.y) || 1;
  const beforeCornerA = { x: cornerA.x, y: cornerA.y - firstDirectionY * firstRadius };
  const afterCornerA = { x: cornerA.x + middleDirectionX * firstRadius, y: cornerA.y };
  const beforeCornerB = { x: cornerB.x - middleDirectionX * secondRadius, y: cornerB.y };
  const afterCornerB = { x: cornerB.x, y: cornerB.y + lastDirectionY * secondRadius };

  return [
    `M ${start.x} ${start.y}`,
    `L ${beforeCornerA.x} ${beforeCornerA.y}`,
    `Q ${cornerA.x} ${cornerA.y} ${afterCornerA.x} ${afterCornerA.y}`,
    `L ${beforeCornerB.x} ${beforeCornerB.y}`,
    `Q ${cornerB.x} ${cornerB.y} ${afterCornerB.x} ${afterCornerB.y}`,
    `L ${end.x} ${end.y}`
  ].join(" ");
}

function lineIntersection(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number }
) {
  const dax = a2.x - a1.x;
  const day = a2.y - a1.y;
  const dbx = b2.x - b1.x;
  const dby = b2.y - b1.y;
  const denominator = dax * dby - day * dbx;
  if (Math.abs(denominator) < 0.001) return null;
  const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / denominator;
  return { x: a1.x + dax * t, y: a1.y + day * t };
}

type NodeObstacle = {
  activity: string;
  bottom: number;
  left: number;
  right: number;
  top: number;
};

function rangesOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return Math.max(aMin, bMin) <= Math.min(aMax, bMax);
}

function segmentCrossesObstacle(
  a: { x: number; y: number },
  b: { x: number; y: number },
  obstacle: NodeObstacle
): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  if (Math.abs(a.y - b.y) < 0.001) {
    return a.y >= obstacle.top && a.y <= obstacle.bottom && rangesOverlap(minX, maxX, obstacle.left, obstacle.right);
  }
  if (Math.abs(a.x - b.x) < 0.001) {
    return a.x >= obstacle.left && a.x <= obstacle.right && rangesOverlap(minY, maxY, obstacle.top, obstacle.bottom);
  }
  return rangesOverlap(minX, maxX, obstacle.left, obstacle.right) && rangesOverlap(minY, maxY, obstacle.top, obstacle.bottom);
}

function elbowCrossesObstacle(
  source: string | undefined,
  target: string | undefined,
  points: Array<{ x: number; y: number }>,
  obstacles: NodeObstacle[]
): boolean {
  return obstacles
    .filter((obstacle) => obstacle.activity !== source && obstacle.activity !== target)
    .some((obstacle) => points.slice(0, -1).some((point, index) => segmentCrossesObstacle(point, points[index + 1], obstacle)));
}

function avoidNodeObstacleElbowY({
  baseEnd,
  baseStart,
  directionY,
  elbowY,
  source,
  target,
  obstacles
}: {
  baseEnd: { x: number; y: number };
  baseStart: { x: number; y: number };
  directionY: number;
  elbowY: number;
  source?: string;
  target?: string;
  obstacles: NodeObstacle[];
}): number {
  if (!obstacles.length) return elbowY;
  const route = (candidateY: number) => [
    baseStart,
    { x: baseStart.x, y: candidateY },
    { x: baseEnd.x, y: candidateY },
    baseEnd
  ];
  if (!elbowCrossesObstacle(source, target, route(elbowY), obstacles)) return elbowY;

  const minY = Math.min(baseStart.y, baseEnd.y);
  const maxY = Math.max(baseStart.y, baseEnd.y);
  const horizontalMinX = Math.min(baseStart.x, baseEnd.x);
  const horizontalMaxX = Math.max(baseStart.x, baseEnd.x);
  const blocking = obstacles
    .filter((obstacle) => obstacle.activity !== source && obstacle.activity !== target)
    .filter((obstacle) => rangesOverlap(horizontalMinX, horizontalMaxX, obstacle.left, obstacle.right))
    .filter((obstacle) => rangesOverlap(minY, maxY, obstacle.top, obstacle.bottom) || (elbowY >= obstacle.top && elbowY <= obstacle.bottom));
  const padding = 30;
  const candidates = blocking.flatMap((obstacle) => [
    obstacle.bottom + padding,
    obstacle.top - padding
  ]);
  candidates.push(elbowY + directionY * 90, elbowY - directionY * 90);
  const boundedCandidates = candidates.filter((candidate) => candidate > minY + 12 && candidate < maxY - 12);
  boundedCandidates.sort((a, b) => Math.abs(a - elbowY) - Math.abs(b - elbowY));
  return boundedCandidates.find((candidate) => !elbowCrossesObstacle(source, target, route(candidate), obstacles)) ?? elbowY;
}

function offsetPolyline(points: Array<{ x: number; y: number }>, offset: number) {
  if (Math.abs(offset) < 0.001 || points.length < 2) return points;

  const segments = points.slice(0, -1).map((point, index) => {
    const next = points[index + 1];
    const dx = next.x - point.x;
    const dy = next.y - point.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const normal = { x: -dy / length, y: dx / length };
    return {
      from: { x: point.x + normal.x * offset, y: point.y + normal.y * offset },
      to: { x: next.x + normal.x * offset, y: next.y + normal.y * offset },
      normal
    };
  });

  return points.map((point, index) => {
    if (index === 0) return segments[0].from;
    if (index === points.length - 1) return segments[segments.length - 1].to;

    const previous = segments[index - 1];
    const next = segments[index];
    const intersection = lineIntersection(previous.from, previous.to, next.from, next.to);
    if (intersection && Math.hypot(intersection.x - point.x, intersection.y - point.y) < Math.max(45, Math.abs(offset) * 4)) {
      return intersection;
    }

    return {
      x: point.x + ((previous.normal.x + next.normal.x) / 2) * offset,
      y: point.y + ((previous.normal.y + next.normal.y) / 2) * offset
    };
  });
}

function boundaryPointOnNode(
  center: { x: number; y: number },
  ux: number,
  uy: number,
  isBoundary: boolean,
  gap = 2,
  halfWidth = nodeHalfWidth,
  halfHeight = nodeHalfHeight
) {
  if (isBoundary) {
    return {
      x: center.x + ux * (boundaryNodeRadius + gap),
      y: center.y + uy * (boundaryNodeRadius + gap)
    };
  }
  const xLimit = Math.abs(ux) > 0.001 ? halfWidth / Math.abs(ux) : Number.POSITIVE_INFINITY;
  const yLimit = Math.abs(uy) > 0.001 ? halfHeight / Math.abs(uy) : Number.POSITIVE_INFINITY;
  const distance = Math.min(xLimit, yLimit) + gap;
  return {
    x: center.x + ux * distance,
    y: center.y + uy * distance
  };
}

function shiftedBoundaryPointOnNode(
  center: { x: number; y: number },
  ux: number,
  uy: number,
  normal: { x: number; y: number },
  shift: number,
  isBoundary: boolean,
  halfWidth = nodeHalfWidth,
  halfHeight = nodeHalfHeight
) {
  if (isBoundary) {
    const distance = boundaryNodeRadius;
    return {
      x: center.x + ux * distance + normal.x * shift,
      y: center.y + uy * distance + normal.y * shift
    };
  }

  const base = boundaryPointOnNode(center, ux, uy, false, 0, halfWidth, halfHeight);
  const xIsBoundary = Math.abs(base.x - center.x) >= halfWidth - 0.5;
  const yIsBoundary = Math.abs(base.y - center.y) >= halfHeight - 0.5;
  const inset = 5;

  if (yIsBoundary && Math.abs(normal.x) > 0.001) {
    return {
      x: Math.min(center.x + halfWidth - inset, Math.max(center.x - halfWidth + inset, base.x + normal.x * shift)),
      y: base.y
    };
  }

  if (xIsBoundary && Math.abs(normal.y) > 0.001) {
    return {
      x: base.x,
      y: Math.min(center.y + halfHeight - inset, Math.max(center.y - halfHeight + inset, base.y + normal.y * shift))
    };
  }

  return {
    x: Math.min(center.x + halfWidth - inset, Math.max(center.x - halfWidth + inset, base.x + normal.x * shift)),
    y: Math.min(center.y + halfHeight - inset, Math.max(center.y - halfHeight + inset, base.y + normal.y * shift))
  };
}

function reciprocalBoundaryPointOnNode(
  center: { x: number; y: number },
  ux: number,
  uy: number,
  laneOffset: number,
  isBoundary: boolean,
  halfWidth = nodeHalfWidth,
  halfHeight = nodeHalfHeight
) {
  if (isBoundary) {
    return shiftedBoundaryPointOnNode(center, ux, uy, { x: -uy, y: ux }, laneOffset, true, halfWidth, halfHeight);
  }

  const base = boundaryPointOnNode(center, ux, uy, false, 0, halfWidth, halfHeight);
  const xIsBoundary = Math.abs(base.x - center.x) >= halfWidth - 0.5;
  const yIsBoundary = Math.abs(base.y - center.y) >= halfHeight - 0.5;
  const inset = 7;
  if (xIsBoundary) {
    return {
      x: base.x,
      y: Math.min(center.y + halfHeight - inset, Math.max(center.y - halfHeight + inset, base.y + laneOffset))
    };
  }
  if (yIsBoundary) {
    return {
      x: Math.min(center.x + halfWidth - inset, Math.max(center.x - halfWidth + inset, base.x + laneOffset)),
      y: base.y
    };
  }
  return shiftedBoundaryPointOnNode(center, ux, uy, { x: -uy, y: ux }, laneOffset, false, halfWidth, halfHeight);
}

function labelProgressForSubset(subsetIndex: number, subsetCount: number) {
  if (subsetCount <= 1) return 0.5;
  const normalizedIndex = subsetIndex / Math.max(1, subsetCount - 1);
  const span = Math.min(0.24, 0.07 * (subsetCount - 1));
  return 0.5 + (normalizedIndex - 0.5) * span;
}

function stableLaneNormalForConnection(source: { x: number; y: number }, target: { x: number; y: number }) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  if (Math.abs(dy) >= Math.abs(dx)) {
    const directionY = dy >= 0 ? 1 : -1;
    return { x: -directionY, y: 0 };
  }

  const directionX = dx >= 0 ? 1 : -1;
  return { x: 0, y: directionX };
}

function edgePathGeometry(
  source: { x: number; y: number },
  target: { x: number; y: number },
  subsetIndex: number,
  subsetCount: number,
  isSelfLoop: boolean,
  arcCurvature: number,
  pathShape: PathShape,
  sourceIsBoundary = false,
  targetIsBoundary = false,
  isReciprocalPair = false,
  sourceNodeHalfWidth = nodeHalfWidth,
  targetNodeHalfWidth = nodeHalfWidth,
  obstacles: NodeObstacle[] = [],
  sourceActivity?: string,
  targetActivity?: string
) {
  const curveScale = Math.min(1.8, Math.max(0.1, pathShape === "curved" ? arcCurvature : defaultArcCurvature));
  const laneOffset = (subsetIndex - (subsetCount - 1) / 2) * edgeLaneSpacing;
  const labelProgress = labelProgressForSubset(subsetIndex, subsetCount);
  const arrowGap = 0;
  const nodeExitGap = 4;
  const sourceHalfHeight = sourceIsBoundary ? boundaryNodeRadius : nodeHalfHeight;
  const targetHalfHeight = targetIsBoundary ? boundaryNodeRadius : nodeHalfHeight;
  const sourceHalfWidth = sourceIsBoundary ? boundaryNodeRadius : sourceNodeHalfWidth;
  const targetHalfWidth = targetIsBoundary ? boundaryNodeRadius : targetNodeHalfWidth;

  if (isSelfLoop) {
    const loopControlX = 76;
    const loopControlY = 82;
    const loopStartX = source.x + sourceHalfWidth + arrowGap;
    const loopStartY = Math.min(source.y + sourceHalfHeight - 7, Math.max(source.y - sourceHalfHeight + 7, source.y + laneOffset * 0.45 - 9));
    const loopEndY = Math.min(source.y + sourceHalfHeight - 7, Math.max(source.y - sourceHalfHeight + 7, source.y + laneOffset * 0.45 + 9));
    const loopX = loopStartX + 22 + Math.abs(laneOffset) * 0.65;
    const loopY = source.y + laneOffset * 0.45;
    return {
      path: `M ${loopStartX} ${loopStartY} C ${loopX + loopControlX} ${loopY - loopControlY}, ${loopX + loopControlX} ${loopY + loopControlY}, ${loopStartX} ${loopEndY}`,
      arrowTip: { x: loopStartX, y: loopEndY },
      arrowTail: { x: loopX + loopControlX, y: loopY + loopControlY },
      labelX: loopX + loopControlX * 0.72,
      labelY: loopY - loopControlY * 0.66
    };
  }

  const downward = target.y >= source.y;

  if (isReciprocalPair) {
    const centerDx = target.x - source.x;
    const centerDy = target.y - source.y;
    const centerDistance = Math.max(1, Math.hypot(centerDx, centerDy));
    const ux = centerDx / centerDistance;
    const uy = centerDy / centerDistance;
    const normal = { x: -uy, y: ux };
    const corridorOffset = Math.max(28, (subsetCount * edgeLaneSpacing) / 2 + 14);
    const reciprocalStart = reciprocalBoundaryPointOnNode(source, ux, uy, laneOffset, sourceIsBoundary, sourceHalfWidth, sourceHalfHeight);
    const reciprocalEnd = reciprocalBoundaryPointOnNode(target, -ux, -uy, laneOffset, targetIsBoundary, targetHalfWidth, targetHalfHeight);
    const reciprocalDx = reciprocalEnd.x - reciprocalStart.x;
    const reciprocalDy = reciprocalEnd.y - reciprocalStart.y;
    const loopRadius = (Math.min(160, Math.max(48, centerDistance * 0.42)) + corridorOffset) * curveScale;
    const c1 = {
      x: reciprocalStart.x + reciprocalDx * 0.26 + normal.x * loopRadius,
      y: reciprocalStart.y + reciprocalDy * 0.26 + normal.y * loopRadius
    };
    const c2 = {
      x: reciprocalStart.x + reciprocalDx * 0.74 + normal.x * loopRadius,
      y: reciprocalStart.y + reciprocalDy * 0.74 + normal.y * loopRadius
    };
    const arrowTip = reciprocalEnd;
    return {
      path: `M ${reciprocalStart.x} ${reciprocalStart.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${arrowTip.x} ${arrowTip.y}`,
      arrowTip,
      arrowTail: c2,
      labelX: reciprocalStart.x + reciprocalDx * 0.5 + normal.x * loopRadius,
      labelY: reciprocalStart.y + reciprocalDy * 0.5 + normal.y * loopRadius - 5
    };
  }

  const centerDx = target.x - source.x;
  const centerDy = target.y - source.y;
  const centerDistance = Math.max(1, Math.hypot(centerDx, centerDy));
  const ux = centerDx / centerDistance;
  const uy = centerDy / centerDistance;
  const stableNormal = stableLaneNormalForConnection(source, target);
  const start = shiftedBoundaryPointOnNode(source, ux, uy, stableNormal, laneOffset, sourceIsBoundary, sourceHalfWidth, sourceHalfHeight);
  const end = shiftedBoundaryPointOnNode(target, -ux, -uy, stableNormal, laneOffset, targetIsBoundary, targetHalfWidth, targetHalfHeight);
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  if (pathShape === "straight") {
    return {
      path: `M ${start.x} ${start.y} L ${end.x} ${end.y}`,
      arrowTip: end,
      arrowTail: start,
      labelX: start.x + dx * labelProgress,
      labelY: start.y + dy * labelProgress - 6
    };
  }

  if (pathShape === "elbow") {
    const directionY = downward ? 1 : -1;
    const baseStart = boundaryPointOnNode(source, 0, directionY, sourceIsBoundary, nodeExitGap, sourceHalfWidth, sourceHalfHeight);
    const baseEnd = boundaryPointOnNode(target, 0, -directionY, targetIsBoundary, arrowGap, targetHalfWidth, targetHalfHeight);
    const baseDx = baseEnd.x - baseStart.x;
    const baseDy = baseEnd.y - baseStart.y;
    if (Math.abs(baseDx) < 1) {
      const laneX = baseStart.x - directionY * laneOffset;
      const startPoint = { x: laneX, y: baseStart.y };
      const arrowTip = { x: laneX, y: baseEnd.y };
      return {
        path: `M ${startPoint.x} ${startPoint.y} L ${arrowTip.x} ${arrowTip.y}`,
        arrowTip,
        arrowTail: startPoint,
        labelX: laneX + 8,
        labelY: baseStart.y + baseDy * labelProgress - 6
      };
    }
    const elbowY = avoidNodeObstacleElbowY({
      baseEnd,
      baseStart,
      directionY,
      elbowY: baseStart.y + baseDy * 0.55,
      obstacles,
      source: sourceActivity,
      target: targetActivity
    });
    const lanePoints = offsetPolyline([
      baseStart,
      { x: baseStart.x, y: elbowY },
      { x: baseEnd.x, y: elbowY },
      baseEnd
    ], laneOffset);
    const [startPoint, cornerA, cornerB, arrowTip] = lanePoints;
    const horizontalLaneOffset = Math.sign(baseDx || 1) * laneOffset;
    const radius = 14;
    return {
      path: roundedElbowPath(startPoint, cornerA, cornerB, arrowTip, radius),
      arrowTip,
      arrowTail: cornerB,
      labelX: baseStart.x + baseDx * labelProgress,
      labelY: elbowY + horizontalLaneOffset - 6
    };
  }

  const normal = stableNormal;
  const backwardBoost = downward ? 0 : 58;
  const curve = Math.min(115, Math.max(4, Math.abs(dx) * 0.1 + Math.abs(dy) * 0.2 + backwardBoost * 0.72)) * curveScale;
  const c1 = {
    x: start.x + dx * 0.18 + normal.x * curve * 1.08,
    y: start.y + dy * 0.1 + normal.y * curve * 1.08
  };
  const c2 = {
    x: start.x + dx * 0.82 + normal.x * curve * 1.08,
    y: start.y + dy * 0.9 + normal.y * curve * 1.08
  };
  const arrowTip = end;

  return {
    path: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${arrowTip.x} ${arrowTip.y}`,
    arrowTip,
    arrowTail: c2,
    labelX: start.x + dx * labelProgress + normal.x * curve,
    labelY: start.y + dy * labelProgress + normal.y * curve - 5
  };
}

function arrowDimensions(strokeWidth: number) {
  const widthDelta = Math.max(0, strokeWidth - 1.5) * 0.5;
  return {
    length: 15 + widthDelta,
    width: 7 + widthDelta * 0.45
  };
}

function arrowBaseCenter(tip: { x: number; y: number }, tail: { x: number; y: number }, strokeWidth: number) {
  const dx = tip.x - tail.x;
  const dy = tip.y - tail.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / distance;
  const uy = dy / distance;
  const { length } = arrowDimensions(strokeWidth);
  return { x: tip.x - ux * length, y: tip.y - uy * length };
}

function pathEndingAtArrowBase(path: string | null | undefined, tip: { x: number; y: number }, tail: { x: number; y: number }, strokeWidth: number) {
  const base = arrowBaseCenter(tip, tail, strokeWidth);
  if (typeof path !== "string" || !path.trim()) return `M ${tail.x} ${tail.y} L ${base.x} ${base.y}`;
  return path.replace(/-?\d+(?:\.\d+)? -?\d+(?:\.\d+)?$/, `${base.x} ${base.y}`);
}

function arrowPoints(tip: { x: number; y: number }, tail: { x: number; y: number }, strokeWidth: number) {
  const dx = tip.x - tail.x;
  const dy = tip.y - tail.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / distance;
  const uy = dy / distance;
  const nx = -uy;
  const ny = ux;
  const { width } = arrowDimensions(strokeWidth);
  const back = arrowBaseCenter(tip, tail, strokeWidth);
  return [
    `${tip.x},${tip.y}`,
    `${back.x + nx * width},${back.y + ny * width}`,
    `${back.x - nx * width},${back.y - ny * width}`
  ].join(" ");
}

function clampZoom(zoom: number): number {
  return Math.min(2.8, Math.max(0.65, zoom));
}

function normalizeView(view: { x: number; y: number; zoom: number }) {
  const zoom = clampZoom(view.zoom);
  const width = svgWidth / zoom;
  const height = svgHeight / zoom;
  const centeredX = (svgWidth - width) / 2;
  const centeredY = (svgHeight - height) / 2;
  const minX = width >= svgWidth ? centeredX - graphPanPadding : -graphPanPadding;
  const maxX = width >= svgWidth ? centeredX + graphPanPadding : svgWidth - width + graphPanPadding;
  const minY = height >= svgHeight ? centeredY - graphPanPadding : -graphPanPadding;
  const maxY = height >= svgHeight ? centeredY + graphPanPadding : svgHeight - height + graphPanPadding;
  const x = Math.min(maxX, Math.max(minX, view.x));
  const y = Math.min(maxY, Math.max(minY, view.y));
  return { x, y, zoom };
}

function graphClientPointFromRect(clientX: number, clientY: number, rect: DOMRect, view: { x: number; y: number; zoom: number }) {
  const px = rect.width ? (clientX - rect.left) / rect.width : 0.5;
  const py = rect.height ? (clientY - rect.top) / rect.height : 0.5;
  const width = svgWidth / view.zoom;
  const height = svgHeight / view.zoom;
  return {
    graphX: view.x + px * width,
    graphY: view.y + py * height,
    px,
    py
  };
}

function clampNodePosition(position: { x: number; y: number }) {
  return {
    x: Math.min(svgWidth - 36, Math.max(36, position.x)),
    y: Math.min(svgHeight - 28, Math.max(28, position.y))
  };
}

function isInteractiveGraphTarget(target: EventTarget): boolean {
  return target instanceof Element && Boolean(target.closest(".node, .edge-path, .arrow-head, .edge-label, .graph-toolbar, .graph-side-controls, .graph-popover, .graph-legend"));
}

async function runOptionalGraphvizLayout(
  request: GraphvizLayoutRequest,
  width: number,
  height: number,
  computeMode: ComputeMode
): Promise<{ result: GraphvizLayoutResult; fallback: boolean }> {
  if (computeMode !== "server") {
    return { result: await runBrowserGraphvizLayout(request, width, height), fallback: false };
  }

  try {
    const response = await fetch("/api/layout", {
      body: JSON.stringify({ height, request, width }),
      headers: apiJsonHeaders(),
      method: "POST"
    });
    if (!response.ok) throw new Error(await response.text());
    return { result: (await response.json()) as GraphvizLayoutResult, fallback: false };
  } catch (error) {
    const result = await runBrowserGraphvizLayout(request, width, height);
    return { result, fallback: true };
  }
}

function SharedDfgSvg({
  dfg,
  selectedSubsets,
  activityScope,
  activityCaseShareThreshold,
  maxVisibleActivities,
  setMaxVisibleActivities,
  maxVisiblePaths,
  setMaxVisiblePaths,
  pathCaseShareThreshold,
  activityLabelMetric,
  setActivityLabelMetric,
  setActivityLabelDisplay,
  activityLabelDisplay,
  pathLabelMetric,
  setPathLabelMetric,
  pathMode,
  globalPathShape,
  edgeWidthMetric,
  setEdgeWidthMetric,
  edgeWidthScale,
  setEdgeWidthScale,
  arcCurvature,
  subsetStyles,
  setLayoutStatus,
  computeMode,
  onComputeFallback,
  graphResetToken,
  pinActivity,
  pinPath
}: {
  dfg: SharedDfg;
  selectedSubsets: SubsetDefinition[];
  activityScope: ActivityScope;
  activityCaseShareThreshold: number;
  maxVisibleActivities: number;
  setMaxVisibleActivities: (value: number) => void;
  maxVisiblePaths: number;
  setMaxVisiblePaths: (value: number) => void;
  pathCaseShareThreshold: number;
  activityLabelMetric: ActivityLabelMetric;
  setActivityLabelMetric: (value: ActivityLabelMetric) => void;
  setActivityLabelDisplay: (value: ActivityLabelDisplay) => void;
  activityLabelDisplay: ActivityLabelDisplay;
  pathLabelMetric: PathMetric;
  setPathLabelMetric: (value: PathMetric) => void;
  pathMode: PathMode;
  globalPathShape: PathShape;
  edgeWidthMetric: WidthMetric;
  setEdgeWidthMetric: (value: WidthMetric) => void;
  edgeWidthScale: WidthScale;
  setEdgeWidthScale: (value: WidthScale) => void;
  arcCurvature: number;
  setLayoutStatus: (value: string) => void;
  computeMode: ComputeMode;
  onComputeFallback: () => void;
  graphResetToken: number;
  pinActivity: (activity: string) => void;
  pinPath: (path: PinnedEdge) => void;
  subsetStyles: Record<string, Partial<SubsetVisualStyle>>;
}) {
  const [view, setView] = useState(() => normalizeView({ x: 0, y: 0, zoom: 1 }));
  const [drag, setDrag] = useState<{ clientX: number; clientY: number; x: number; y: number } | null>(null);
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>({});
  const [graphvizPositions, setGraphvizPositions] = useState<Record<string, { x: number; y: number }> | null>(null);
  const [layoutLocked, setLayoutLocked] = useState(false);
  const [layoutRefreshKey, setLayoutRefreshKey] = useState(0);
  const [nodeDrag, setNodeDrag] = useState<GraphNodeDrag | null>(null);
  const [selectedGraphActivities, setSelectedGraphActivities] = useState<string[]>([]);
  const [selectionDrag, setSelectionDrag] = useState<GraphSelectionDrag | null>(null);
  const [hiddenActivities, setHiddenActivities] = useState<string[]>([]);
  const [hiddenPaths, setHiddenPaths] = useState<string[]>([]);
  const [pathDensityMode, setPathDensityMode] = useState<PathDensityMode>("auto");
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [hoveredActivity, setHoveredActivity] = useState<string | null>(null);
  const [activePopover, setActivePopover] = useState<ActivePopover>(null);
  const [showAutoArrangeTip, setShowAutoArrangeTip] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const suppressNodeClickRef = useRef(false);
  const autoArrangeTipTimerRef = useRef<number | null>(null);
  const previousGraphResetToken = useRef(graphResetToken);
  const selectedIds = selectedSubsets.map((subset) => subset.id);
  const zoomedWidth = svgWidth / view.zoom;
  const zoomedHeight = svgHeight / view.zoom;

  function updateZoom(nextZoom: number, center = { graphX: view.x + zoomedWidth / 2, graphY: view.y + zoomedHeight / 2, px: 0.5, py: 0.5 }) {
    const zoom = clampZoom(nextZoom);
    const width = svgWidth / zoom;
    const height = svgHeight / zoom;
    setView(normalizeView({ x: center.graphX - center.px * width, y: center.graphY - center.py * height, zoom }));
  }

  function zoomFromWheel(clientX: number, clientY: number, deltaY: number, target: SVGSVGElement) {
    const center = graphClientPointFromRect(clientX, clientY, target.getBoundingClientRect(), view);
    const factor = deltaY > 0 ? 0.9 : 1.1;
    updateZoom(view.zoom * factor, center);
  }

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const handleNativeWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      zoomFromWheel(event.clientX, event.clientY, event.deltaY, svg);
    };

    svg.addEventListener("wheel", handleNativeWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleNativeWheel);
  }, [view]);

  useEffect(() => {
    if (!activePopover) return;
    const handleDocumentMouseDown = (event: globalThis.MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".graph-popover, .node, .edge-path, .arrow-head, .edge-label")) return;
      setActivePopover(null);
    };
    document.addEventListener("mousedown", handleDocumentMouseDown);
    return () => document.removeEventListener("mousedown", handleDocumentMouseDown);
  }, [activePopover]);

  function handleMouseDown(event: MouseEvent<SVGSVGElement>) {
    if (event.button !== 0 || isInteractiveGraphTarget(event.target)) return;
    event.preventDefault();
    setActivePopover(null);
    if (event.shiftKey) {
      const point = graphClientPointFromRect(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), view);
      setSelectionDrag({
        startGraphX: point.graphX,
        startGraphY: point.graphY,
        currentGraphX: point.graphX,
        currentGraphY: point.graphY
      });
      return;
    }
    setSelectedGraphActivities([]);
    setDrag({ clientX: event.clientX, clientY: event.clientY, x: view.x, y: view.y });
  }

  function handleMouseMove(event: MouseEvent<SVGSVGElement>) {
    if (nodeDrag) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const dx = rect.width ? ((event.clientX - nodeDrag.clientX) * zoomedWidth) / rect.width : 0;
      const dy = rect.height ? ((event.clientY - nodeDrag.clientY) * zoomedHeight) / rect.height : 0;
      if (Math.hypot(dx, dy) > 2) {
        suppressNodeClickRef.current = true;
        setLayoutLocked(true);
      }
      setNodePositions((current) => {
        const next = { ...current };
        for (const activity of nodeDrag.activities) {
          const original = nodeDrag.positions[activity];
          if (!original) continue;
          next[activity] = clampNodePosition({ x: original.x + dx, y: original.y + dy });
        }
        return next;
      });
      return;
    }
    if (selectionDrag) {
      event.preventDefault();
      const point = graphClientPointFromRect(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), view);
      setSelectionDrag((current) => current ? { ...current, currentGraphX: point.graphX, currentGraphY: point.graphY } : null);
      return;
    }
    if (!drag) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = rect.width ? ((event.clientX - drag.clientX) * zoomedWidth) / rect.width : 0;
    const dy = rect.height ? ((event.clientY - drag.clientY) * zoomedHeight) / rect.height : 0;
    setView(normalizeView({ x: drag.x - dx, y: drag.y - dy, zoom: view.zoom }));
  }

  function stopDragging() {
    if (selectionDrag) {
      const minX = Math.min(selectionDrag.startGraphX, selectionDrag.currentGraphX);
      const maxX = Math.max(selectionDrag.startGraphX, selectionDrag.currentGraphX);
      const minY = Math.min(selectionDrag.startGraphY, selectionDrag.currentGraphY);
      const maxY = Math.max(selectionDrag.startGraphY, selectionDrag.currentGraphY);
      const selected = displayNodes
        .filter((node) => {
          const position = positions.get(node.activity);
          return position && position.x >= minX && position.x <= maxX && position.y >= minY && position.y <= maxY;
        })
        .map((node) => node.activity);
      setSelectedGraphActivities(selected);
      setSelectionDrag(null);
    }
    setDrag(null);
    setNodeDrag(null);
  }

  function startNodeDrag(event: MouseEvent<SVGGElement>, activity: string, position: { x: number; y: number }) {
    if (event.button !== 0) return;
    event.stopPropagation();
    suppressNodeClickRef.current = false;
    const activities = selectedGraphActivities.includes(activity) ? selectedGraphActivities : [activity];
    const dragPositions: Record<string, { x: number; y: number }> = {};
    for (const selectedActivity of activities) {
      const selectedPosition = positions.get(selectedActivity);
      if (selectedPosition) dragPositions[selectedActivity] = selectedPosition;
    }
    if (!dragPositions[activity]) dragPositions[activity] = position;
    setNodeDrag({ activities, clientX: event.clientX, clientY: event.clientY, positions: dragPositions });
  }

  function popoverPoint(event: MouseEvent<SVGElement>) {
    const rect = wrapRef.current?.getBoundingClientRect();
    const localX = event.clientX - (rect?.left ?? 0);
    const localY = event.clientY - (rect?.top ?? 0);
    const width = rect?.width ?? graphPopoverWidth + 24;
    const height = rect?.height ?? graphPopoverEstimatedHeight + 24;
    const margin = 12;
    const gap = 14;
    const preferredRightX = localX + 14;
    const preferredLeftX = localX - graphPopoverWidth - 14;
    const maxX = Math.max(margin, width - graphPopoverWidth - margin);
    const rawX = preferredRightX + graphPopoverWidth > width - margin ? preferredLeftX : preferredRightX;
    const preferredBelowY = localY + gap;
    const preferredAboveY = localY - graphPopoverEstimatedHeight - gap;
    const hasRoomBelow = preferredBelowY + graphPopoverEstimatedHeight <= height - margin;
    const hasRoomAbove = preferredAboveY >= margin;
    const rawY = hasRoomBelow || !hasRoomAbove ? preferredBelowY : preferredAboveY;
    const y = Math.min(Math.max(margin, rawY), Math.max(margin, height - 180 - margin));
    return {
      x: Math.min(maxX, Math.max(12, rawX)),
      y,
      maxHeight: Math.max(180, height - y - margin)
    };
  }

  function hideActivity(activity: string) {
    freezeCurrentLayout();
    if (!hiddenActivities.includes(activity)) {
      setMaxVisibleActivities(Math.max(1, maxVisibleActivities - 1));
    }
    setHiddenActivities((current) => (current.includes(activity) ? current : [...current, activity]));
    setActivePopover(null);
    setHoveredActivity(null);
  }

  function hidePath(edgeId: string) {
    freezeCurrentLayout();
    if (!hiddenPaths.includes(edgeId)) {
      setMaxVisiblePaths(Math.max(1, maxVisiblePaths - 1));
    }
    setHiddenPaths((current) => (current.includes(edgeId) ? current : [...current, edgeId]));
    setActivePopover(null);
    setHoveredEdgeId(null);
    setHoveredActivity(null);
  }

  function deriveAutoVisibleLimits(activityLimitOverride?: number) {
    return deriveDefaultVisibleLimits({
      activityCaseShareThreshold,
      activityLimitOverride,
      activityScope,
      dfg,
      hiddenActivities,
      hiddenPaths,
      pathCaseShareThreshold,
      pathMode,
      selectedIds
    });
  }

  const defaultVisibilitySignature = JSON.stringify({
    activityScope,
    pathMode,
    selectedIds
  });

  const showAutoArrangeTipBriefly = useCallback(() => {
    if (autoArrangeTipTimerRef.current !== null) {
      window.clearTimeout(autoArrangeTipTimerRef.current);
    }
    setShowAutoArrangeTip(true);
    autoArrangeTipTimerRef.current = window.setTimeout(() => {
      setShowAutoArrangeTip(false);
      autoArrangeTipTimerRef.current = null;
    }, 2000);
  }, []);

  useEffect(
    () => () => {
      if (autoArrangeTipTimerRef.current !== null) {
        window.clearTimeout(autoArrangeTipTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (previousGraphResetToken.current === graphResetToken) return;
    previousGraphResetToken.current = graphResetToken;
    setView(normalizeView({ x: 0, y: 0, zoom: 1 }));
    setDrag(null);
    setNodePositions({});
    setGraphvizPositions(null);
    setLayoutLocked(false);
    setNodeDrag(null);
    setSelectedGraphActivities([]);
    setSelectionDrag(null);
    setHiddenActivities([]);
    setHiddenPaths([]);
    setPathDensityMode("auto");
    setHoveredEdgeId(null);
    setHoveredActivity(null);
    setActivePopover(null);
    setShowAutoArrangeTip(false);
    if (autoArrangeTipTimerRef.current !== null) {
      window.clearTimeout(autoArrangeTipTimerRef.current);
      autoArrangeTipTimerRef.current = null;
    }
    const limits = deriveDefaultVisibleLimits({
      activityCaseShareThreshold,
      activityScope,
      dfg,
      hiddenActivities: [],
      hiddenPaths: [],
      pathCaseShareThreshold,
      pathMode,
      selectedIds
    });
    setMaxVisibleActivities(limits.activityLimit);
    setMaxVisiblePaths(limits.pathLimit);
    setLayoutRefreshKey((current) => current + 1);
    setLayoutStatus("Auto-arranging activities with Graphviz...");
  }, [graphResetToken]);

  useEffect(() => {
    const limits = deriveAutoVisibleLimits();
    setPathDensityMode("auto");
    setMaxVisibleActivities(limits.activityLimit);
    setMaxVisiblePaths(limits.pathLimit);
    setLayoutLocked(false);
    setNodePositions({});
    setGraphvizPositions(null);
    setSelectedGraphActivities([]);
    setLayoutRefreshKey((current) => current + 1);
    setLayoutStatus("Auto-arranging activities with Graphviz...");
  }, [defaultVisibilitySignature, dfg]);

  async function saveProcessViewImage() {
    if (!svgRef.current) return;
    setLayoutStatus("Saving Shared Process View image...");
    try {
      await downloadSvgAsPng(svgRef.current, sharedProcessViewFilename(selectedSubsets));
      setLayoutStatus("Shared Process View image saved as PNG.");
    } catch (error) {
      setLayoutStatus(`Image export failed: ${String(error)}`);
    }
  }

  const sharedView = deriveSharedDfgView({
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
  });
  const {
    candidateEdges,
    displayNodes,
    effectivePathMode,
    scopedNodes,
    visibleEdges,
    visibleEdgePairs,
    visiblePairKeys
  } = sharedView;
  const visibleEdgeIds = new Set(visibleEdges.map((edge) => edge.id));
  const visibleBusinessEdgeIds = new Set(
    visibleEdges
      .filter(isBusinessPath)
      .map((edge) => edge.id)
  );
  const useGlobalProcessOrder = activityScope !== "specific" && effectivePathMode !== "specific";
  const layoutNodePositionByActivity = new Map(displayNodes.map((node) => [node.activity, nodeAveragePosition(node)]));
  const businessIncidentCounts = visibleBusinessIncidentCounts(visibleEdges);
  const sameRankGroups = selectHorizontalReciprocalGroups(visibleEdges, visibleEdgePairs, selectedIds, businessIncidentCounts);
  const horizontalReciprocalPairKeys = new Set(sameRankGroups.map(([source, target]) => reciprocalPairKey(source, target)));
  const maxVisibleEdgeCount = Math.max(0, ...visibleEdges.filter((edge) => edge.source !== edge.target).map((edge) => totalEdgeCount(edge, selectedIds)));
  const maxVisibleEdgeCaseShare = Math.max(0, ...visibleEdges.filter((edge) => edge.source !== edge.target).map((edge) => maxEdgeCaseShare(edge, selectedIds)));
  const layoutEdges = visibleEdges.map((edge) => {
    const sourcePosition = useGlobalProcessOrder ? layoutOrderPosition(edge.source, layoutNodePositionByActivity) : 0.45;
    const targetPosition = useGlobalProcessOrder ? layoutOrderPosition(edge.target, layoutNodePositionByActivity) : 0.6;
    const positionDelta = targetPosition - sourcePosition;
    const isIncidentalPath = isIncidentalLayoutEdge(edge, selectedIds, businessIncidentCounts);
    const relativeWeightBoost = !isIncidentalPath && positionDelta > 0.02 ? relativeEdgeWeightBoost(edge, selectedIds, maxVisibleEdgeCount, maxVisibleEdgeCaseShare) : 0;
    const role = graphvizEdgeRole(edge, selectedIds, sourcePosition, targetPosition, horizontalReciprocalPairKeys, isIncidentalPath, relativeWeightBoost);
    const baseWeight = layoutEdgeWeight(edge, selectedIds);
    return {
      constraint: graphvizRoleConstraint(role),
      minlen: graphvizEdgeMinlen(role, positionDelta, relativeWeightBoost),
      role,
      source: edge.source,
      target: edge.target,
      weight: isIncidentalPath ? Math.min(2, baseWeight) : Math.min(12, baseWeight + relativeWeightBoost)
    };
  });
  const graphvizNodeLayout = deriveMainFlowCorridorLayout(displayNodes, visibleEdges, layoutEdges, selectedIds);
  const layoutNodes = useGlobalProcessOrder
    ? [...displayNodes].sort((a, b) => nodeAveragePosition(a) - nodeAveragePosition(b) || a.activity.localeCompare(b.activity))
    : displayNodes;
  const layoutRequest: GraphvizLayoutRequest = {
    centerNodes: graphvizNodeLayout.centerNodes,
    compactMainFlow: graphvizNodeLayout.compactMainFlow,
    nodes: layoutNodes.map((node) => node.activity),
    nodeRoles: graphvizNodeLayout.nodeRoles,
    rankGuideEdges: boundarylessRankGuideEdges(displayNodes, layoutEdges),
    rankHints: boundarylessRankHints(displayNodes, layoutEdges, useGlobalProcessOrder),
    sameRankGroups,
    edges: [...layoutEdges].sort(
      (a, b) =>
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target) ||
        a.role.localeCompare(b.role) ||
        b.weight - a.weight
    )
  };

  useEffect(() => {
    if (layoutLocked) {
      setSelectedGraphActivities([]);
      return;
    }
    setNodePositions({});
    setSelectedGraphActivities([]);
  }, [layoutLocked, layoutRefreshKey]);

  useEffect(() => {
    if (layoutLocked) {
      setLayoutStatus("Manual layout preserved. Use Auto-arrange to refresh the layout.");
      return;
    }
    const request = layoutRequest;
    if (!request.nodes.length) {
      setGraphvizPositions({});
      setLayoutStatus("Graphviz DOT layout has no visible activities for the current controls.");
      return;
    }
    let cancelled = false;
    setLayoutStatus(computeMode === "server" ? "Running Server Graphviz DOT layout..." : "Running Local Graphviz DOT layout...");
    runOptionalGraphvizLayout(request, svgWidth, svgHeight, computeMode)
      .then(({ result, fallback }) => {
        if (cancelled) return;
        if (fallback) onComputeFallback();
        setGraphvizPositions(result.positions);
        const nodeCount = result.nodeCount ?? Object.keys(result.positions ?? {}).length;
        const source = fallback ? "Local fallback" : computeMode === "server" ? "Server Graphviz" : "Local Graphviz";
        setLayoutStatus(`${source} layout loaded for ${formatNumber(nodeCount)} activities.`);
      })
      .catch((error) => {
        if (cancelled) return;
        setGraphvizPositions(null);
        setLayoutStatus(`Graphviz DOT layout failed: ${String(error)}. Showing fallback layout.`);
      });

    return () => {
      cancelled = true;
    };
  }, [computeMode, layoutLocked, layoutRefreshKey, onComputeFallback, setLayoutStatus]);

  const positions = displayNodePositions(displayNodes, visibleEdges, nodePositions, graphvizPositions);

  function freezeCurrentLayout() {
    setLayoutLocked(true);
    setNodePositions((current) => {
      const next = { ...current };
      for (const node of displayNodes) {
        const position = positions.get(node.activity);
        if (position) next[node.activity] = position;
      }
      return next;
    });
  }
  const selectedGraphActivitySet = new Set(selectedGraphActivities);
  const selectionBox = selectionDrag
    ? {
        x: Math.min(selectionDrag.startGraphX, selectionDrag.currentGraphX),
        y: Math.min(selectionDrag.startGraphY, selectionDrag.currentGraphY),
        width: Math.abs(selectionDrag.currentGraphX - selectionDrag.startGraphX),
        height: Math.abs(selectionDrag.currentGraphY - selectionDrag.startGraphY)
      }
    : null;
  const maxNodeShare = Math.max(
    0.01,
    ...displayNodes.flatMap((node) => selectedIds.map((id) => node.metricsBySubset[id]?.caseShare ?? 0))
  );
  const nodeHalfWidths = new Map(
    displayNodes.map((node) => [node.activity, visualNodeWidth(node, selectedIds, maxNodeShare) / 2])
  );
  const nodeObstacles: NodeObstacle[] = displayNodes
    .map((node) => {
      const position = positions.get(node.activity);
      if (!position) return null;
      const isBoundary = isBoundaryActivityName(node.activity);
      const halfWidth = isBoundary ? boundaryNodeRadius : nodeHalfWidths.get(node.activity) ?? nodeHalfWidth;
      const halfHeight = isBoundary ? boundaryNodeRadius : nodeHalfHeight;
      const padding = isBoundary ? 10 : 18;
      return {
        activity: node.activity,
        bottom: position.y + halfHeight + padding,
        left: position.x - halfWidth - padding,
        right: position.x + halfWidth + padding,
        top: position.y - halfHeight - padding
      };
    })
    .filter((obstacle): obstacle is NodeObstacle => Boolean(obstacle));
  const activityLabelValue = activityLabelMetric;
  function setActivityLabelOption(value: string | null) {
    if (!value) return;
    setActivityLabelMetric(value as ActivityLabelMetric);
    setActivityLabelDisplay("perSubset");
  }
  let widthMax = 0;
  let opacityMax = 0;
  for (const edge of dfg.edges) {
    for (const subset of selectedSubsets) {
      if (!visiblePairKeys.has(`${edge.id}-${subset.id}`)) continue;
      const metrics = metricOrEmpty(edge, subset.id);
      widthMax = Math.max(widthMax, edgeWidthValue(metrics, edgeWidthMetric));
      opacityMax = Math.max(opacityMax, edgeWidthValue(metrics, pathLabelMetric));
    }
  }
  const pathLabelCandidates = visibleEdges.flatMap((edge) =>
    selectedSubsets.flatMap((subset, subsetIndex) => {
      const pairKey = `${edge.id}-${subset.id}`;
      if (!visiblePairKeys.has(pairKey)) return [];
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      if (!source || !target) return [];
      const metrics = metricOrEmpty(edge, subset.id);
      const value = edgeWidthValue(metrics, pathLabelMetric);
      if (value <= 0) return [];
      const isTwoWayPath = visibleEdgePairs.has(`${edge.target}__${edge.source}`);
      const geometry = edgePathGeometry(
        source,
        target,
        subsetIndex,
        selectedSubsets.length,
        edge.source === edge.target,
        arcCurvature,
        globalPathShape,
        isBoundaryActivityName(edge.source),
        isBoundaryActivityName(edge.target),
        isTwoWayPath,
        nodeHalfWidths.get(edge.source) ?? nodeHalfWidth,
        nodeHalfWidths.get(edge.target) ?? nodeHalfWidth,
        nodeObstacles,
        edge.source,
        edge.target
      );
      const label = formatPathMetric(metrics, pathLabelMetric);
      return [
        {
          height: 18,
          key: pairKey,
          label,
          value,
          width: Math.max(42, label.length * 7.4 + 12),
          x: geometry.labelX,
          y: geometry.labelY
        }
      ];
    })
  );
  const persistentPathLabelLimit = Math.max(1, Math.ceil(pathLabelCandidates.length * 0.1));
  const persistentPathLabelKeys = new Set<string>();
  const persistentPathLabelBoxes: Array<{ bottom: number; left: number; right: number; top: number }> = [];
  for (const candidate of [...pathLabelCandidates]
    .sort((a, b) => b.value - a.value || a.y - b.y || a.x - b.x)
    .slice(0, persistentPathLabelLimit)) {
    const box = {
      bottom: candidate.y + candidate.height / 2,
      left: candidate.x - candidate.width / 2,
      right: candidate.x + candidate.width / 2,
      top: candidate.y - candidate.height / 2
    };
    const overlaps = persistentPathLabelBoxes.some(
      (existing) => box.left < existing.right && box.right > existing.left && box.top < existing.bottom && box.bottom > existing.top
    );
    if (overlaps) continue;
    persistentPathLabelKeys.add(candidate.key);
    persistentPathLabelBoxes.push(box);
  }
  const activitySliderMax = Math.max(1, scopedNodes.length);
  const pathSliderMax = Math.max(1, candidateEdges.length);
  const activitySliderValue = Math.min(maxVisibleActivities, activitySliderMax);
  const pathSliderValue = Math.min(maxVisiblePaths, pathSliderMax);
  const emptyGraphState =
    displayNodes.length === 0
      ? graphEmptyState({
          activityCaseShareThreshold,
          activityScope,
          baseNodeCount: scopedNodes.length,
          candidateEdgeCount: candidateEdges.length,
          pathCaseShareThreshold,
          pathMode: effectivePathMode
        })
      : null;
  return (
    <div className="svg-wrap" ref={wrapRef}>
      <div className="graph-encoding-menu" onMouseDown={(event) => event.stopPropagation()}>
        <div
          className="graph-encoding-summary"
          title={`Activity label: ${activityMetricLabel(activityLabelMetric, activityLabelDisplay)}. Connection label and opacity: ${widthMetricLabel(pathLabelMetric)}. Connection width: ${widthMetricLabel(edgeWidthMetric)}. Only the top 10% of connection labels are shown. Hover or click connections for details.`}
        >
          <span className="graph-encoding-row" aria-label={`Activity label: ${activityMetricLabel(activityLabelMetric, activityLabelDisplay)}`}>
            <span className="graph-activity-glyph graph-encoding-activity-glyph" aria-hidden="true">
              <span />
            </span>
            <em className="graph-encoding-name">Activity label</em>
            <b className="graph-encoding-value">{activityMetricLabel(activityLabelMetric, activityLabelDisplay)}</b>
          </span>
          <span className="graph-encoding-row graph-encoding-path-label" aria-label={`Connection label and opacity: ${widthMetricLabel(pathLabelMetric)}`}>
            <CornerRightDown size={14} strokeWidth={3} />
            <em className="graph-encoding-name">Conn. label & opacity</em>
            <b className="graph-encoding-value">{widthMetricLabel(pathLabelMetric)}</b>
            <Tooltip label="Only the top 10% of connection labels are shown. Hover or click connections for details." withArrow>
              <Info className="graph-encoding-info-icon" size={12} aria-label="Connection label visibility rule" />
            </Tooltip>
          </span>
          <span className="graph-encoding-row" aria-label={`Connection width: ${widthMetricLabel(edgeWidthMetric)}`}>
            <ConnectionWidthIcon />
            <em className="graph-encoding-name">Connection width</em>
            <b className="graph-encoding-value">{widthMetricLabel(edgeWidthMetric)}</b>
          </span>
        </div>
        <div className="graph-encoding-action">
          <Menu offset={8} position="bottom-end" shadow="md" width={316} withinPortal={false}>
            <Menu.Target>
              <button
                aria-label="Configure encoded metrics"
                className="graph-encoding-button"
                title="Configure encoded metrics"
                type="button"
              >
                <Box size={22} strokeWidth={2.6} />
              </button>
            </Menu.Target>
            <Menu.Dropdown className="graph-encoding-dropdown">
              <Menu.Label>Encoded metrics</Menu.Label>
              <div className="graph-encoding-fields">
                <Select
                  allowDeselect={false}
                  comboboxProps={{ withinPortal: false }}
                  data={[
                    { value: "caseCount", label: "Case count" },
                    { value: "caseShare", label: "Case coverage" },
                    { value: "eventCount", label: "Event count" }
                  ]}
                  label="Activity label"
                  leftSection={<MetricTypeIcon metric={activityLabelValue} />}
                  leftSectionWidth={34}
                  onChange={setActivityLabelOption}
                  renderOption={({ option }) => <MetricSelectOption label={option.label} value={option.value} />}
                  size="xs"
                  value={activityLabelValue}
                />
                <Select
                  allowDeselect={false}
                  comboboxProps={{ withinPortal: false }}
                  data={[
                    { value: "frequency", label: "Connection count" },
                    { value: "caseCount", label: "Case count" },
                    { value: "caseShare", label: "Case coverage" },
                    { value: "avgWaitingTime", label: "Avg waiting time" },
                    { value: "medianWaitingTime", label: "Median waiting time" },
                    { value: "sumWaitingTime", label: "Sum waiting time" }
                  ]}
                  label="Connection label & opacity"
                  leftSection={<MetricTypeIcon metric={pathLabelMetric} />}
                  leftSectionWidth={34}
                  onChange={(value) => value && setPathLabelMetric(value as PathMetric)}
                  renderOption={({ option }) => <MetricSelectOption label={option.label} value={option.value} />}
                  size="xs"
                  value={pathLabelMetric}
                />
                <Select
                  allowDeselect={false}
                  comboboxProps={{ withinPortal: false }}
                  data={[
                    { value: "frequency", label: "Connection count" },
                    { value: "caseCount", label: "Case count" },
                    { value: "caseShare", label: "Case coverage" },
                    { value: "avgWaitingTime", label: "Avg waiting time" },
                    { value: "medianWaitingTime", label: "Median waiting time" },
                    { value: "sumWaitingTime", label: "Sum waiting time" }
                  ]}
                  label="Connection width"
                  leftSection={<ConnectionWidthIcon />}
                  leftSectionWidth={34}
                  onChange={(value) => value && setEdgeWidthMetric(value as WidthMetric)}
                  renderOption={({ option }) => <MetricSelectOption label={option.label} value={option.value} />}
                  size="xs"
                  value={edgeWidthMetric}
                />
                <Select
                  allowDeselect={false}
                  comboboxProps={{ withinPortal: false }}
                  data={widthScaleOptions}
                  label="Connection width scale"
                  leftSection={<WidthScaleSparkline scale={edgeWidthScale} />}
                  leftSectionWidth={44}
                  onChange={(value) => value && setEdgeWidthScale(value as WidthScale)}
                  renderOption={({ option }) => {
                    const scale = option.value as WidthScale;
                    return (
                      <div className="width-scale-option">
                        <WidthScaleSparkline scale={scale} />
                        <span className="width-scale-option-label">{option.label}</span>
                        <span className="width-scale-option-note">{widthScaleSensitivityLabels[scale]}</span>
                      </div>
                    );
                  }}
                  size="xs"
                  value={edgeWidthScale}
                />
              </div>
            </Menu.Dropdown>
          </Menu>
          <span className="graph-encoding-helper">
            Choose
            <br />
            Encoded
            <br />
            Metrics
          </span>
        </div>
      </div>
      <div className="graph-interaction-hint" title="Shift-drag on empty canvas to box-select activities. Command-click on Mac or Ctrl-click on Windows adds activities to the selection. Drag any selected activity to move the group.">
        <span>
          <kbd>Shift-drag</kbd>
          <b>box select</b>
        </span>
        <span>
          <kbd>⌘/Ctrl-click</kbd>
          <b>multi-select</b>
        </span>
      </div>
      <div className="graph-toolbar" aria-label="Graph zoom controls">
        <button aria-label="Zoom out" className="graph-tool-primary" onClick={() => updateZoom(view.zoom - 0.15)} type="button">
          <ZoomOut size={15} />
        </button>
        <span>{Math.round(view.zoom * 100)}%</span>
        <button aria-label="Zoom in" className="graph-tool-primary" onClick={() => updateZoom(view.zoom + 0.15)} type="button">
          <ZoomIn size={15} />
        </button>
        <button onClick={() => setView(normalizeView({ x: 0, y: 0, zoom: 1 }))} type="button">Reset</button>
        <button
          onClick={() => {
            setLayoutLocked(false);
            setNodePositions({});
            setGraphvizPositions(null);
            setSelectedGraphActivities([]);
            setView(normalizeView({ x: 0, y: 0, zoom: 1 }));
            setLayoutRefreshKey((current) => current + 1);
            setLayoutStatus("Auto-arranging activities with Graphviz...");
          }}
          className="graph-tool-primary"
          title="Run Graphviz layout."
          type="button"
        >
          Auto-arrange
        </button>
        {showAutoArrangeTip ? <span className="graph-auto-arrange-tip">If the DFG is messy, try Auto-arrange.</span> : null}
        <button aria-label="Save Shared Process View image" onClick={saveProcessViewImage} title="Save Shared Process View image" type="button">
          <Download size={15} />
        </button>
      </div>
      <div className="graph-side-controls" aria-label="Graph simplification controls">
        <Tooltip label={`Show the ${displayNodes.filter((node) => !isBoundaryActivityName(node.activity)).length} activities with highest case coverage.`} position="right" withArrow>
          <label>
            <span className="graph-activity-glyph" aria-hidden="true">
              <span />
            </span>
            <Slider
              aria-label="Activities"
              className="graph-side-slider"
              color="blue"
              label={null}
              max={activitySliderMax}
              min={1}
              onChange={(nextLimit) => {
                freezeCurrentLayout();
                showAutoArrangeTipBriefly();
                setMaxVisibleActivities(nextLimit);
                if (pathDensityMode === "auto") {
                  const limits = deriveAutoVisibleLimits(nextLimit);
                  setMaxVisiblePaths(limits.pathLimit);
                }
              }}
              orientation="vertical"
              value={activitySliderValue}
            />
            <b>{displayNodes.filter((node) => !isBoundaryActivityName(node.activity)).length}/{scopedNodes.length}</b>
          </label>
        </Tooltip>
        <Tooltip label={`Show the ${visibleBusinessEdgeIds.size} connections with highest case coverage.`} position="right" withArrow>
          <label>
            <CornerRightDown aria-hidden="true" size={16} strokeWidth={3} />
            <Slider
              aria-label="Connections"
              className="graph-side-slider"
              color="blue"
              label={null}
              max={pathSliderMax}
              min={1}
              onChange={(nextLimit) => {
                freezeCurrentLayout();
                showAutoArrangeTipBriefly();
                setPathDensityMode("manual");
                setMaxVisiblePaths(nextLimit);
              }}
              orientation="vertical"
              value={pathSliderValue}
            />
            <b>{visibleBusinessEdgeIds.size}/{candidateEdges.length}</b>
          </label>
        </Tooltip>
      </div>
      <p className="graph-slider-helper">
        Use the sliders
        <br />
        to adjust visible
        <br />
        activities & connections
      </p>
      {emptyGraphState ? (
        <div className="graph-empty-state" role="status">
          <strong>{emptyGraphState.title}</strong>
          <span>{emptyGraphState.detail}</span>
        </div>
      ) : null}
      <svg
        className={drag || nodeDrag ? "process-svg is-dragging" : "process-svg"}
        ref={svgRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDragging}
        role="img"
        viewBox={`${view.x} ${view.y} ${zoomedWidth} ${zoomedHeight}`}
      >
        {visibleEdges.flatMap((edge) =>
          selectedSubsets.map((subset, subsetIndex) => {
            if (!visiblePairKeys.has(`${edge.id}-${subset.id}`)) return null;
            const source = positions.get(edge.source);
            const target = positions.get(edge.target);
            if (!source || !target) return null;
            const style = subsetStyle(subset, subsetIndex, subsetStyles);
            const metrics = metricOrEmpty(edge, subset.id);
            const opacity = edgeOpacity(metrics, pathLabelMetric, opacityMax);
            const isTwoWayPath = visibleEdgePairs.has(`${edge.target}__${edge.source}`);
            const isBoundaryConnection = isBoundaryLink(edge);
            const strokeStyle = connectionStrokeStyle(metrics, edgeWidthMetric, edgeWidthScale, widthMax, style.linePattern, isBoundaryConnection);
            const geometry = edgePathGeometry(
              source,
              target,
              subsetIndex,
              selectedSubsets.length,
              edge.source === edge.target,
              arcCurvature,
              globalPathShape,
              isBoundaryActivityName(edge.source),
              isBoundaryActivityName(edge.target),
              isTwoWayPath,
              nodeHalfWidths.get(edge.source) ?? nodeHalfWidth,
              nodeHalfWidths.get(edge.target) ?? nodeHalfWidth,
              nodeObstacles,
              edge.source,
              edge.target
            );
            const pairKey = `${edge.id}-${subset.id}`;
            const isLogicalPathHovered = hoveredEdgeId === edge.id;
            const isConnectedToHoveredActivity = hoveredActivity === edge.source || hoveredActivity === edge.target;
            const isEdgeHighlighted = isLogicalPathHovered || isConnectedToHoveredActivity;
            return (
              <g
                className={isEdgeHighlighted ? "edge-subset-group edge-is-hovered" : "edge-subset-group"}
                key={pairKey}
                onMouseEnter={() => setHoveredEdgeId(edge.id)}
                onMouseLeave={() => setHoveredEdgeId(null)}
              >
                <path
                  className={isTwoWayPath ? "edge-path two-way-path" : "edge-path"}
                  d={isBoundaryConnection ? geometry.path : pathEndingAtArrowBase(geometry.path, geometry.arrowTip, geometry.arrowTail, strokeStyle.width)}
                  fill="none"
                  onClick={(event) => {
                    event.stopPropagation();
                    setActivePopover({ type: "edge", edgeId: edge.id, source: edge.source, target: edge.target, ...popoverPoint(event) });
                  }}
                  opacity={opacity}
                  stroke={style.color}
                  strokeDasharray={strokeStyle.dashArray}
                  strokeLinecap="round"
                  strokeWidth={strokeStyle.width}
                  style={{ "--edge-hover-width": `${Math.min(30, strokeStyle.width + 5)}px` } as CSSProperties}
                />
              </g>
            );
          })
        )}

        {displayNodes.map((node) => {
          const position = positions.get(node.activity)!;
          const isStartNode = node.activity === "Start";
          const isEndNode = node.activity === "End";
          const isBoundaryNode = isStartNode || isEndNode;
          const width = visualNodeWidth(node, selectedIds, maxNodeShare);
          const isSelectedForMove = selectedGraphActivitySet.has(node.activity);
          const isActivityHovered = hoveredActivity === node.activity;
          return (
            <g
              className={[
                "node",
                isBoundaryNode ? "boundary-node" : "",
                isStartNode ? "start-node" : "",
                isEndNode ? "end-node" : "",
                isSelectedForMove ? "node-selected" : "",
                isActivityHovered ? "node-is-hovered" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              key={node.activity}
              onClick={(event) => {
                event.stopPropagation();
                if (suppressNodeClickRef.current) {
                  suppressNodeClickRef.current = false;
                  return;
                }
                if (event.metaKey || event.ctrlKey) {
                  setSelectedGraphActivities((current) =>
                    current.includes(node.activity) ? current.filter((activity) => activity !== node.activity) : [...current, node.activity]
                  );
                  setActivePopover(null);
                  return;
                }
                setActivePopover({ type: "node", activity: node.activity, ...popoverPoint(event) });
              }}
              onMouseEnter={() => setHoveredActivity(node.activity)}
              onMouseLeave={() => setHoveredActivity(null)}
              onMouseDown={(event) => startNodeDrag(event, node.activity, position)}
              transform={isBoundaryNode ? `translate(${position.x}, ${position.y})` : `translate(${position.x - width / 2}, ${position.y - nodeHalfHeight})`}
            >
              {isBoundaryNode ? (
                <>
                  <circle r={boundaryNodeRadius} />
                  {isStartNode ? <polygon className="boundary-symbol" points="-4,-7 -4,7 8,0" /> : <rect className="boundary-symbol" height="12" rx="1.5" width="12" x="-6" y="-6" />}
                </>
              ) : (
                <>
                  <rect className="node-frame" height={nodeHalfHeight * 2} rx="7" width={width} />
                  <NodeStackFill metric={activityLabelMetric} node={node} selectedSubsets={selectedSubsets} subsetStyles={subsetStyles} width={width} />
                  <text className="node-title" x={width / 2} y="29">
                    {node.activity}
                  </text>
                  <NodeMetricText
                    display={activityLabelDisplay}
                    metric={activityLabelMetric}
                    node={node}
                    selectedIds={selectedIds}
                    selectedSubsets={selectedSubsets}
                    subsetStyles={subsetStyles}
                    x={width / 2}
                    y={50}
                  />
                </>
              )}
            </g>
          );
        })}

        {selectionBox && selectionBox.width > 2 && selectionBox.height > 2 ? (
          <rect
            className="graph-selection-box"
            height={selectionBox.height}
            width={selectionBox.width}
            x={selectionBox.x}
            y={selectionBox.y}
          />
        ) : null}

        {visibleEdges.flatMap((edge) =>
          selectedSubsets.map((subset, subsetIndex) => {
            if (!visiblePairKeys.has(`${edge.id}-${subset.id}`)) return null;
            if (isBoundaryLink(edge)) return null;
            const source = positions.get(edge.source);
            const target = positions.get(edge.target);
            if (!source || !target) return null;
            const style = subsetStyle(subset, subsetIndex, subsetStyles);
            const metrics = metricOrEmpty(edge, subset.id);
            const strokeWidth = edgeStrokeWidth(metrics, edgeWidthMetric, edgeWidthScale, widthMax);
            const opacity = edgeOpacity(metrics, pathLabelMetric, opacityMax);
            const isTwoWayPath = visibleEdgePairs.has(`${edge.target}__${edge.source}`);
            const isConnectedToHoveredActivity = hoveredActivity === edge.source || hoveredActivity === edge.target;
            const geometry = edgePathGeometry(
              source,
              target,
              subsetIndex,
              selectedSubsets.length,
              edge.source === edge.target,
              arcCurvature,
              globalPathShape,
              isBoundaryActivityName(edge.source),
              isBoundaryActivityName(edge.target),
              isTwoWayPath,
              nodeHalfWidths.get(edge.source) ?? nodeHalfWidth,
              nodeHalfWidths.get(edge.target) ?? nodeHalfWidth,
              nodeObstacles,
              edge.source,
              edge.target
            );
            return (
              <polygon
                className={[
                  "arrow-head",
                  isTwoWayPath ? "two-way-path" : "",
                  hoveredEdgeId === edge.id || isConnectedToHoveredActivity ? "edge-is-hovered" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                fill={style.color}
                key={`${edge.id}-${subset.id}-arrow`}
                onMouseEnter={() => setHoveredEdgeId(edge.id)}
                onMouseLeave={() => setHoveredEdgeId(null)}
                onClick={(event) => {
                  event.stopPropagation();
                  setActivePopover({ type: "edge", edgeId: edge.id, source: edge.source, target: edge.target, ...popoverPoint(event) });
                }}
                opacity={opacity}
                points={arrowPoints(geometry.arrowTip, geometry.arrowTail, strokeWidth)}
              />
            );
          })
        )}

        {visibleEdges.flatMap((edge) =>
          selectedSubsets.map((subset, subsetIndex) => {
            const pairKey = `${edge.id}-${subset.id}`;
            if (!visiblePairKeys.has(pairKey)) return null;
            const source = positions.get(edge.source);
            const target = positions.get(edge.target);
            if (!source || !target) return null;
            const style = subsetStyle(subset, subsetIndex, subsetStyles);
            const metrics = metricOrEmpty(edge, subset.id);
            const isTwoWayPath = visibleEdgePairs.has(`${edge.target}__${edge.source}`);
            const isConnectedToHoveredActivity = hoveredActivity === edge.source || hoveredActivity === edge.target;
            const isEdgeHighlighted = hoveredEdgeId === edge.id || isConnectedToHoveredActivity;
            const isPersistentPathLabel = persistentPathLabelKeys.has(pairKey);
            if (!isPersistentPathLabel && !isEdgeHighlighted) return null;
            const geometry = edgePathGeometry(
              source,
              target,
              subsetIndex,
              selectedSubsets.length,
              edge.source === edge.target,
              arcCurvature,
              globalPathShape,
              isBoundaryActivityName(edge.source),
              isBoundaryActivityName(edge.target),
              isTwoWayPath,
              nodeHalfWidths.get(edge.source) ?? nodeHalfWidth,
              nodeHalfWidths.get(edge.target) ?? nodeHalfWidth,
              nodeObstacles,
              edge.source,
              edge.target
            );
            return (
              <text
                className={isPersistentPathLabel || isEdgeHighlighted ? "edge-label edge-label-persistent" : "edge-label edge-label-hover"}
                fill={style.color}
                key={`${pairKey}-label`}
                x={geometry.labelX}
                y={geometry.labelY}
              >
                {formatPathMetric(metrics, pathLabelMetric)}
              </text>
            );
          })
        )}

      </svg>
      {activePopover ? (
        <GraphPopover
          dfg={dfg}
          hideActivity={hideActivity}
          hidePath={hidePath}
          pinActivity={pinActivity}
          pinPath={pinPath}
          popover={activePopover}
          selectedSubsets={selectedSubsets}
          subsetStyles={subsetStyles}
        />
      ) : null}
      <div className="graph-bottom-right">
        {hiddenActivities.length ? (
          <button className="restore-hidden" onClick={() => setHiddenActivities([])} type="button">
            Restore hidden activities
          </button>
        ) : null}
        {hiddenPaths.length ? (
          <button className="restore-hidden" onClick={() => setHiddenPaths([])} type="button">
            Restore hidden connections
          </button>
        ) : null}
        <div className="graph-legend" aria-label="Selected subset legend">
          {selectedSubsets.map((subset, index) => {
            const style = subsetStyle(subset, index, subsetStyles);
            return (
              <div className="graph-legend-row" key={subset.id}>
                <svg aria-hidden="true" className="graph-legend-line" viewBox="0 0 46 8">
                  <path
                    d={legendPathShape(globalPathShape)}
                    fill="none"
                    stroke={style.color}
                    strokeDasharray={lineDashArray(style.linePattern, 4)}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="4"
                  />
                </svg>
                <span>{subset.name}</span>
              </div>
            );
          })}
        </div>
        <div className="graph-reading-hint" aria-label="Process map legend">
          <Tooltip label="Process entry and exit points." position="left" withArrow>
            <span>
              <Ellipsis size={14} />
              Process start/end
            </span>
          </Tooltip>
          <Tooltip label="Connection direction." position="left" withArrow>
            <span>
              <ArrowDown size={13} strokeWidth={3} />
              Direction
            </span>
          </Tooltip>
          <Tooltip label="Repeated activity in the same case." position="left" withArrow>
            <span>
              <RotateCcw size={13} />
              Rework loop
            </span>
          </Tooltip>
          <Tooltip label="Both directions are visible between the same two activities." position="left" withArrow>
            <span>
              <RefreshCw size={13} />
              Two-way connections
            </span>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function NodeStackFill({
  metric,
  node,
  selectedSubsets,
  subsetStyles,
  width
}: {
  metric: ActivityLabelMetric;
  node: SharedDfgNode;
  selectedSubsets: SubsetDefinition[];
  subsetStyles: Record<string, Partial<SubsetVisualStyle>>;
  width: number;
}) {
  const values = selectedSubsets.map((subset) => {
    const metrics = node.metricsBySubset[subset.id];
    if (!metrics) return 0;
    if (metric === "caseShare") return metrics.caseShare;
    return metric === "eventCount" ? metrics.eventCount : metrics.caseCount;
  });
  const total = values.reduce((sum, value) => sum + value, 0);
  let offset = 0;
  return (
    <g className="node-stack-fill" clipPath={`inset(0 round 7px)`}>
      {total > 0
        ? selectedSubsets.map((subset, index) => {
            const value = values[index];
            if (value <= 0) return null;
            const segmentWidth = (value / total) * width;
            const x = offset;
            offset += segmentWidth;
            const showDivider = offset < width - 0.5;
            return (
              <g key={subset.id}>
                <rect height={nodeHalfHeight * 2} width={segmentWidth} x={x} y="0" fill={subsetStyle(subset, index, subsetStyles).color} opacity="0.18" />
                {showDivider ? <line className="node-stack-divider" x1={offset} x2={offset} y1="0" y2={nodeHalfHeight * 2} /> : null}
              </g>
            );
          })
        : null}
    </g>
  );
}

function NodeMetricText({
  display,
  metric,
  node,
  selectedIds,
  selectedSubsets,
  subsetStyles,
  x,
  y
}: {
  display: ActivityLabelDisplay;
  metric: ActivityLabelMetric;
  node: SharedDfgNode;
  selectedIds: string[];
  selectedSubsets: SubsetDefinition[];
  subsetStyles: Record<string, Partial<SubsetVisualStyle>>;
  x: number;
  y: number;
}) {
  void display;
  const hasMetrics = selectedIds.some((id) => node.metricsBySubset[id]);
  if (!hasMetrics) return null;

  return (
    <text className="node-metric node-metric-subsets" x={x} y={y}>
      {selectedSubsets.map((subset, index) => {
        const metrics = node.metricsBySubset[subset.id];
        const style = subsetStyle(subset, index, subsetStyles);
        return (
          <tspan key={subset.id}>
            {index > 0 ? <tspan className="node-metric-separator"> / </tspan> : null}
            <tspan fill={readableSubsetTextColor(style.color)}>{metrics ? formatActivityMetric(metrics, metric) : metric === "caseShare" ? "0%" : "0"}</tspan>
          </tspan>
        );
      })}
    </text>
  );
}

function ActivityMetricRows({
  node,
  selectedSubsets,
  subsetStyles
}: {
  node?: SharedDfgNode;
  selectedSubsets: SubsetDefinition[];
  subsetStyles: Record<string, Partial<SubsetVisualStyle>>;
}) {
  if (!node) return <div className="empty-detail">Activity is no longer visible in the current DFG.</div>;
  const rows = selectedSubsets.map((subset, index) => ({
    metrics: node.metricsBySubset[subset.id],
    style: subsetStyle(subset, index, subsetStyles),
    subset
  }));
  const maxEventCount = Math.max(1, ...rows.map((row) => row.metrics?.eventCount ?? 0));
  return (
    <div className="detail-card">
      {rows.map(({ metrics, style, subset }) => {
        return (
          <div className="detail-row detail-row-card" key={subset.id}>
            <div className="detail-row-title">
              <i style={{ background: style.color }} />
              <strong>{subset.name}</strong>
            </div>
            <div className="activity-detail-grid">
              <ShareDonut
                caption={`${formatNumber(metrics?.caseCount ?? 0)} cases`}
                color={style.color}
                label={formatPercent(metrics?.caseShare ?? 0)}
                share={metrics?.caseShare ?? 0}
              />
              <div className="activity-event-metric">
                <strong>{metrics ? `${formatNumber(metrics.eventCount)} events` : "0 events"}</strong>
                <DetailComparisonBar
                  color={style.color}
                  max={maxEventCount}
                  showValueLabel={false}
                  value={metrics?.eventCount ?? 0}
                  valueLabel={metrics ? `${formatNumber(metrics.eventCount)} events` : "0 events"}
                />
              </div>
              {metrics ? null : <em>No activity occurrences in this subset</em>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PathMetricRows({
  edge,
  selectedSubsets,
  subsetStyles
}: {
  edge?: SharedDfgEdge;
  selectedSubsets: SubsetDefinition[];
  subsetStyles: Record<string, Partial<SubsetVisualStyle>>;
}) {
  if (!edge) return <div className="empty-detail">Connection is no longer visible in the current DFG.</div>;
  const rows = selectedSubsets.map((subset, index) => ({
    metrics: metricOrEmpty(edge, subset.id),
    style: subsetStyle(subset, index, subsetStyles),
    subset
  }));
  const maxFrequency = Math.max(1, ...rows.map((row) => row.metrics.count));
  return (
    <div className="detail-card">
      {rows.map(({ metrics, style, subset }) => {
        return (
          <div className="detail-row detail-row-card" key={subset.id}>
            <div className="detail-row-title">
              <i style={{ background: style.color }} />
              <strong>{subset.name}</strong>
            </div>
            <div className="path-detail-grid">
              <div className="path-detail-block">
                <ShareDonut caption={`${formatNumber(metrics.caseCount)} cases`} color={style.color} label={formatPercent(metrics.caseShare)} share={metrics.caseShare} />
                <DetailComparisonBar color={style.color} max={maxFrequency} value={metrics.count} valueLabel={`${formatNumber(metrics.count)} times`} />
              </div>
              <div className="path-time-block">
                <div className="path-time-values">
                  <span>Avg time <strong>{formatHours(metrics.avgWaitingHours)}</strong></span>
                  <span>Sum time <strong>{formatHours(metrics.sumWaitingHours)}</strong></span>
                </div>
                <CompactTimeHistogram color={style.color} bins={metrics.waitingTimeBinsHours ?? []} label="Connection waiting-time distribution" />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GraphPopover({
  dfg,
  hideActivity,
  hidePath,
  pinActivity,
  pinPath,
  popover,
  selectedSubsets,
  subsetStyles
}: {
  dfg: SharedDfg;
  hideActivity: (activity: string) => void;
  hidePath: (edgeId: string) => void;
  pinActivity: (activity: string) => void;
  pinPath: (path: PinnedEdge) => void;
  popover: Exclude<ActivePopover, null>;
  selectedSubsets: SubsetDefinition[];
  subsetStyles: Record<string, Partial<SubsetVisualStyle>>;
}) {
  if (popover.type === "node") {
    const node = dfg.nodes.find((item) => item.activity === popover.activity);
    return (
      <div className="graph-popover" style={{ left: popover.x, maxHeight: popover.maxHeight, top: popover.y }}>
        <div className="popover-title">
          <strong>{popover.activity}</strong>
          <button aria-label={`Pin ${popover.activity}`} onClick={() => pinActivity(popover.activity)} type="button">
            <Pin size={14} />
          </button>
        </div>
        <ActivityMetricRows node={node} selectedSubsets={selectedSubsets} subsetStyles={subsetStyles} />
        <button className="secondary popover-action" onClick={() => hideActivity(popover.activity)} type="button">
          <EyeOff size={14} /> Hide activity
        </button>
      </div>
    );
  }

  const edge = dfg.edges.find((item) => item.id === popover.edgeId);
  return (
    <div className="graph-popover" style={{ left: popover.x, maxHeight: popover.maxHeight, top: popover.y }}>
      <div className="popover-title">
        <strong>
          {popover.source} to {popover.target}
        </strong>
        <button aria-label={`Pin ${popover.source} to ${popover.target}`} onClick={() => pinPath({ edgeId: popover.edgeId, source: popover.source, target: popover.target })} type="button">
          <Pin size={14} />
        </button>
      </div>
      <PathMetricRows edge={edge} selectedSubsets={selectedSubsets} subsetStyles={subsetStyles} />
      <button className="secondary popover-action" onClick={() => hidePath(popover.edgeId)} type="button">
        <EyeOff size={14} /> Hide connection
      </button>
    </div>
  );
}

function PinnedActivityCards({
  activities,
  dfg,
  selectedSubsets,
  subsetStyles,
  unpinActivity
}: {
  activities: string[];
  dfg: SharedDfg;
  selectedSubsets: SubsetDefinition[];
  subsetStyles: Record<string, Partial<SubsetVisualStyle>>;
  unpinActivity: (activity: string) => void;
}) {
  if (!activities.length) return <div className="empty-detail">Pin activities from the graph to compare them here.</div>;
  return (
    <div className="pinned-stack">
      {activities.map((activity) => (
        <div className="pinned-card" key={activity}>
          <div className="popover-title">
            <strong>{activity}</strong>
            <button aria-label={`Unpin ${activity}`} onClick={() => unpinActivity(activity)} type="button">
              <PinOff size={14} />
            </button>
          </div>
          <ActivityMetricRows
            node={dfg.nodes.find((node) => node.activity === activity)}
            selectedSubsets={selectedSubsets}
            subsetStyles={subsetStyles}
          />
        </div>
      ))}
    </div>
  );
}

function PinnedPathCards({
  dfg,
  paths,
  selectedSubsets,
  subsetStyles,
  unpinPath
}: {
  dfg: SharedDfg;
  paths: PinnedEdge[];
  selectedSubsets: SubsetDefinition[];
  subsetStyles: Record<string, Partial<SubsetVisualStyle>>;
  unpinPath: (edgeId: string) => void;
}) {
  if (!paths.length) return <div className="empty-detail">Pin connections from the graph to compare them here.</div>;
  return (
    <div className="pinned-stack">
      {paths.map((path) => (
        <div className="pinned-card" key={path.edgeId}>
          <div className="popover-title">
            <strong>
              {path.source} to {path.target}
            </strong>
            <button aria-label={`Unpin ${path.source} to ${path.target}`} onClick={() => unpinPath(path.edgeId)} type="button">
              <PinOff size={14} />
            </button>
          </div>
          <PathMetricRows
            edge={dfg.edges.find((edge) => edge.id === path.edgeId)}
            selectedSubsets={selectedSubsets}
            subsetStyles={subsetStyles}
          />
        </div>
      ))}
    </div>
  );
}

export default App;
