import type { CaseAttributeSchema, CaseRecord, EventLog, EventRecord } from "./types";
import { dateAttributeKeys, defaultSchemaOrder, knownAttributeLabels } from "./logisticsConfig";

const logisticsCaseCsvUrl = "/data/attributes.csv";
const logisticsEventCsvUrl = "/data/eventlog.csv";

type CsvRow = Record<string, string>;
type EventLogMetadataOptions = {
  doi?: string;
  logName: string;
  source: string;
};

const logisticsMetadata: EventLogMetadataOptions = {
  logName: "Logistics Vehicle Process Event Log",
  source: "Static logistics case table and event log CSV files",
  doi: ""
};

export async function loadEventLog(): Promise<EventLog> {
  const [caseCsv, eventCsv] = await Promise.all([fetchText(logisticsCaseCsvUrl), fetchText(logisticsEventCsvUrl)]);
  return buildEventLogFromCsv(caseCsv, eventCsv, logisticsMetadata);
}

export function buildEventLogFromCsv(caseCsv: string, eventCsv: string, metadata: EventLogMetadataOptions = logisticsMetadata): EventLog {
  const caseRows = parseCsv(caseCsv);
  const eventRows = parseCsv(eventCsv);
  if (!caseRows.length) throw new Error("Case CSV is empty.");
  if (!eventRows.length) throw new Error("Event CSV is empty.");

  const caseAttributes = new Map<string, Record<string, string | number | null>>();
  for (const row of caseRows) {
    const caseId = firstValue(row, ["item_id", "case_id", "Case ID", "Incident ID", "incident_id"]);
    if (!caseId) continue;
    caseAttributes.set(caseId, normalizeCaseAttributes(row));
  }

  const groupedEvents = new Map<string, EventRecord[]>();
  for (const row of eventRows) {
    const caseId = firstValue(row, ["item_id", "case_id", "Incident ID", "Case ID", "incident_id"]);
    const activity = firstValue(row, ["activity", "IncidentActivity_Type", "Activity", "operation"]);
    const timestampValue = firstValue(row, ["op_time", "timestamp", "DateStamp", "time", "Timestamp"]);
    if (!caseId || !activity || !timestampValue) continue;
    const timestamp = parseTimestamp(timestampValue);
    if (!timestamp) continue;
    const events = groupedEvents.get(caseId) ?? [];
    events.push({
      activity,
      timestamp: timestamp.toISOString(),
      assignmentGroup: firstValue(row, ["assignment_group", "Assignment Group", "assignmentGroup", "operator_id"]) || undefined
    });
    groupedEvents.set(caseId, events);
  }

  const cases: CaseRecord[] = [];
  const activities = new Set<string>();
  for (const [caseId, events] of groupedEvents.entries()) {
    if (!caseAttributes.has(caseId) || events.length < 2) continue;
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.activity.localeCompare(b.activity));
    const first = events[0].timestamp;
    const last = events[events.length - 1].timestamp;
    const caseDurationHours = Math.max(0, (Date.parse(last) - Date.parse(first)) / 36e5);
    for (const event of events) activities.add(event.activity);
    cases.push({
      caseId,
      attributes: caseAttributes.get(caseId) ?? {},
      caseStart: first,
      caseEnd: last,
      caseDurationHours: round(caseDurationHours),
      events
    });
  }

  cases.sort((a, b) => a.caseStart.localeCompare(b.caseStart) || a.caseId.localeCompare(b.caseId));
  if (!cases.length) throw new Error("CSV files did not produce any complete cases.");

  const durations = cases.map((item) => item.caseDurationHours);
  const eventCount = cases.reduce((sum, item) => sum + item.events.length, 0);
  const sortedActivities = [...activities].sort((a, b) => a.localeCompare(b));

  return {
    metadata: {
      logName: metadata.logName,
      source: metadata.source,
      doi: metadata.doi ?? "",
      caseCount: cases.length,
      eventCount,
      activityCount: sortedActivities.length,
      timeRange: { from: cases[0].caseStart, to: maxString(cases.map((item) => item.caseEnd)) },
      sampleNote: `Loaded from static CSV files: ${formatCount(cases.length)} cases and ${formatCount(eventCount)} events.`,
      generatedAt: new Date().toISOString(),
      avgCaseDurationHours: round(mean(durations)),
      medianCaseDurationHours: round(median(durations))
    },
    schema: { caseAttributes: buildSchema(cases) },
    activities: sortedActivities,
    cases
  };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

function parseCsv(text: string): CsvRow[] {
  const cleanText = text.replace(/^\uFEFF/, "");
  const firstLine = cleanText.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < cleanText.length; index += 1) {
    const char = cleanText[index];
    const next = cleanText[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);

  const [header = [], ...body] = rows;
  return body.map((values) => {
    const output: CsvRow = {};
    header.forEach((key, index) => {
      output[key.trim()] = (values[index] ?? "").trim();
    });
    return output;
  });
}

function normalizeCaseAttributes(row: CsvRow): Record<string, string | number | null> {
  const mapped: Record<string, string | number | null> = {
    salesChannel: emptyToNull(firstValue(row, ["sales_channel", "salesChannel", "Sales Channel"])),
    maturityStage: emptyToNull(firstValue(row, ["maturity_stage", "maturityStage", "Maturity Stage"])),
    inventoryCategory: emptyToNull(firstValue(row, ["inventory_category", "inventoryCategory", "Inventory Category"])),
    reserveStatus: emptyToNull(firstValue(row, ["reserve_status", "reserveStatus", "Reserve Status"])),
    market: emptyToNull(firstValue(row, ["market", "Market"])),
    salesCompany: numericOrString(firstValue(row, ["sales_company", "salesCompany", "Sales Company"])),
    transportationTimeDays: numericOrString(firstValue(row, ["transportation_time_days", "transportationTimeDays", "Transportation Time Days"])),
    advanceNoticeTimeDays: numericOrString(firstValue(row, ["advance_notice_time_days", "advanceNoticeTimeDays", "Advance Notice Time Days"])),
    purchaseOrderDate: dateOrNull(firstValue(row, ["purchase_order_date", "purchaseOrderDate", "Purchase Order Date"])),
    dateOfCustomerDelivery: dateOrNull(firstValue(row, ["date_of_customer_delivery", "dateOfCustomerDelivery", "Customer Delivery Date"])),
    dateOfArrivalAtPort: dateOrNull(firstValue(row, ["date_of_arrival_at_port", "dateOfArrivalAtPort", "Arrival At Port"])),
    dateOfClearance: dateOrNull(firstValue(row, ["date_of_clearance", "dateOfClearance", "Clearance Date"])),
    priority: numericOrString(firstValue(row, ["priority", "Priority"])),
    impact: numericOrString(firstValue(row, ["impact", "Impact"])),
    urgency: numericOrString(firstValue(row, ["urgency", "Urgency"])),
    category: emptyToNull(firstValue(row, ["category", "Category"])),
    assetType: emptyToNull(firstValue(row, ["asset_type", "Asset Type Affected", "assetType"])),
    assetSubtype: emptyToNull(firstValue(row, ["asset_subtype", "Asset SubType Affected", "assetSubtype"])),
    service: emptyToNull(firstValue(row, ["service", "Service Affected"])),
    closureCode: emptyToNull(firstValue(row, ["closure_code", "Closure Code", "closureCode"])),
    reassignmentCount: numericOrString(firstValue(row, ["reassignment_count", "Number of Reassignments", "reassignmentCount"])),
    totalTimeHours: numericOrString(firstValue(row, ["total_time_hours", "Total Time", "totalTimeHours"]))
  };

  for (const [key, value] of Object.entries(row)) {
    if (isCaseIdColumn(key) || value === "") continue;
    const normalizedKey = normalizeColumnName(key);
    if (!(normalizedKey in mapped)) mapped[normalizedKey] = numericOrString(value);
  }
  return mapped;
}

function buildSchema(cases: CaseRecord[]): CaseAttributeSchema[] {
  const keys = new Set<string>();
  cases.forEach((caseRecord) => Object.keys(caseRecord.attributes).forEach((key) => keys.add(key)));
  const ordered = [...defaultSchemaOrder, ...[...keys].filter((key) => !defaultSchemaOrder.includes(key)).sort()];
  const schema: CaseAttributeSchema[] = [];

  for (const key of ordered) {
    const values = cases.map((caseRecord) => caseRecord.attributes[key]).filter((value) => value !== null && value !== undefined);
    if (!values.length) continue;
    if (dateAttributeKeys.has(key)) {
      const dateValues = values.map(String).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
      if (dateValues.length) {
        schema.push({
          name: key,
          label: labelFor(key),
          type: "date",
          min: dateValues.reduce((min, value) => (value < min ? value : min), dateValues[0]),
          max: dateValues.reduce((max, value) => (value > max ? value : max), dateValues[0])
        });
        continue;
      }
    }
    if (key === "salesCompany") {
      const categoricalValues = [...new Set(values.map(String))].sort((a, b) => Number(a) - Number(b));
      schema.push({ name: key, label: labelFor(key), type: "categorical", values: categoricalValues.slice(0, 80) });
      continue;
    }
    const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (numbers.length === values.length) {
      schema.push({ name: key, label: labelFor(key), type: "numeric", min: round(Math.min(...numbers)), max: round(Math.max(...numbers)) });
      continue;
    }
    const categoricalValues = [...new Set(values.map(String))].sort((a, b) => a.localeCompare(b));
    if (categoricalValues.length <= 80) {
      schema.push({ name: key, label: labelFor(key), type: "categorical", values: categoricalValues.slice(0, 40) });
    }
  }

  const durations = cases.map((caseRecord) => caseRecord.caseDurationHours);
  schema.push({
    name: "caseDurationHours",
    label: "Case duration (hours)",
    type: "numeric",
    min: round(Math.min(...durations)),
    max: round(percentile(durations, 98))
  });
  return schema;
}

function firstValue(row: CsvRow, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

function emptyToNull(value: string): string | null {
  return value || null;
}

function dateOrNull(value: string): string | null {
  if (!value) return null;
  const parsed = parseTimestamp(value);
  return parsed ? parsed.toISOString().slice(0, 10) : value;
}

function numericOrString(value: string): string | number | null {
  if (!value) return null;
  const normalized = value.replace(",", ".");
  if (/^-?\d+(\.\d+)?$/.test(normalized)) return Number(normalized);
  return value;
}

function parseTimestamp(value: string): Date | null {
  const trimmed = value.trim();
  const yearFirst = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (yearFirst) {
    const [, year, month, day, hour = "0", minute = "0", second = "0"] = yearFirst;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  }

  const dayFirst = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (dayFirst) {
    const [, day, month, year, hour = "0", minute = "0", second = "0"] = dayFirst;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  }

  const direct = Date.parse(trimmed);
  return Number.isNaN(direct) ? null : new Date(direct);
}

function normalizeColumnName(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, char: string) => char.toUpperCase())
    .replace(/^[A-Z]/, (char) => char.toLowerCase());
}

function isCaseIdColumn(key: string): boolean {
  return ["item_id", "case_id", "Case ID", "Incident ID", "incident_id"].includes(key);
}

function labelFor(key: string): string {
  if (knownAttributeLabels[key]) return knownAttributeLabels[key];
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values: number[], pct: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((pct / 100) * (sorted.length - 1))));
  return sorted[index] ?? 0;
}

function maxString(values: string[]): string {
  return values.reduce((max, value) => (value > max ? value : max), values[0] ?? "");
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
