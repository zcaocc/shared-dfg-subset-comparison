import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildEventLogFromCsv } from "./dataLoader";
import { defaultSubsets } from "./logisticsConfig";
import { computeDfg, filterCases } from "./processMining";

const expectedAgencyMetrics = {
  "agency-britain": { cases: 1523, events: 20019, nodes: 25, edges: 151 },
  "agency-denmark": { cases: 1355, events: 17850, nodes: 23, edges: 137 },
  "agency-belgium": { cases: 357, events: 5162, nodes: 23, edges: 125 }
};

describe("public dataset browser/server parity", () => {
  it("matches the optional server DFG metrics for the three-country agency scenario", () => {
    const caseCsv = readFileSync("public/data/attributes.csv", "utf8");
    const eventCsv = readFileSync("public/data/eventlog.csv", "utf8");
    const log = buildEventLogFromCsv(caseCsv, eventCsv);
    const subsets = defaultSubsets().filter((subset) => subset.id in expectedAgencyMetrics);

    for (const subset of subsets) {
      const dfg = computeDfg(subset, filterCases(log.cases, subset));
      expect({
        cases: dfg.metrics.caseCount,
        events: dfg.metrics.eventCount,
        nodes: dfg.nodes.length,
        edges: dfg.edges.length
      }).toEqual(expectedAgencyMetrics[subset.id as keyof typeof expectedAgencyMetrics]);
    }
  });
});
