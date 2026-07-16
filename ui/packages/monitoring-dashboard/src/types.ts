export interface UnitDescriptor {
  code: string;
  label: string;
}

export type MetricCategory =
  | "traffic"
  | "errors"
  | "health"
  | "environment"
  | "optical"
  | "radio"
  | "access"
  | "sla"
  | "subscribers"
  | "storage"
  | "routing"
  | "other";

export interface MetricDescriptor {
  id: string;
  name: string;
  description: string;
  scope: string;
  category: MetricCategory;
  direction: "in" | "out" | null;
  unit: UnitDescriptor;
  color: string | null;
  is_delta: boolean;
  interval: number | null;
  filter_fields: string[];
}

export interface MetricThresholdDescriptor {
  op: "<" | "<=" | ">=" | ">";
  value: number;
  clear_value: number | null;
  alarm_class: string | null;
  alarm_labels: string[];
  severity: string | null;
  rule_id: string;
  rule_name: string;
}

export interface DashboardEntity {
  id: string;
  label: string;
  description: string;
  status: string;
  admin_status: boolean | null;
  oper_status: boolean | null;
  full_duplex: boolean | null;
  capacity: {
    in_bps: number;
    out_bps: number;
  };
  filters: Record<string, string | number | boolean>;
  metric_ids: string[];
  metric_intervals: Record<string, number>;
  metric_thresholds: Record<string, MetricThresholdDescriptor[]>;
  capabilities: MetricCategory[];
}

export interface DashboardGroup {
  id: string;
  title: string;
  kind: string;
  module_id: string;
  metrics: MetricDescriptor[];
  entities: DashboardEntity[];
}

export interface DashboardModule {
  id: string;
  title: string;
  kind: string;
  group_ids: string[];
  capabilities: MetricCategory[];
}

export interface DashboardManifest {
  api_version: string;
  dashboard: string;
  object: {
    id: string;
    bi_id: string;
    name: string;
    address: string;
    description: string;
    platform: string | null;
    version: string | null;
    vendor: string | null;
    segment: string | null;
    pool: string | null;
  };
  groups: DashboardGroup[];
  modules: DashboardModule[];
  capabilities: MetricCategory[];
  query: {url: string; method: "POST"};
  legacy_url: string;
}

export interface SeriesRequest {
  group_id: string;
  entity_id: string;
  metric_id: string;
}

export interface MetricQuery {
  object_id: string;
  from: number;
  to: number;
  interval: number;
  series: SeriesRequest[];
}

export interface TimeSeries {
  key: string;
  metric_id: string;
  name: string;
  target: string;
  unit: UnitDescriptor;
  points: [number, number][];
}

export interface QueryResponse {
  api_version: string;
  from: number;
  to: number;
  interval: number;
  series: TimeSeries[];
}
