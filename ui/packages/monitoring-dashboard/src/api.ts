import type {
  DashboardEntity,
  DashboardGroup,
  DashboardManifest,
  DashboardSummary,
  MetricQuery,
  QueryResponse,
} from "./types";

const INTERVALS = [10, 30, 60, 300, 900, 3600, 21600, 86400] as const;

export function intervalForRange(rangeMs: number): number {
  const target = Math.max(10, Math.ceil(rangeMs / 1000 / 360));
  return INTERVALS.find((interval) => interval >= target) ?? 86400;
}

export function buildMetricQuery(
  objectId: string,
  group: DashboardGroup,
  entity: DashboardEntity,
  metricIds: string[],
  from: number,
  to: number,
): MetricQuery {
  return {
    object_id: objectId,
    from,
    to,
    interval: intervalForRange(to - from),
    series: metricIds.map((metricId) => ({
      group_id: group.id,
      entity_id: entity.id,
      metric_id: metricId,
    })),
  };
}

export async function readJson<T>(response: Response): Promise<T> {
  const body = await response.text();
  if (!body.trim()) {
    if (response.status === 401 || response.status === 403 || response.redirected) {
      throw new Error("Your NOC session is unavailable. Sign in again and retry.");
    }
    throw new Error(`The server returned an empty response (${response.status}).`);
  }

  let data: T & {error?: string};
  try {
    data = JSON.parse(body) as T & {error?: string};
  } catch {
    const contentType = response.headers.get("content-type") ?? "";
    if (response.redirected || contentType.includes("text/html")) {
      throw new Error("Your NOC session is unavailable. Sign in again and retry.");
    }
    throw new Error(`The server returned an invalid response (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(data.error ?? `Request failed with status ${response.status}`);
  }
  return data;
}

export async function loadManifest(objectId: string): Promise<DashboardManifest> {
  const params = new URLSearchParams({dashboard: "mo", id: objectId});
  const response = await fetch(`/pm/ddash/manifest/?${params}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: {Accept: "application/json"},
  });
  return readJson<DashboardManifest>(response);
}

export async function loadSeries(url: string, query: MetricQuery): Promise<QueryResponse> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify(query),
  });
  return readJson<QueryResponse>(response);
}

export async function loadSummary(
  url: string,
  objectId: string,
  groupId: string,
  metricIds: string[],
  from: number,
  to: number,
): Promise<DashboardSummary> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify({
      object_id: objectId,
      group_id: groupId,
      metric_ids: metricIds,
      from,
      to,
    }),
  });
  return readJson<DashboardSummary>(response);
}
