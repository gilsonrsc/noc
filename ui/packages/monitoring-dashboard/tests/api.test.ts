import {afterEach, describe, expect, it, vi} from "vitest";
import {buildMetricQuery, intervalForRange, loadManifest, loadSummary, readJson} from "../src/api";
import {
  compactMetricName,
  compactSeriesTarget,
  formatMetricValue,
  formatMetricValueWithUnit,
  seriesDisplayName,
} from "../src/chart";
import {
  capacityForSeries,
  defaultMetricView,
  metricsForEntity,
  metricsForView,
  seriesIsStale,
} from "../src/state";
import {rankInterfaces, summaryMetrics, utilizationFor} from "../src/summary";
import type {DashboardEntity, DashboardGroup, SummaryEntity} from "../src/types";

const group: DashboardGroup = {
  id: "interfaces:profile-id",
  title: "Uplink",
  kind: "interface",
  module_id: "interfaces",
  metrics: [],
  entities: [],
};

const entity: DashboardEntity = {
  id: "interface-id",
  label: "Gi0/1",
  description: "Uplink",
  status: "Up/1G/Full",
  admin_status: true,
  oper_status: true,
  full_duplex: true,
  capacity: {in_bps: 1_000_000_000, out_bps: 1_000_000_000},
  filters: {interface: "Gi0/1"},
  metric_ids: [],
  metric_intervals: {},
  metric_thresholds: {},
  capabilities: ["traffic", "errors"],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadManifest", () => {
  it("bypasses cached authentication responses", async () => {
    const manifest = {api_version: "1.0"};
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(manifest),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadManifest("42")).resolves.toEqual(manifest);
    expect(fetchMock).toHaveBeenCalledWith(
      "/pm/ddash/manifest/?dashboard=mo&id=42",
      expect.objectContaining({cache: "no-store", credentials: "same-origin"}),
    );
  });
});

describe("readJson", () => {
  it("turns an empty authentication response into an actionable message", async () => {
    const response = new Response("", {status: 401});

    await expect(readJson(response)).rejects.toThrow(
      "Your NOC session is unavailable. Sign in again and retry.",
    );
  });

  it("preserves API error messages", async () => {
    const response = new Response(JSON.stringify({error: "Object not found"}), {
      status: 404,
      headers: {"Content-Type": "application/json"},
    });

    await expect(readJson(response)).rejects.toThrow("Object not found");
  });
});

describe("loadSummary", () => {
  it("posts a bounded semantic summary request", async () => {
    const response = {
      api_version: "1.3",
      inventory: {total: 0, operational: 0, down: 0, disabled: 0, unknown: 0, optical: 0},
      entities: [],
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(response),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadSummary("/summary/", "42", "interfaces", ["in"], 1000, 2000)).resolves.toEqual(
      response,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/summary/",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          object_id: "42",
          group_id: "interfaces",
          metric_ids: ["in"],
          from: 1000,
          to: 2000,
        }),
      }),
    );
  });
});

describe("intervalForRange", () => {
  it("selects a bounded friendly interval", () => {
    expect(intervalForRange(60 * 60 * 1000)).toBe(10);
    expect(intervalForRange(24 * 60 * 60 * 1000)).toBe(300);
    expect(intervalForRange(365 * 24 * 60 * 60 * 1000)).toBe(86400);
  });
});

describe("buildMetricQuery", () => {
  it("uses semantic identifiers and does not expose raw filters", () => {
    expect(buildMetricQuery("42", group, entity, ["metric-a", "metric-b"], 1000, 3_601_000)).toEqual({
      object_id: "42",
      from: 1000,
      to: 3_601_000,
      interval: 10,
      series: [
        {
          group_id: "interfaces:profile-id",
          entity_id: "interface-id",
          metric_id: "metric-a",
        },
        {
          group_id: "interfaces:profile-id",
          entity_id: "interface-id",
          metric_id: "metric-b",
        },
      ],
    });
  });
});

describe("formatMetricValue", () => {
  it("uses readable SI units for bandwidth", () => {
    expect(formatMetricValue(13_052_608_022, "bps")).toBe("13.1 G");
    expect(formatMetricValue(3_500_000, "bit/s")).toBe("3.5 M");
    expect(formatMetricValueWithUnit(13_052_608_022, "bps")).toBe("13.1 Gbps");
  });
});

describe("compactMetricName", () => {
  it("removes internal scope separators from labels", () => {
    expect(compactMetricName("Interface | Load | In")).toBe("Traffic In");
    expect(compactMetricName("Interface | Errors | Out")).toBe("Errors Out");
    expect(compactMetricName("CPU | Usage")).toBe("CPU Usage");
  });

  it("adds a clean target only when a metric has multiple series", () => {
    const first = {
      key: "cpu:item",
      metric_id: "cpu",
      name: "CPU | Usage",
      target: "noc::chassis::0/noc::cpu::CPU item",
      unit: {code: "%", label: "percent"},
      points: [[1, 4]] as [number, number][],
    };
    const second = {...first, key: "cpu:slot", target: "noc::cpu::CPU Slot 0"};
    expect(compactSeriesTarget(first.target)).toBe("CPU item");
    expect(seriesDisplayName(first, [first])).toBe("CPU Usage");
    expect(seriesDisplayName(first, [first, second])).toBe("CPU Usage · CPU item");
  });
});

describe("monitoring state", () => {
  const trafficMetric = {
    id: "traffic-in",
    name: "Interface | Load | In",
    description: "",
    scope: "Interface",
    category: "traffic" as const,
    direction: "in" as const,
    unit: {code: "bit/s", label: "bps"},
    color: null,
    is_delta: false,
    interval: 60,
    filter_fields: ["interface"],
  };
  const errorMetric = {
    ...trafficMetric,
    id: "errors",
    name: "Interface | Errors | In",
    category: "errors" as const,
  };

  it("builds traffic and error views", () => {
    expect(defaultMetricView([trafficMetric, errorMetric])).toBe("traffic");
    expect(metricsForView([trafficMetric, errorMetric], "traffic")).toEqual(["traffic-in"]);
    expect(metricsForView([trafficMetric, errorMetric], "errors")).toEqual(["errors"]);
  });

  it("opens optical profiles on their signal view", () => {
    const opticalMetric = {
      ...trafficMetric,
      id: "optical-rx",
      name: "Interface | DOM | RxPower",
      category: "optical" as const,
    };
    expect(defaultMetricView([trafficMetric, opticalMetric])).toBe("optical");
    expect(metricsForView([trafficMetric, opticalMetric], "optical")).toEqual(["optical-rx"]);
    expect(compactMetricName(opticalMetric.name)).toBe("Optical Rx");
  });

  it("exposes only metrics enabled for the selected interface", () => {
    const opticalMetric = {
      ...trafficMetric,
      id: "optical-rx",
      name: "Interface | DOM | RxPower",
      category: "optical" as const,
    };
    const capabilityGroup = {...group, metrics: [trafficMetric, errorMetric, opticalMetric]};
    const trafficEntity = {...entity, metric_ids: ["traffic-in", "errors"]};
    const opticalEntity = {
      ...entity,
      id: "optical-interface",
      metric_ids: ["traffic-in", "errors", "optical-rx"],
      capabilities: ["traffic", "errors", "optical"] as const,
    };

    expect(metricsForEntity(capabilityGroup, trafficEntity).map((metric) => metric.id)).toEqual([
      "traffic-in",
      "errors",
    ]);
    expect(metricsForEntity(capabilityGroup, opticalEntity).map((metric) => metric.id)).toEqual([
      "traffic-in",
      "errors",
      "optical-rx",
    ]);
  });

  it("calculates capacity and stale data", () => {
    const series = {
      key: "traffic-in",
      metric_id: "traffic-in",
      name: "Interface | Load | In",
      target: "noc::interface::Gi0/1",
      unit: {code: "bit/s", label: "bps"},
      points: [[1_000, 800_000_000]] as [number, number][],
    };
    expect(capacityForSeries(series, entity)).toBe(1_000_000_000);
    expect(capacityForSeries({...series, name: "Interface | Errors | In"}, entity)).toBe(0);
    expect(seriesIsStale(series, 60, 400_000)).toBe(true);
  });
});

describe("dashboard summary", () => {
  const trafficIn = {
    id: "traffic-in",
    name: "Interface | Load | In",
    description: "",
    scope: "Interface",
    category: "traffic" as const,
    direction: "in" as const,
    unit: {code: "bit/s", label: "bps"},
    color: null,
    is_delta: false,
    interval: 60,
    filter_fields: ["interface"],
  };
  const trafficOut = {...trafficIn, id: "traffic-out", name: "Interface | Load | Out", direction: "out" as const};
  const optical = {...trafficIn, id: "optical", name: "Interface | DOM | RxPower", category: "optical" as const};
  const summaryEntity: SummaryEntity = {
    id: "if-1",
    label: "Gi0/1",
    description: "Uplink",
    status: "Up/10G/Full",
    admin_status: true,
    oper_status: true,
    capacity: {in_bps: 10_000_000_000, out_bps: 10_000_000_000},
    capabilities: ["traffic"],
    metric_ids: ["traffic-in", "traffic-out"],
    metric_thresholds: {},
    values: {
      "traffic-in": {current: 7_000_000_000, average: 5, peak: 9, p95: 8_000_000_000, latest_ts: 1},
      "traffic-out": {current: 2_000_000_000, average: 2, peak: 4, p95: 3_000_000_000, latest_ts: 1},
    },
  };

  it("prioritizes operational summary metrics", () => {
    const metricGroup = {
      ...group,
      metrics: [optical, trafficOut, trafficIn],
      entities: [{...entity, metric_ids: ["traffic-in", "traffic-out", "optical"]}],
    };
    expect(summaryMetrics(metricGroup).map((metric) => metric.id)).toEqual([
      "traffic-in",
      "traffic-out",
      "optical",
    ]);
  });

  it("calculates and ranks by p95 utilization", () => {
    const quiet = {
      ...summaryEntity,
      id: "if-2",
      label: "Gi0/2",
      values: {
        ...summaryEntity.values,
        "traffic-in": {...summaryEntity.values["traffic-in"]!, p95: 1_000_000_000},
      },
    };
    expect(utilizationFor(summaryEntity, trafficIn, "p95")).toBe(80);
    expect(rankInterfaces([quiet, summaryEntity], [trafficIn, trafficOut]).map((item) => item.id)).toEqual([
      "if-1",
      "if-2",
    ]);
  });

  it("excludes disabled interfaces from capacity pressure", () => {
    const disabled = {
      ...summaryEntity,
      id: "if-disabled",
      admin_status: false,
      values: {
        ...summaryEntity.values,
        "traffic-in": {...summaryEntity.values["traffic-in"]!, p95: 10_000_000_000},
      },
    };

    expect(rankInterfaces([disabled, summaryEntity], [trafficIn, trafficOut])).toEqual([
      summaryEntity,
    ]);
  });
});
