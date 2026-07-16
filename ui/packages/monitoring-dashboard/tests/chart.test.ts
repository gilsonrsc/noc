import {describe, expect, it} from "vitest";
import {
  compactMetricName,
  earliestSeriesTimestamp,
  formatMetricValueWithUnit,
  seriesStatistics,
} from "../src/chart";
import type {TimeSeries} from "../src/types";

function timeSeries(points: TimeSeries["points"]): TimeSeries {
  return {
    key: "traffic-in",
    metric_id: "traffic-in",
    name: "Interface | Load | In",
    target: "noc::interface::Gi0/1",
    unit: {code: "bit/s", label: "bps"},
    points,
  };
}

describe("chart presentation helpers", () => {
  it("uses compact operational metric names", () => {
    expect(compactMetricName("Interface | Load | In")).toBe("Traffic In");
    expect(compactMetricName("Interface | DOM | RxPower")).toBe("Optical Rx");
  });

  it("formats bit rates with their unit", () => {
    expect(formatMetricValueWithUnit(1_500_000_000, "bps")).toBe("1.5 Gbps");
  });

  it("calculates statistics without spreading a bounded server response", () => {
    const points: TimeSeries["points"] = Array.from({length: 100_001}, (_, index) => [
      index,
      index,
    ]);

    expect(seriesStatistics(points)).toEqual({
      current: 100_000,
      average: 50_000,
      peak: 100_000,
    });
  });

  it("ignores non-finite samples and finds the earliest timestamp", () => {
    const first = timeSeries([
      [20, Number.NaN],
      [30, 3],
    ]);
    const second = timeSeries([[10, 2]]);

    expect(seriesStatistics(first.points)).toEqual({current: 3, average: 3, peak: 3});
    expect(earliestSeriesTimestamp([first, second])).toBe(10);
    expect(earliestSeriesTimestamp([])).toBeNull();
  });
});
