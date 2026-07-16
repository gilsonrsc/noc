import type {EChartsCoreOption} from "echarts/core";
import type {TimeSeries} from "./types";

export const SERIES_PALETTE = [
  "#5b8def",
  "#45b58b",
  "#9b8afb",
  "#d7a84b",
  "#e56b76",
  "#7f9fc7",
];

export function compactMetricName(name: string): string {
  const parts = name.split(" | ").filter(Boolean);
  if (parts[0] === "Interface" && parts[1] === "DOM") {
    const opticalLabels: Record<string, string> = {
      "Bias Current": "Laser bias",
      RxPower: "Optical Rx",
      Temperature: "Module temperature",
      TxPower: "Optical Tx",
      Voltage: "Supply voltage",
    };
    return opticalLabels[parts.slice(2).join(" ")] ?? `Optical ${parts.slice(2).join(" ")}`;
  }
  if (parts[0] === "Interface" && parts[1] === "Load") {
    return ["Traffic", ...parts.slice(2)].join(" ");
  }
  if (parts[0] === "Interface") return parts.slice(1).join(" ");
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
      textStyle: {color: "#a7b0bc", fontSize: 11},
      pageTextStyle: {color: "#667180"},
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(15, 20, 28, 0.98)",
      borderColor: "#374151",
      borderWidth: 1,
      textStyle: {color: "#e8ecf2", fontSize: 11},
      axisPointer: {type: "cross", lineStyle: {color: "#667180", type: "dashed"}},
    },
    toolbox: {
      right: 12,
      top: 8,
      iconStyle: {borderColor: "#87919f"},
      feature: {dataZoom: {}, restore: {}, saveAsImage: {name: "noc-performance"}},
    },
    dataZoom: [
      {type: "inside", filterMode: "none"},
      {
        type: "slider",
        height: 18,
        bottom: 8,
        borderColor: "#252d39",
        backgroundColor: "#0f141c",
        fillerColor: "rgba(91, 141, 239, 0.12)",
        dataBackground: {lineStyle: {color: "#667180"}, areaStyle: {color: "#252d39"}},
        textStyle: {color: "#87919f", fontSize: 9},
      },
    ],
    xAxis: {
      type: "time",
      min: from,
      max: to,
      boundaryGap: false,
      axisLine: {lineStyle: {color: "#374151"}},
      axisTick: {lineStyle: {color: "#374151"}},
      axisLabel: {color: "#87919f", hideOverlap: true, fontSize: 10},
      splitLine: {show: true, lineStyle: {color: "#202733"}},
    },
    yAxis: units.map((unit, index) => ({
      type: "value",
      name: unit,
      position: index === 0 ? "left" : "right",
      offset: index > 1 ? (index - 1) * 52 : 0,
      nameTextStyle: {color: "#87919f", fontSize: 10},
      axisLabel: {
        color: "#87919f",
        fontSize: 10,
        formatter: (value: number) => formatMetricValue(value, unit),
      },
      axisLine: {show: index > 0, lineStyle: {color: "#374151"}},
      splitLine: {
        show: index === 0,
        lineStyle: {color: "#202733"},
      },
      scale: true,
    })),
    series: series.map((item, index) => ({
      id: item.key,
      name: seriesDisplayName(item, series),
      type: "line",
      yAxisIndex: Math.max(0, units.indexOf(item.unit.label || item.unit.code)),
      data: item.points,
      showSymbol: false,
      smooth: false,
      connectNulls: false,
      lineStyle: {width: 2},
      areaStyle: index === 0 ? {opacity: 0.025} : undefined,
      emphasis: {focus: "series"},
      tooltip: {
        valueFormatter: (value: number) =>
          formatMetricValueWithUnit(value, item.unit.label || item.unit.code),
      },
    })),
  };
}
