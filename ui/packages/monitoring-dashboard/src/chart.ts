import type {EChartsCoreOption} from "echarts/core";
import type {TimeSeries} from "./types";

export const SERIES_PALETTE = [
  "#20b8d8",
  "#30c48d",
  "#e5a72a",
  "#ef5d6f",
  "#8f7bd8",
  "#5c96d6",
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
  return value.toLocaleString();
}

export function formatMetricValueWithUnit(value: number, unit: string): string {
  const formatted = formatMetricValue(value, unit);
  if (unit === "bps" || unit === "bit/s") return `${formatted}bps`;
  if (unit === "percent") return `${formatted} %`;
  return unit && unit !== "1" ? `${formatted} ${unit}` : formatted;
}

export function buildChartOption(series: TimeSeries[], from: number, to: number): EChartsCoreOption {
  const units = [...new Set(series.map((item) => item.unit.label || item.unit.code))];
  return {
    animationDuration: 220,
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
      textStyle: {color: "#9aa8b7", fontSize: 10, fontFamily: "monospace"},
      pageTextStyle: {color: "#657483"},
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(8, 13, 20, 0.97)",
      borderColor: "#344657",
      borderWidth: 1,
      textStyle: {color: "#d7dee8", fontSize: 10, fontFamily: "monospace"},
      axisPointer: {type: "cross", lineStyle: {color: "#536170", type: "dashed"}},
    },
    toolbox: {
      right: 12,
      top: 8,
      iconStyle: {borderColor: "#7f8d9d"},
      feature: {dataZoom: {}, restore: {}, saveAsImage: {name: "noc-performance"}},
    },
    dataZoom: [
      {type: "inside", filterMode: "none"},
      {
        type: "slider",
        height: 18,
        bottom: 8,
        borderColor: "#22303e",
        backgroundColor: "#0a1119",
        fillerColor: "rgba(32, 184, 216, 0.13)",
        dataBackground: {lineStyle: {color: "#536170"}, areaStyle: {color: "#22303e"}},
        textStyle: {color: "#7f8d9d", fontSize: 9, fontFamily: "monospace"},
      },
    ],
    xAxis: {
      type: "time",
      min: from,
      max: to,
      boundaryGap: false,
      axisLine: {lineStyle: {color: "#344657"}},
      axisTick: {lineStyle: {color: "#344657"}},
      axisLabel: {color: "#7f8d9d", hideOverlap: true, fontSize: 9, fontFamily: "monospace"},
      splitLine: {show: true, lineStyle: {color: "#18232e"}},
    },
    yAxis: units.map((unit, index) => ({
      type: "value",
      name: unit,
      position: index === 0 ? "left" : "right",
      offset: index > 1 ? (index - 1) * 52 : 0,
      nameTextStyle: {color: "#7f8d9d", fontSize: 9, fontFamily: "monospace"},
      axisLabel: {
        color: "#7f8d9d",
        fontSize: 9,
        fontFamily: "monospace",
        formatter: (value: number) => formatMetricValue(value, unit),
      },
      axisLine: {show: index > 0, lineStyle: {color: "#344657"}},
      splitLine: {
        show: index === 0,
        lineStyle: {color: "#18232e"},
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
      lineStyle: {width: 1.6},
      areaStyle: index === 0 ? {opacity: 0.035} : undefined,
      emphasis: {focus: "series"},
      tooltip: {
        valueFormatter: (value: number) =>
          formatMetricValueWithUnit(value, item.unit.label || item.unit.code),
      },
    })),
  };
}
