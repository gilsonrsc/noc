import type {
  DashboardEntity,
  DashboardGroup,
  MetricCategory,
  MetricDescriptor,
  TimeSeries,
} from "./types";
import {__} from "./i18n";

export type MetricView = "all" | MetricCategory;
export type MonitorState = "normal" | "warning" | "critical" | "stale" | "no-data";

export function metricView(metric: Pick<MetricDescriptor, "category">): MetricCategory {
  return metric.category;
}

export function metricsForEntity(
  group: Pick<DashboardGroup, "metrics">,
  entity: Pick<DashboardEntity, "metric_ids">,
): MetricDescriptor[] {
  const allowed = new Set(entity.metric_ids);
  return group.metrics.filter((metric) => allowed.has(metric.id));
}

export function metricsForView(metrics: MetricDescriptor[], view: MetricView): string[] {
  if (view === "all") return metrics.map((metric) => metric.id);
  const matching = metrics.filter((metric) => metricView(metric) === view);
  if (view === "optical") {
    const powerMetrics = matching.filter(
      (metric) => metric.name.endsWith(" | RxPower") || metric.name.endsWith(" | TxPower"),
    );
    if (powerMetrics.length) return powerMetrics.map((metric) => metric.id);
  }
  return matching.map((metric) => metric.id);
}

export function defaultMetricView(metrics: MetricDescriptor[]): MetricView {
  if (metrics.some((metric) => metricView(metric) === "optical")) return "optical";
  if (metrics.some((metric) => metricView(metric) === "traffic")) return "traffic";
  if (metrics.some((metric) => metricView(metric) === "health")) return "health";
  return metrics[0]?.category ?? "other";
}

export function metricViewLabel(view: MetricView): string {
  const labels: Record<MetricView, string> = {
    all: __("All signals"),
    traffic: __("Traffic"),
    errors: __("Errors"),
    health: __("Health"),
    environment: __("Environment"),
    optical: __("Optical"),
    radio: __("Radio"),
    access: __("Access"),
    sla: "SLA",
    subscribers: __("Subscribers"),
    storage: __("Storage"),
    routing: __("Routing"),
    other: __("Other"),
  };
  return labels[view];
}

export function capacityForSeries(series: TimeSeries, entity: DashboardEntity): number {
  if (!series.name.includes("Interface | Load |")) return 0;
  if (series.name.endsWith(" | In")) return entity.capacity.in_bps;
  if (series.name.endsWith(" | Out")) return entity.capacity.out_bps;
  return 0;
}

export function seriesIsStale(
  series: TimeSeries,
  intervalSeconds: number | null,
  now: number,
): boolean {
  const latest = series.points[series.points.length - 1]?.[0];
  if (!latest) return false;
  const tolerance = Math.max((intervalSeconds ?? 60) * 2_500, 180_000);
  return now - latest > tolerance;
}
