import {formatMetricValueWithUnit} from "./chart";
import {__} from "./i18n";
import type {MetricView} from "./state";
import type {
  DashboardManifest,
  MetricCategory,
  MetricDescriptor,
  MetricThresholdDescriptor,
  SummaryEntity,
} from "./types";

export const RANGE_OPTIONS = [
  {label: "1h", value: 60 * 60 * 1000},
  {label: "6h", value: 6 * 60 * 60 * 1000},
  {label: "24h", value: 24 * 60 * 60 * 1000},
  {label: "7d", value: 7 * 24 * 60 * 60 * 1000},
] as const;

export const REFRESH_OPTIONS = [
  {label: "Off", value: 0},
  {label: "30s", value: 30_000},
  {label: "60s", value: 60_000},
  {label: "5m", value: 300_000},
] as const;

export function viewContent(): Record<
  MetricView,
  {eyebrow: string; title: string; description: string}
> {
  return {
    all: {
      eyebrow: __("Selected signals"),
      title: __("Combined history"),
      description: __("Compare the selected measurements over the same period."),
    },
    traffic: {
      eyebrow: __("Interface throughput"),
      title: __("Traffic"),
      description: __("Inbound and outbound load, compared with the interface capacity."),
    },
    errors: {
      eyebrow: __("Packet integrity"),
      title: __("Errors and discards"),
      description: __("Interface errors, drops and discards recorded during the selected period."),
    },
    health: {
      eyebrow: __("Device resources"),
      title: __("Health"),
      description: __("Resource usage, reachability and operating measurements for this device."),
    },
    environment: {
      eyebrow: __("Environmental telemetry"),
      title: __("Environment"),
      description: __("Temperature, power and environmental measurements reported by the device."),
    },
    optical: {
      eyebrow: __("Transceiver diagnostics"),
      title: __("Optical levels"),
      description: __("Receive and transmit power with the supporting transceiver diagnostics."),
    },
    radio: {
      eyebrow: __("Radio telemetry"),
      title: __("Radio"),
      description: __("Signal, noise, power and radio link measurements."),
    },
    access: {
      eyebrow: __("Access telemetry"),
      title: __("Access"),
      description: __("Subscriber access and physical line measurements."),
    },
    sla: {
      eyebrow: __("Service assurance"),
      title: __("Service level"),
      description: __("Latency, jitter, loss and service-level measurements."),
    },
    subscribers: {
      eyebrow: __("Subscriber sessions"),
      title: __("Subscribers"),
      description: __("Session counts and subscriber service measurements."),
    },
    storage: {
      eyebrow: __("Storage resources"),
      title: __("Storage"),
      description: __("Filesystem, disk and storage utilization measurements."),
    },
    routing: {
      eyebrow: __("Control plane"),
      title: __("Routing"),
      description: __("Routing, neighbor and control-plane measurements."),
    },
    other: {
      eyebrow: __("Additional telemetry"),
      title: __("Other signals"),
      description: __("Measurements available for this source that do not belong to another view."),
    },
  };
}

export function objectMeta(manifest: DashboardManifest): string[] {
  const details = [
    manifest.object.address,
    manifest.object.vendor,
    manifest.object.platform,
    manifest.object.version,
    manifest.object.pool,
  ];
  return details.filter((value): value is string => Boolean(value));
}

export function formatCapacity(value: number): string {
  if (!value) return __("Not reported");
  if (value >= 1_000_000_000) return `${value / 1_000_000_000} Gbps`;
  if (value >= 1_000_000) return `${value / 1_000_000} Mbps`;
  if (value >= 1_000) return `${value / 1_000} kbps`;
  return `${value} bps`;
}

export function formatThresholds(
  thresholds: MetricThresholdDescriptor[],
  unit: string,
): string {
  return thresholds
    .map((threshold) => `${threshold.op} ${formatMetricValueWithUnit(threshold.value, unit)}`)
    .join(" · ");
}

export function metricDomainClass(category: MetricCategory | undefined): string {
  return category ? `domain-${category}` : "domain-other";
}

export function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

export function formatPercentage(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

export function summaryMetricValue(
  entity: SummaryEntity,
  metric: MetricDescriptor | undefined,
  reduction: "current" | "p95" = "current",
): string {
  if (!metric) return "—";
  const value = entity.values[metric.id]?.[reduction];
  if (value === undefined) return "—";
  return formatMetricValueWithUnit(value, metric.unit.label || metric.unit.code);
}

export function thresholdMatches(
  value: number,
  threshold: MetricThresholdDescriptor,
): boolean {
  if (threshold.op === "<") return value < threshold.value;
  if (threshold.op === "<=") return value <= threshold.value;
  if (threshold.op === ">") return value > threshold.value;
  return value >= threshold.value;
}
