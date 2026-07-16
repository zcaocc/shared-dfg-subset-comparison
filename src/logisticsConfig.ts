import type { SubsetDefinition } from "./types";

export const colors = ["#d92727", "#09b04f", "#1d64df", "#d4a600", "#7b3fc6", "#e87500"];

export const subsetStorageKey = "logistics-subsets-v5";
export const attributeConfigStorageKey = "logistics-builder-attributes-v4";
export const subsetStyleStorageKey = "logistics-subset-styles-v2";

export const defaultBuilderAttributes = [
  "salesChannel",
  "salesCompany",
  "transportationTimeDays",
  "caseDurationHours",
  "market",
  "inventoryCategory",
  "reserveStatus",
  "purchaseOrderDate",
  "dateOfArrivalAtPort",
  "dateOfClearance",
  "dateOfCustomerDelivery"
];

export const realtimeFacetFields = new Set(["salesChannel", "reserveStatus", "inventoryCategory", "market", "salesCompany"]);

export const invertibleAttributeFields = new Set([
  "salesChannel",
  "reserveStatus",
  "inventoryCategory",
  "market",
  "salesCompany",
  "transportationTimeDays",
  "advanceNoticeTimeDays",
  "purchaseOrderDate",
  "dateOfCustomerDelivery",
  "dateOfArrivalAtPort",
  "dateOfClearance",
  "caseDurationHours"
]);

export const marketTopoIds: Record<string, string> = {
  Belgium: "056",
  Britain: "826",
  Croatia: "191",
  Denmark: "208",
  France: "250",
  Germany: "276",
  Greece: "300",
  Italy: "380",
  Netherlands: "528",
  Norway: "578",
  Portugal: "620",
  Slovenia: "705",
  Spain: "724",
  Switzerland: "756"
};

export const marketByTopoId = Object.fromEntries(Object.entries(marketTopoIds).map(([market, id]) => [id, market]));

export const marketLabelCoordinates: Record<string, [number, number]> = {
  Belgium: [4.7, 50.8],
  Britain: [-2.6, 54.5],
  Croatia: [16.4, 45.2],
  Denmark: [10.0, 56.2],
  France: [2.4, 46.4],
  Germany: [10.3, 51.1],
  Greece: [22.0, 39.0],
  Italy: [12.4, 43.2],
  Netherlands: [5.4, 52.2],
  Norway: [8.4, 61.4],
  Portugal: [-8.1, 39.6],
  Slovenia: [14.9, 46.1],
  Spain: [-3.6, 40.3],
  Switzerland: [8.2, 46.8]
};

export const marketLabelOffsets: Record<string, [number, number]> = {
  Belgium: [-46, -3],
  Britain: [-22, 1],
  Croatia: [50, 13],
  Denmark: [32, -9],
  France: [-38, 22],
  Germany: [45, 1],
  Greece: [34, 7],
  Italy: [28, 18],
  Netherlands: [42, -7],
  Norway: [0, 8],
  Portugal: [-32, 9],
  Slovenia: [46, -8],
  Spain: [-15, 21],
  Switzerland: [0, 29]
};

export const defaultSelectedSubsetIds = ["agency-britain", "agency-belgium", "agency-denmark"];

export const knownAttributeLabels: Record<string, string> = {
  salesChannel: "Sales channel",
  maturityStage: "Maturity stage",
  inventoryCategory: "Inventory category",
  reserveStatus: "Reserve status",
  market: "Market",
  salesCompany: "Sales company",
  transportationTimeDays: "Transport time (days)",
  advanceNoticeTimeDays: "Notice buffer (days)",
  purchaseOrderDate: "Purchase order date",
  dateOfCustomerDelivery: "Customer delivery date",
  dateOfArrivalAtPort: "Arrival at port",
  dateOfClearance: "Customs clearance date",
  priority: "Priority",
  impact: "Impact",
  urgency: "Urgency",
  category: "Category",
  assetType: "Asset type affected",
  assetSubtype: "Asset subtype affected",
  service: "Service affected",
  closureCode: "Closure code",
  reassignmentCount: "Number of reassignments",
  totalTimeHours: "Total resolution time (hours)"
};

export const defaultSchemaOrder = [
  "salesChannel",
  "maturityStage",
  "inventoryCategory",
  "transportationTimeDays",
  "advanceNoticeTimeDays",
  "purchaseOrderDate",
  "dateOfCustomerDelivery",
  "dateOfArrivalAtPort",
  "dateOfClearance",
  "reserveStatus",
  "market",
  "salesCompany",
  "category",
  "assetType",
  "assetSubtype",
  "service",
  "closureCode",
  "priority",
  "impact",
  "urgency",
  "reassignmentCount",
  "totalTimeHours"
];

export const dateAttributeKeys = new Set(["purchaseOrderDate", "dateOfCustomerDelivery", "dateOfArrivalAtPort", "dateOfClearance"]);

export function defaultSubsets(): SubsetDefinition[] {
  return [
    {
      id: "direct-netherlands-phase1",
      name: "Netherlands Phase 1",
      description: "Netherlands standard cases in the early phase.",
      color: colors[4],
      requiredActivities: [],
      excludedActivities: [],
      reworkActivities: [],
      attributeFilters: [
        { field: "salesChannel", operator: "in", values: ["Direct Sales"] },
        { field: "market", operator: "in", values: ["Netherlands"] },
        { field: "inventoryCategory", operator: "in", values: ["Standard"] }
      ],
      timeWindow: {
        endFrom: "2024-12-24T00:00:00",
        endTo: "2025-08-03T23:59:59"
      }
    },
    {
      id: "direct-netherlands-phase2",
      name: "Netherlands Phase 2",
      description: "Netherlands standard cases in the middle phase.",
      color: colors[1],
      requiredActivities: [],
      excludedActivities: [],
      reworkActivities: [],
      attributeFilters: [
        { field: "salesChannel", operator: "in", values: ["Direct Sales"] },
        { field: "market", operator: "in", values: ["Netherlands"] },
        { field: "inventoryCategory", operator: "in", values: ["Standard"] },
        { field: "dateOfClearance", operator: "range", min: "2025-04-08", max: "2026-04-03" }
      ],
      timeWindow: {
        endFrom: "2025-08-04T00:00:00",
        endTo: "2026-01-14T23:59:59"
      }
    },
    {
      id: "direct-netherlands-phase3",
      name: "Netherlands Phase 3",
      description: "Netherlands standard cases in the latest phase.",
      color: colors[5],
      requiredActivities: [],
      excludedActivities: [],
      reworkActivities: [],
      attributeFilters: [
        { field: "salesChannel", operator: "in", values: ["Direct Sales"] },
        { field: "market", operator: "in", values: ["Netherlands"] },
        { field: "inventoryCategory", operator: "in", values: ["Standard"] },
        { field: "dateOfClearance", operator: "range", min: "2025-08-04", max: "2026-04-03" },
        { field: "dateOfArrivalAtPort", operator: "range", min: "2026-01-14", max: "2026-03-23" }
      ],
      timeWindow: {
        endFrom: "2026-01-15T00:00:00",
        endTo: "2026-04-22T23:59:59"
      }
    },
    {
      id: "agency-denmark",
      name: "Denmark",
      description: "Agency cases in Denmark.",
      color: colors[0],
      requiredActivities: [],
      excludedActivities: [],
      reworkActivities: [],
      attributeFilters: [
        { field: "salesChannel", operator: "in", values: ["Agency"] },
        { field: "market", operator: "in", values: ["Denmark"] }
      ]
    },
    {
      id: "agency-belgium",
      name: "Belgium",
      description: "Agency cases in Belgium.",
      color: colors[3],
      requiredActivities: [],
      excludedActivities: [],
      reworkActivities: [],
      attributeFilters: [
        { field: "salesChannel", operator: "in", values: ["Agency"] },
        { field: "market", operator: "in", values: ["Belgium"] }
      ]
    },
    {
      id: "agency-britain",
      name: "Britain",
      description: "Agency cases in Britain.",
      color: colors[2],
      requiredActivities: [],
      excludedActivities: [],
      reworkActivities: [],
      attributeFilters: [
        { field: "salesChannel", operator: "in", values: ["Agency"] },
        { field: "market", operator: "in", values: ["Britain"] }
      ]
    },
    {
      id: "sales-direct",
      name: "Direct Sales",
      description: "Direct sales channel cases.",
      color: colors[0],
      requiredActivities: [],
      excludedActivities: [],
      reworkActivities: [],
      attributeFilters: [{ field: "salesChannel", operator: "in", values: ["Direct Sales"] }]
    },
    {
      id: "sales-agency",
      name: "Agency",
      description: "Agency sales channel cases.",
      color: colors[1],
      requiredActivities: [],
      excludedActivities: [],
      reworkActivities: [],
      attributeFilters: [{ field: "salesChannel", operator: "in", values: ["Agency"] }]
    },
    {
      id: "direct-netherlands-standard",
      name: "Netherlands Standard",
      description: "Direct Sales standard cases in the Netherlands.",
      color: colors[3],
      requiredActivities: [],
      excludedActivities: [],
      reworkActivities: [],
      attributeFilters: [
        { field: "salesChannel", operator: "in", values: ["Direct Sales"] },
        { field: "market", operator: "in", values: ["Netherlands"] },
        { field: "inventoryCategory", operator: "in", values: ["Standard"] }
      ]
    },
    {
      id: "direct-france-standard",
      name: "France Standard",
      description: "Direct Sales standard cases in France.",
      color: colors[4],
      requiredActivities: [],
      excludedActivities: [],
      reworkActivities: [],
      attributeFilters: [
        { field: "salesChannel", operator: "in", values: ["Direct Sales"] },
        { field: "market", operator: "in", values: ["France"] },
        { field: "inventoryCategory", operator: "in", values: ["Standard"] }
      ]
    }
  ];
}
