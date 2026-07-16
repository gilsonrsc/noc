import type {EChartsCoreOption} from "echarts/core";
import {__} from "./i18n";
import {metricForDirection, rankInterfaces, utilizationFor} from "./summary";
import type {MetricDescriptor, SummaryEntity, TimeSeries} from "./types";

export const SERIES_PALETTE = [
  "#67b7dc",
  "#64c7a1",
  "#9d8dd1",
  "#d5a75c",
  "#d66b72",
  "#8daac7",
];

export function compactMetricName(name: string): string {
  const parts = name.split(" | ").filter(Boolean);
  if (parts[0] === "Interface" && parts[1] === "DOM") {
    const opticalLabels: Record<string, string> = {
      "Bias Current": __("Laser bias"),
      RxPower: __("Optical Rx"),
      Temperature: __("Module temperature"),
      TxPower: __("Optical Tx"),
      Voltage: __("Supply voltage"),
    };
    return opticalLabels[parts.slice(2).join(" ")] ?? `${__("Optical")} ${parts.slice(2).join(" ")}`;
  }
  if (parts[0] === "Interface" && parts[1] === "Load") {
    return [
      __("Traffic"),
      ...parts.slice(2).map((part) => (part === "In" ? __("In") : part === "Out" ? __("Out") : part)),
    ].join(" ");
  }
  if (parts[0] === "Interface") {
    return parts
      .slice(1)
      .map((part) => {
        if (part === "Errors") return __("Errors");
        if (part === "In") return __("In");
        if (part === "Out") return __("Out");
        return part;
      })
      .join(" ");
  }
  return parts.join(" ");
}

export function compactSeriesTarget(target: string): string {
  const labels = target.split("/").filter(Boolean);
  const label = labels[labels.length - 1] ?? target;
  const parts = label.split("::").filter(Boolean);
  return parts[parts.length - 1] ?? label;
}

export function seriesDisplayName(item: TimeSeries, series: TimeSeries[]): string {
  const base = compactMetricName(item.name);
  const duplicateCount = series.filter((candidate) => compactMetricName(candidate.name) === base).length;
  if (duplicateCount < 2 || !item.target) return base;
  return `${base} · ${compactSeriesTarget(item.target)}`;
}

function isMirroredTraffic(item: TimeSeries): boolean {
  return (
    (item.unit.label === "bps" || item.unit.code === "bit/s") &&
    item.name.includes("Interface | Load | Out")
  );
}

export function formatMetricValue(value: number, unit: string): string {
  if (unit === "bps" || unit === "bit/s") {
    const absolute = Math.abs(value);
    if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} G`;
    if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} M`;
    if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)} k`;
  }
  return value.toLocaleString(undefined, {maximumFractionDigits: 2});
}

export function formatMetricValueWithUnit(value: number, unit: string): string {
  const formatted = formatMetricValue(value, unit);
  if (unit === "bps" || unit === "bit/s") return `${formatted}bps`;
  if (unit === "percent" || unit === "%") return `${formatted} %`;
  return unit && unit !== "1" ? `${formatted} ${unit}` : formatted;
}

export function buildChartOption(series: TimeSeries[], from: number, to: number): EChartsCoreOption {
  const units = [...new Set(series.map((item) => item.unit.label || item.unit.code))];
  const mirroredUnits = new Set(
    series
      .filter((item) => isMirroredTraffic(item))
      .map((item) => item.unit.label || item.unit.code),
  );
  return {
    animationDuration: 180,
    color: SERIES_PALETTE,
    grid: {
      left: 12,
      right: Math.max(30, (units.length - 1) * 52),
      top: 54,
      bottom: 52,
      containLabel: true,
    },
    legend: {
      top: 8,
      type: "scroll",
      textStyle: {color: "#aeb9c6", fontSize: 10},
      pageTextStyle: {color: "#687484"},
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(17, 22, 29, 0.98)",
      borderColor: "#384556",
      borderWidth: 1,
      textStyle: {color: "#e8edf4", fontSize: 10},
      axisPointer: {type: "cross", lineStyle: {color: "#687484", type: "dashed"}},
    },
    toolbox: {
      right: 12,
      top: 8,
      iconStyle: {borderColor: "#929eac"},
      feature: {
        dataZoom: {title: {zoom: __("Area zoom"), back: __("Restore area zoom")}},
        restore: {title: __("Restore")},
        saveAsImage: {name: "noc-performance", title: __("Save as image")},
      },
    },
    dataZoom: [
      {type: "inside", filterMode: "none"},
      {
        type: "slider",
        height: 18,
        bottom: 8,
        borderColor: "#27303c",
        backgroundColor: "#11161d",
        fillerColor: "rgba(107, 152, 207, 0.15)",
        dataBackground: {lineStyle: {color: "#687484"}, areaStyle: {color: "#27303c"}},
        textStyle: {color: "#929eac", fontSize: 9},
      },
    ],
    xAxis: {
      type: "time",
      min: from,
      max: to,
      boundaryGap: false,
      axisLine: {lineStyle: {color: "#384556"}},
      axisTick: {lineStyle: {color: "#384556"}},
      axisLabel: {color: "#929eac", hideOverlap: true, fontSize: 10},
      splitLine: {show: true, lineStyle: {color: "#222b36"}},
    },
    yAxis: units.map((unit, index) => ({
      type: "value",
      name: unit,
      position: index === 0 ? "left" : "right",
      offset: index > 1 ? (index - 1) * 52 : 0,
      nameTextStyle: {color: "#929eac", fontSize: 10},
      axisLabel: {
        color: "#929eac",
        fontSize: 10,
        formatter: (value: number) =>
          formatMetricValue(mirroredUnits.has(unit) ? Math.abs(value) : value, unit),
      },
      axisLine: {show: index > 0, lineStyle: {color: "#384556"}},
      splitLine: {
        show: index === 0,
        lineStyle: {color: "#222b36"},
      },
      scale: true,
    })),
    series: series.map((item, index) => ({
      id: item.key,
      name: seriesDisplayName(item, series),
      type: "line",
      yAxisIndex: Math.max(0, units.indexOf(item.unit.label || item.unit.code)),
      data: isMirroredTraffic(item)
        ? item.points.map(([timestamp, value]) => [timestamp, -Math.abs(value)])
        : item.points,
      showSymbol: false,
      smooth: false,
      connectNulls: false,
      lineStyle: {width: 2},
      areaStyle:
        item.name.includes("Interface | Load |") || index === 0 ? {opacity: 0.1} : undefined,
      emphasis: {focus: "series"},
      tooltip: {
        valueFormatter: (value: number) =>
          formatMetricValueWithUnit(
            isMirroredTraffic(item) ? Math.abs(value) : value,
            item.unit.label || item.unit.code,
          ),
      },
    })),
  };
}

export function buildInterfaceRankingOption(
  entities: SummaryEntity[],
  metrics: MetricDescriptor[],
): EChartsCoreOption {
  const ranked = rankInterfaces(entities, metrics, 10);
  const inbound = metricForDirection(metrics, "traffic", "in");
  const outbound = metricForDirection(metrics, "traffic", "out");
  return {
    animationDuration: 220,
    color: [SERIES_PALETTE[0] ?? "#67b7dc", SERIES_PALETTE[1] ?? "#64c7a1"],
    grid: {left: 12, right: 26, top: 34, bottom: 12, containLabel: true},
    legend: {
      top: 0,
      right: 0,
      itemWidth: 14,
      itemHeight: 3,
      textStyle: {color: "#929eac", fontSize: 10},
    },
    tooltip: {
      trigger: "axis",
      axisPointer: {type: "shadow"},
      backgroundColor: "rgba(17, 22, 29, 0.98)",
      borderColor: "#384556",
      textStyle: {color: "#e8edf4", fontSize: 10},
      valueFormatter: (value: number) => `${Number(value).toFixed(1)}%`,
    },
    xAxis: {
      type: "value",
      min: 0,
      max: 100,
      axisLabel: {color: "#687484", fontSize: 9, formatter: "{value}%"},
      axisLine: {show: false},
      axisTick: {show: false},
      splitLine: {lineStyle: {color: "#222b36"}},
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: ranked.map((entity) => entity.label),
      axisLabel: {color: "#c6d0dc", fontSize: 10, width: 150, overflow: "truncate"},
      axisLine: {show: false},
      axisTick: {show: false},
    },
    series: [
      {
        name: __("Inbound P95"),
        type: "bar",
        barMaxWidth: 9,
        data: ranked.map((entity) => utilizationFor(entity, inbound, "p95") ?? 0),
        itemStyle: {borderRadius: [0, 3, 3, 0]},
      },
      {
        name: __("Outbound P95"),
        type: "bar",
        barMaxWidth: 9,
        data: ranked.map((entity) => utilizationFor(entity, outbound, "p95") ?? 0),
        itemStyle: {borderRadius: [0, 3, 3, 0]},
      },
    ],
  };
}
