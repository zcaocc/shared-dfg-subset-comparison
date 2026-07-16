import { describe, expect, it } from "vitest";
import { buildEventLogFromCsv } from "./dataLoader";
import { buildDraftSubset, builderStateFromSubset, dateRangeFromLog, type ActivityMode } from "./subsetDraft";

const log = buildEventLogFromCsv(
  `item_id,sales_channel,market,transportation_time_days,purchase_order_date
I1,Direct Sales,Netherlands,2.5,2025-01-01
I2,Agency,Belgium,7.0,2025-02-01
`,
  `item_id,activity,op_time
I1,Reserve Inventory,2025-01-01 08:00:00
I1,Deliver,2025-01-02 08:00:00
I2,Reserve Inventory,2025-01-03 08:00:00
I2,Deliver,2025-01-05 08:00:00
`,
  {
    logName: "Logistics Vehicle Process Event Log",
    source: "test",
    doi: ""
  }
);

describe("subset builder draft conversion", () => {
  it("builds a case-level subset definition from builder draft state", () => {
    const activityModes: Record<string, ActivityMode> = {
      Deliver: "required",
      "Reserve Inventory": "rework"
    };
    const fullRange = dateRangeFromLog(log);

    const subset = buildDraftSubset({
      activityModes,
      attributeValues: { salesChannel: ["Direct Sales"] },
      builderAttributeFields: ["salesChannel", "transportationTimeDays", "purchaseOrderDate"],
      color: "#ef4444",
      endDateRange: fullRange,
      invertedAttributes: { transportationTimeDays: true },
      invertedDateRanges: { start: false, end: true },
      log,
      numericRanges: {
        purchaseOrderDate: { min: "2025-01-01", max: "2025-01-31" },
        transportationTimeDays: { min: "1", max: "5" }
      },
      startDateRange: { min: "2025-01-01", max: "2025-01-31" },
      subsetDescription: "direct short transport",
      subsetName: "Direct short transport"
    });

    expect(subset.requiredActivities).toEqual(["Deliver"]);
    expect(subset.reworkActivities).toEqual(["Reserve Inventory"]);
    expect(subset.attributeFilters).toEqual([
      { field: "salesChannel", operator: "in", values: ["Direct Sales"], negated: false },
      { field: "transportationTimeDays", operator: "range", min: 1, max: 5, negated: true },
      { field: "purchaseOrderDate", operator: "range", min: "2025-01-01", max: "2025-01-31", negated: false }
    ]);
    expect(subset.timeWindow).toMatchObject({
      startFrom: "2025-01-01T00:00:00",
      startTo: "2025-01-31T23:59:59",
      invertEndRange: true
    });
  });

  it("loads an existing subset back into builder draft state", () => {
    const loaded = builderStateFromSubset(
      log,
      {
        id: "subset-1",
        name: "Loaded subset",
        description: "Saved description",
        color: "#ef4444",
        requiredActivities: ["Deliver"],
        excludedActivities: [],
        reworkActivities: [],
        attributeFilters: [
          { field: "salesChannel", operator: "in", values: ["Agency"] },
          { field: "purchaseOrderDate", operator: "range", min: "2025-02-01", max: "2025-02-28" }
        ],
        timeWindow: {
          startFrom: "2025-01-03T00:00:00",
          startTo: "2025-01-05T23:59:59"
        }
      },
      ["market"]
    );

    expect(loaded.activityModes.Deliver).toBe("required");
    expect(loaded.attributeValues.salesChannel).toEqual(["Agency"]);
    expect(loaded.numericRanges.purchaseOrderDate).toEqual({ min: "2025-02-01", max: "2025-02-28" });
    expect(loaded.builderAttributeFields).toEqual(["market", "salesChannel", "purchaseOrderDate"]);
    expect(loaded.startDateRange).toEqual({ min: "2025-01-03", max: "2025-01-05" });
    expect(loaded.subsetName).toBe("Loaded subset refined");
  });
});
