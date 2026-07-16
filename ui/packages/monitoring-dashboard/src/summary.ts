import type {
  DashboardGroup,
  MetricDescriptor,
  MetricDirection,
  SummaryEntity,
} from "./types";

const SUMMARY_CATEGORY_ORDER = ["traffic", "errors", "optical", "health"] as const;

export function summaryMetrics(group: DashboardGroup, limit = 8): MetricDescriptor[] {
  return [...group.metrics]
    .filter((metric) => group.entities.some((entity) => entity.metric_ids.includes(metric.id)))
    .sort((left, right) => {
      const leftCategory = SUMMARY_CATEGORY_ORDER.indexOf(
        left.category as (typeof SUMMARY_CATEGORY_ORDER)[number],
      );
      const rightCategory = SUMMARY_CATEGORY_ORDER.indexOf(
        right.category as (typeof SUMMARY_CATEGORY_ORDER)[number],
      );
      const normalizedLeft = leftCategory < 0 ? SUMMARY_CATEGORY_ORDER.length : leftCategory;
      const normalizedRight = rightCategory < 0 ? SUMMARY_CATEGORY_ORDER.length : rightCategory;
      return normalizedLeft - normalizedRight || left.name.localeCompare(right.name);
    })
    .slice(0, limit);
}

export function metricForDirection(
  metrics: MetricDescriptor[],
  category: MetricDescriptor["category"],
  direction: MetricDirection,
): MetricDescriptor | undefined {
  return metrics.find(
    (metric) => metric.category === category && metric.direction === direction,
  );
}

export function utilizationFor(
  entity: SummaryEntity,
  metric: MetricDescriptor | undefined,
  reduction: "current" | "average" | "peak" | "p95" = "current",
): number | null {
  if (!metric) return null;
  const value = entity.values[metric.id]?.[reduction];
  const capacity = metric.direction === "out" ? entity.capacity.out_bps : entity.capacity.in_bps;
  if (value === undefined || !capacity) return null;
  return Math.max(0, (value / capacity) * 100);
}

export function rankInterfaces(
  entities: SummaryEntity[],
  metrics: MetricDescriptor[],
  limit = 10,
): SummaryEntity[] {
  const inbound = metricForDirection(metrics, "traffic", "in");
  const outbound = metricForDirection(metrics, "traffic", "out");
  return [...entities]
    .filter((entity) => entity.admin_status !== false && entity.oper_status !== false)
    .sort((left, right) => {
      const leftValue = Math.max(
        utilizationFor(left, inbound, "p95") ?? 0,
        utilizationFor(left, outbound, "p95") ?? 0,
      );
      const rightValue = Math.max(
        utilizationFor(right, inbound, "p95") ?? 0,
        utilizationFor(right, outbound, "p95") ?? 0,
      );
      return rightValue - leftValue || left.label.localeCompare(right.label);
    })
    .slice(0, limit);
}
