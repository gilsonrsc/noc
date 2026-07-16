import {describe, expect, it} from "vitest";
import {
  formatCapacity,
  formatPercentage,
  summaryMetricValue,
  thresholdMatches,
} from "../src/presentation";
import type {MetricDescriptor, MetricThresholdDescriptor, SummaryEntity} from "../src/types";

const threshold: MetricThresholdDescriptor = {
  op: ">=",
  value: 90,
  clear_value: 80,
  alarm_class: "NOC | PM | High",
  alarm_labels: [],
  severity: "warning",
  rule_id: "rule-id",
  rule_name: "Configured warning",
};

describe("dashboard presentation", () => {
  it("formats inventory capacity without inventing a value", () => {
    expect(formatCapacity(10_000_000_000)).toBe("10 Gbps");
    expect(formatCapacity(0)).toBe("Not reported");
  });

  it("formats percentages at an operational precision", () => {
    expect(formatPercentage(8.25)).toBe("8.3%");
    expect(formatPercentage(82.5)).toBe("83%");
    expect(formatPercentage(null)).toBe("—");
  });

  it("evaluates the operator supplied by the NOC metric rule", () => {
    expect(thresholdMatches(90, threshold)).toBe(true);
    expect(thresholdMatches(89.9, threshold)).toBe(false);
    expect(thresholdMatches(-18, {...threshold, op: "<=", value: -18})).toBe(true);
  });

  it("formats a summary reduction with its configured unit", () => {
    const metric = {
      id: "traffic-in",
      name: "Interface | Load | In",
      description: "Inbound traffic",
      scope: "Interface",
      category: "traffic",
      direction: "in",
      unit: {code: "bit/s", label: "bps"},
      color: null,
      is_delta: false,
      interval: 60,
      filter_fields: ["interface"],
    } satisfies MetricDescriptor;
    const entity: SummaryEntity = {
      id: "interface-id",
      label: "Gi0/1",
      description: "Uplink",
      status: "Up/10G/Full",
      admin_status: true,
      oper_status: true,
      capacity: {in_bps: 10_000_000_000, out_bps: 10_000_000_000},
      capabilities: ["traffic"],
      metric_ids: ["traffic-in"],
      metric_thresholds: {},
      values: {
        "traffic-in": {
          current: 1_500_000_000,
          average: 1_000_000_000,
          peak: 2_000_000_000,
          p95: 1_800_000_000,
          latest_ts: 1,
        },
      },
    };

    expect(summaryMetricValue(entity, metric)).toBe("1.5 Gbps");
    expect(summaryMetricValue(entity, metric, "p95")).toBe("1.8 Gbps");
  });
});
