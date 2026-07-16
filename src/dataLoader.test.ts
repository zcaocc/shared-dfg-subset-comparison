import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEventLogFromCsv, loadEventLog } from "./dataLoader";

const caseCsv = `case_id,category,closure_code,priority,asset_type,reassignment_count
C1,incident,No error - works as designed,1,application,0
C2,incident,Software,3,hardware,2
`;

const eventCsv = `case_id,activity,timestamp,assignment_group
C1,Open,01-01-2024 00:00:00,Desk
C1,Closed,01-01-2024 02:00:00,Desk
C2,Open,2024-01-02T00:00:00.000Z,Desk
C2,Assignment,2024-01-02T01:00:00.000Z,Support
C2,Closed,2024-01-02T04:00:00.000Z,Support
`;

describe("CSV event log loader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds the internal event log shape from static case and event CSVs", () => {
    const log = buildEventLogFromCsv(caseCsv, eventCsv);
    expect(log.metadata.caseCount).toBe(2);
    expect(log.metadata.eventCount).toBe(5);
    expect(log.activities).toEqual(["Assignment", "Closed", "Open"]);
    expect(log.cases[0].attributes.closureCode).toBe("No error - works as designed");
    expect(log.cases[1].caseDurationHours).toBe(4);
    expect(log.schema.caseAttributes.some((attribute) => attribute.name === "closureCode")).toBe(true);
    expect(log.schema.caseAttributes.some((attribute) => attribute.name === "caseDurationHours")).toBe(true);
  });

  it("treats ambiguous dashed CSV dates as day-first dates", () => {
    const log = buildEventLogFromCsv(
      "case_id,category\nC3,incident\n",
      `case_id,activity,timestamp
C3,Open,02-01-2024 00:00:00
C3,Closed,03-01-2024 00:00:00
`
    );

    expect(log.cases[0].caseStart).toBe("2024-01-02T00:00:00.000Z");
    expect(log.cases[0].caseDurationHours).toBe(24);
  });

  it("maps logistics case table and event log columns into the prototype schema", () => {
    const log = buildEventLogFromCsv(
      `item_id,sales_channel,maturity_stage,market,transportation_time_days,advance_notice_time_days,purchase_order_date,date_of_customer_delivery,date_of_arrival_at_port,date_of_clearance
I1,Direct Sales,M1,EU,2.5,10,2025-01-01,2025-01-10,2025-01-06,2025-01-07
I2,Agency,M0,EU,,5,2025-02-01,2025-02-12,2025-02-08,2025-02-09
`,
      `item_id,activity,op_time,operator_id
I1,Reserve Inventory,2025-01-01 08:00:00,W1
I1,Deliver,2025-01-02 08:00:00,W2
I2,Reserve Inventory,2025-01-03 08:00:00,W1
I2,Deliver,2025-01-05 08:00:00,W2
`,
      {
        logName: "Logistics Vehicle Process Event Log",
        source: "test",
        doi: ""
      }
    );

    expect(log.metadata.logName).toBe("Logistics Vehicle Process Event Log");
    expect(log.cases.map((caseRecord) => caseRecord.caseId)).toEqual(["I1", "I2"]);
    expect(log.cases[0].attributes.salesChannel).toBe("Direct Sales");
    expect(log.cases[1].attributes.salesChannel).toBe("Agency");
    expect(log.cases[0].attributes.maturityStage).toBe("M1");
    expect(log.cases[0].attributes.transportationTimeDays).toBe(2.5);
    expect(log.cases[1].attributes.transportationTimeDays).toBeNull();
    expect(log.cases[0].attributes.purchaseOrderDate).toBe("2025-01-01");
    expect(log.cases[0].events[0].assignmentGroup).toBe("W1");
    expect(log.schema.caseAttributes.find((attribute) => attribute.name === "transportationTimeDays")?.type).toBe("numeric");
    expect(log.schema.caseAttributes.find((attribute) => attribute.name === "advanceNoticeTimeDays")?.type).toBe("numeric");
    expect(log.schema.caseAttributes.find((attribute) => attribute.name === "purchaseOrderDate")).toMatchObject({
      type: "date",
      min: "2025-01-01",
      max: "2025-02-01"
    });
    expect(log.schema.caseAttributes.find((attribute) => attribute.name === "dateOfCustomerDelivery")?.type).toBe("date");
    expect(log.schema.caseAttributes.find((attribute) => attribute.name === "dateOfArrivalAtPort")?.type).toBe("date");
    expect(log.schema.caseAttributes.find((attribute) => attribute.name === "dateOfClearance")?.type).toBe("date");
    expect(log.schema.caseAttributes.find((attribute) => attribute.name === "salesChannel")?.values).toContain("Direct Sales");
    expect(log.schema.caseAttributes.find((attribute) => attribute.name === "maturityStage")?.values).toContain("M0");
  });

  it("loads only the logistics CSV source by default", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/data/attributes.csv") return new Response(caseCsv);
      if (url === "/data/eventlog.csv") return new Response(eventCsv);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const log = await loadEventLog();

    expect(log.metadata.source).toBe("Static logistics case table and event log CSV files");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/data/attributes.csv", "/data/eventlog.csv"]);
  });
});
