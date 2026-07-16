# ---------------------------------------------------------------------
# Native performance dashboard helpers
# ---------------------------------------------------------------------
# Copyright (C) 2007-2026 The NOC Project
# See LICENSE for details
# ---------------------------------------------------------------------

# Python modules
import datetime
import math
import re
from collections import defaultdict
from typing import Any

# NOC modules
from noc.config import config
from noc.core.clickhouse.connect import connection
from noc.core.clickhouse.error import ClickhouseError
from noc.inv.models.interface import Interface
from noc.pm.models.metricrule import MetricRule
from noc.pm.models.metrictype import MetricType
from noc.sa.models.managedobject import ManagedObject


API_VERSION = "1.3"
MAX_QUERY_RANGE_MS = 31 * 24 * 60 * 60 * 1000
MAX_QUERY_SERIES = 20
MAX_QUERY_POINTS = 100_000
MAX_SUMMARY_METRICS = 8
MAX_SUMMARY_ENTITIES = 5_000
MIN_INTERVAL_SECONDS = 10
MAX_INTERVAL_SECONDS = 24 * 60 * 60
RX_IDENTIFIER = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
INTERFACE_STATE_METRICS = {
    "Interface | Speed",
    "Interface | Status | Oper",
    "Interface | Status | Admin",
}
METRIC_CATEGORY_ORDER = {
    "traffic": 10,
    "errors": 20,
    "health": 30,
    "environment": 40,
    "optical": 50,
    "radio": 60,
    "access": 70,
    "sla": 80,
    "subscribers": 90,
    "storage": 100,
    "routing": 110,
    "other": 999,
}


class NativeDashboardError(ValueError):
    """Raised when a native dashboard request is invalid."""


def get_metric_category(metric: MetricType) -> str:
    """Return a vendor-neutral dashboard capability for a metric."""
    name = metric.name.lower()
    scope = metric.scope.name.lower()
    if scope == "sla" or name.startswith("sla |"):
        return "sla"
    if scope == "subscriber" or name.startswith("subscribers |"):
        return "subscribers"
    if scope in {"disk", "filesystem"}:
        return "storage"
    if scope in {"routing", "neighbors", "vpn", "multicast"}:
        return "routing"
    if name.startswith("radio |"):
        return "radio"
    if "xdsl" in name or "gpon" in name or "epon" in name or "pon |" in name:
        return "access"
    if any(token in name for token in ("optical", "transceiver", "dom |", "laser")):
        return "optical"
    if scope in {"environment", "sensor"} or any(
        token in name for token in ("temperature", "voltage", "power", "fan")
    ):
        return "environment"
    if any(token in name for token in ("error", "discard", "drop", "loss")):
        return "errors"
    if name.startswith("interface | load |") or name.startswith("interface | octets |"):
        return "traffic"
    if scope in {"cpu", "memory", "object", "ping", "check"}:
        return "health"
    return "other"


def get_metric_direction(metric: MetricType) -> str | None:
    """Return normalized metric direction when it is encoded in the name."""
    parts = {part.strip().lower() for part in metric.name.split("|")}
    if "in" in parts or "input" in parts or "rx" in parts:
        return "in"
    if "out" in parts or "output" in parts or "tx" in parts:
        return "out"
    return None


def metric_to_dict(metric: MetricType, interval: int | None = None) -> dict[str, Any]:
    """Serialize MetricType to the public dashboard contract."""
    units = metric.units
    color = units.dashboard_sr_color if units else None
    category = get_metric_category(metric)
    unit_label = metric.measure or ""
    if units:
        scale = getattr(metric, "scale", None)
        if category != "optical" and not (unit_label and scale and scale.exp):
            unit_label = units.dashboard_label or unit_label or units.label or units.code
    return {
        "id": str(metric.id),
        "name": metric.name,
        "description": metric.description or "",
        "scope": metric.scope.name,
        "category": category,
        "direction": get_metric_direction(metric),
        "unit": {
            "code": units.code if units else "1",
            "label": unit_label,
        },
        "color": f"#{color:06x}" if color else None,
        "is_delta": bool(metric.is_delta),
        "interval": interval,
        "filter_fields": sorted(get_allowed_filter_fields(metric) - {"managed_object"}),
    }


def get_allowed_filter_fields(metric: MetricType) -> set[str]:
    """Return semantic filter fields exposed by a metric scope."""
    scope = metric.scope
    fields = {field.field_name for field in scope.key_fields}
    for label in scope.labels:
        field = label.store_column or label.view_column
        if field:
            fields.add(field)
    return fields


def parse_time_range(data: dict[str, Any]) -> tuple[datetime.datetime, datetime.datetime, int]:
    """Validate and normalize the requested time range."""
    try:
        start_ms = int(data["from"])
        end_ms = int(data["to"])
        interval = int(data.get("interval", 60))
    except (KeyError, TypeError, ValueError) as e:
        raise NativeDashboardError("Invalid time range") from e
    if start_ms >= end_ms:
        raise NativeDashboardError("The start time must be before the end time")
    if end_ms - start_ms > MAX_QUERY_RANGE_MS:
        raise NativeDashboardError("The requested time range is too large")
    if not MIN_INTERVAL_SECONDS <= interval <= MAX_INTERVAL_SECONDS:
        raise NativeDashboardError("Invalid aggregation interval")
    try:
        start = datetime.datetime.fromtimestamp(start_ms / 1000)
        end = datetime.datetime.fromtimestamp(end_ms / 1000)
    except (OverflowError, OSError, ValueError) as e:
        raise NativeDashboardError("Invalid time range") from e
    return start, end, interval


def _get_metric_configs(profile: Any, fallback_interval: int = 0) -> list[tuple[MetricType, int]]:
    """Return stored metrics enabled by a profile."""
    result = []
    default_interval = profile.metrics_default_interval or fallback_interval
    for item in profile.metrics or []:
        if isinstance(item, dict):
            metric = MetricType.get_by_id(item.get("metric_type"))
            is_stored = item.get("is_stored", True)
            interval = item.get("interval") or default_interval
        else:
            metric = item.metric_type
            is_stored = item.is_stored
            interval = item.interval or default_interval
        if metric and is_stored and interval:
            result.append((metric, interval))
    return result


def _get_device_metrics(mo: ManagedObject) -> list[dict[str, Any]]:
    """Build managed object metric descriptors."""
    metrics: dict[str, dict[str, Any]] = {}
    for metric, interval in _get_metric_configs(mo.object_profile):
        metrics[str(metric.id)] = metric_to_dict(metric, interval)
    if mo.object_profile.report_ping_rtt:
        metric = MetricType.get_by_name("Ping | RTT")
        if metric:
            metrics[str(metric.id)] = metric_to_dict(metric, mo.object_profile.ping_interval)
    return sorted(metrics.values(), key=lambda item: item["name"])


def _get_metric_thresholds(
    context: dict[str, Any], scope: str, metric_ids: set[str]
) -> dict[str, list[dict[str, Any]]]:
    """Return direct metric thresholds from matching native Metric Rules."""
    result: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for rule_id, action_id in MetricRule.get_affected_rules(context, scope=scope):
        if action_id not in metric_ids:
            # Metric Actions may transform several inputs and must remain under
            # the metrics service control. Only direct Metric Type actions are
            # safe to represent as boundaries for a raw dashboard series.
            continue
        rule = MetricRule.get_by_id(rule_id)
        if not rule:
            continue
        action = next(
            (
                item
                for item in rule.actions
                if item.is_active and item.metric_type and str(item.metric_type.id) == action_id
            ),
            None,
        )
        if not action:
            continue
        for threshold in action.thresholds:
            alarm_class = threshold.alarm_class
            alarm_labels = list(threshold.alarm_labels or [])
            severity_labels = [
                *alarm_labels,
                *(list(alarm_class.labels or []) if alarm_class else []),
            ]
            severity = next(
                (
                    label.removeprefix("noc::severity::").lower()
                    for label in severity_labels
                    if label.startswith("noc::severity::")
                ),
                None,
            )
            result[action_id].append(
                {
                    "op": threshold.op,
                    "value": threshold.value,
                    "clear_value": threshold.clear_value,
                    "alarm_class": alarm_class.name if alarm_class else None,
                    "alarm_labels": alarm_labels,
                    "severity": severity,
                    "rule_id": str(rule.id),
                    "rule_name": rule.name,
                }
            )
    return dict(result)


def _get_entity_metric_thresholds(
    context: dict[str, Any], metric_ids: set[str]
) -> dict[str, list[dict[str, Any]]]:
    """Resolve direct thresholds for metrics spanning one or more scopes."""
    metrics_by_scope: dict[str, set[str]] = defaultdict(set)
    for metric_id in metric_ids:
        metric = MetricType.get_by_id(metric_id)
        if metric:
            metrics_by_scope[metric.scope.table_name].add(metric_id)
    result = {}
    for scope, scoped_metric_ids in metrics_by_scope.items():
        result.update(_get_metric_thresholds(context, scope, scoped_metric_ids))
    return result


def _get_latest_interface_state(
    mo: ManagedObject,
) -> dict[str, tuple[int, bool | None, bool | None]]:
    """Return latest stored speed and status for all managed object interfaces."""
    sql = """
        SELECT
            interface,
            argMax(speed, ts),
            argMax(status_oper, ts),
            argMax(status_admin, ts)
        FROM `interface`
        WHERE date >= today() - 1 AND managed_object = %s
        GROUP BY interface
        FORMAT TabSeparated
    """
    try:
        rows = connection().execute(sql, args=[str(mo.bi_id)])
    except ClickhouseError:
        return {}
    return {
        name: (
            int(speed),
            int(oper_status) == 1 if int(oper_status) else None,
            int(admin_status) == 1 if int(admin_status) else None,
        )
        for name, speed, oper_status, admin_status in rows
        if name
    }


def _format_interface_status(
    oper_status: bool | None, capacity_bps: int, full_duplex: bool | None
) -> str:
    """Format normalized interface status for dashboard clients."""
    oper = {True: "Up", False: "Down", None: "-"}[oper_status]
    speed = "-"
    if capacity_bps:
        for divisor, suffix in ((1_000_000_000, "G"), (1_000_000, "M"), (1_000, "k")):
            if capacity_bps >= divisor:
                value = capacity_bps / divisor
                speed = f"{value:g}{suffix}"
                break
    duplex = {True: "Full", False: "Half", None: "-"}[full_duplex]
    return f"{oper}/{speed}/{duplex}"


def _filter_orphan_series(
    series: dict[str, list[list[int | float]]],
) -> dict[str, list[list[int | float]]]:
    """Drop isolated initialization targets when a stable target is available."""
    if len(series) < 2 or not any(len(points) > 1 for points in series.values()):
        return series
    return {target: points for target, points in series.items() if len(points) > 1}


def _get_interface_groups(mo: ManagedObject) -> list[dict[str, Any]]:
    """Build a unified interface group with per-interface metric capabilities."""
    metrics_by_id: dict[str, dict[str, Any]] = {}
    entities: list[dict[str, Any]] = []
    interfaces = list(Interface.objects.filter(managed_object=mo.id))
    if not interfaces:
        return []
    discovery_interval = mo.get_metric_discovery_interval()
    latest_state = _get_latest_interface_state(mo)
    for interface in interfaces:
        metric_speed, metric_oper, metric_admin = latest_state.get(interface.name, (0, None, None))
        oper_status = interface.oper_status if interface.oper_status is not None else metric_oper
        admin_status = (
            interface.admin_status if interface.admin_status is not None else metric_admin
        )
        capacity_in = int(
            (interface.in_speed or interface.bandwidth or interface.out_speed or 0) * 1000
        )
        capacity_out = int(
            (interface.out_speed or interface.bandwidth or interface.in_speed or 0) * 1000
        )
        if not capacity_in:
            capacity_in = metric_speed
        if not capacity_out:
            capacity_out = metric_speed
        metrics = [
            metric_to_dict(metric, interval)
            for metric, interval in _get_metric_configs(interface.profile, discovery_interval)
            if metric.name not in INTERFACE_STATE_METRICS
        ]
        if not metrics:
            continue
        for metric in metrics:
            known_metric = metrics_by_id.get(metric["id"])
            if not known_metric:
                metrics_by_id[metric["id"]] = metric
            elif metric["interval"] and (
                not known_metric["interval"] or metric["interval"] < known_metric["interval"]
            ):
                # Keep the shortest group-level interval as a safe fallback.
                # The exact configured interval remains available on every entity.
                known_metric["interval"] = metric["interval"]
        metric_ids = sorted(metric["id"] for metric in metrics)
        metric_intervals = {
            metric["id"]: metric["interval"] for metric in metrics if metric["interval"]
        }
        metric_thresholds = _get_metric_thresholds(
            {
                "labels": list(getattr(interface, "effective_labels", []) or []),
                "service_groups": list(getattr(mo, "effective_service_groups", []) or []),
            },
            "interface",
            set(metric_ids),
        )
        capabilities = sorted(
            {metric["category"] for metric in metrics},
            key=lambda item: METRIC_CATEGORY_ORDER.get(item, 999),
        )
        entities.append(
            {
                "id": str(interface.id),
                "label": interface.name,
                "description": interface.description or "",
                "status": _format_interface_status(
                    oper_status, max(capacity_in, capacity_out), interface.full_duplex
                ),
                "admin_status": admin_status,
                "oper_status": oper_status,
                "full_duplex": interface.full_duplex,
                "capacity": {
                    "in_bps": capacity_in,
                    "out_bps": capacity_out,
                },
                "filters": {
                    "interface": interface.name,
                    "subinterface": "",
                    "queue": "",
                    "traffic_class": "",
                },
                "metric_ids": metric_ids,
                "metric_intervals": metric_intervals,
                "metric_thresholds": metric_thresholds,
                "capabilities": capabilities,
            }
        )
    if not entities:
        return []
    entities.sort(key=lambda item: item["label"])
    return [
        {
            "id": "interfaces",
            "title": "Interfaces",
            "kind": "interface",
            "module_id": "interfaces",
            "metrics": sorted(metrics_by_id.values(), key=lambda item: item["name"]),
            "entities": entities,
        }
    ]


def build_manifest(mo: ManagedObject) -> dict[str, Any]:
    """Build a renderer-neutral managed object dashboard manifest."""
    device_metrics = _get_device_metrics(mo)
    groups = []
    if device_metrics:
        device_metric_ids = [metric["id"] for metric in device_metrics]
        device_metric_thresholds = _get_entity_metric_thresholds(
            mo.get_matcher_ctx(), set(device_metric_ids)
        )
        groups.append(
            {
                "id": "device",
                "title": "Device",
                "kind": "device",
                "module_id": "overview",
                "metrics": device_metrics,
                "entities": [
                    {
                        "id": str(mo.id),
                        "label": mo.name,
                        "description": mo.description or "",
                        "status": "up" if mo.is_managed else "unmanaged",
                        "admin_status": None,
                        "oper_status": bool(mo.is_managed),
                        "full_duplex": None,
                        "capacity": {"in_bps": 0, "out_bps": 0},
                        "filters": {},
                        "metric_ids": device_metric_ids,
                        "metric_intervals": {
                            metric["id"]: metric["interval"]
                            for metric in device_metrics
                            if metric["interval"]
                        },
                        "metric_thresholds": device_metric_thresholds,
                        "capabilities": sorted(
                            {metric["category"] for metric in device_metrics},
                            key=lambda item: METRIC_CATEGORY_ORDER.get(item, 999),
                        ),
                    }
                ],
            }
        )
    groups.extend(_get_interface_groups(mo))
    module_specs = (
        ("overview", "Overview", "device"),
        ("interfaces", "Interfaces", "interface"),
    )
    modules = []
    for module_id, title, kind in module_specs:
        module_groups = [group for group in groups if group["module_id"] == module_id]
        if not module_groups:
            continue
        categories = {metric["category"] for group in module_groups for metric in group["metrics"]}
        modules.append(
            {
                "id": module_id,
                "title": title,
                "kind": kind,
                "group_ids": [group["id"] for group in module_groups],
                "capabilities": sorted(
                    categories, key=lambda item: METRIC_CATEGORY_ORDER.get(item, 999)
                ),
            }
        )
    return {
        "api_version": API_VERSION,
        "dashboard": "managed_object",
        "object": {
            "id": str(mo.id),
            "bi_id": str(mo.bi_id),
            "name": mo.name,
            "address": mo.address,
            "description": mo.description or "",
            "platform": mo.platform.name if mo.platform else None,
            "version": mo.version.version if mo.version else None,
            "vendor": str(mo.vendor) if mo.vendor else None,
            "segment": str(mo.segment) if mo.segment else None,
            "pool": mo.pool.name if mo.pool else None,
        },
        "groups": groups,
        "modules": modules,
        "capabilities": sorted(
            {capability for module in modules for capability in module["capabilities"]},
            key=lambda item: METRIC_CATEGORY_ORDER.get(item, 999),
        ),
        "query": {"url": "/pm/ddash/query/", "method": "POST"},
        "summary": {"url": "/pm/ddash/summary/", "method": "POST"},
        "legacy_url": f"/ui/grafana/dashboard/script/noc.js?dashboard=mo&id={mo.id}",
    }


def _validate_identifier(value: str) -> str:
    """Validate a ClickHouse identifier loaded from the model registry."""
    if not RX_IDENTIFIER.match(value):
        raise NativeDashboardError("Invalid metric configuration")
    return value


def _query_metric(
    mo: ManagedObject,
    metric: MetricType,
    filters: dict[str, Any],
    start: datetime.datetime,
    end: datetime.datetime,
    interval: int,
) -> list[dict[str, Any]]:
    """Query a single semantic metric and return target series."""
    allowed_fields = get_allowed_filter_fields(metric)
    if "managed_object" not in allowed_fields:
        raise NativeDashboardError(f"Metric {metric.name} is not available for managed objects")
    unknown_fields = set(filters) - allowed_fields
    if unknown_fields:
        raise NativeDashboardError(
            f"Unsupported metric filters: {', '.join(sorted(unknown_fields))}"
        )
    for filter_value in filters.values():
        if not isinstance(filter_value, (str, int, float, bool)):
            raise NativeDashboardError("Invalid metric filter value")
        if isinstance(filter_value, float) and not math.isfinite(filter_value):
            raise NativeDashboardError("Invalid metric filter value")
    table = _validate_identifier(metric.scope.table_name)
    field = _validate_identifier(metric.field_name)
    value_expression = f"`{field}`"
    # Ping writes RTT as integer microseconds directly to ClickHouse while
    # MetricType exposes milliseconds to dashboards.
    if table == "ping" and field == "rtt":
        value_expression = f"toFloat64(`{field}`) / 1000.0"
    conditions = [
        "date >= toDate(%s)",
        "date <= toDate(%s)",
        "ts >= toDateTime(%s)",
        "ts <= toDateTime(%s)",
    ]
    args: list[str] = [
        str(config.timezone),
        start.date().isoformat(),
        end.date().isoformat(),
        start.isoformat(sep=" ", timespec="seconds"),
        end.isoformat(sep=" ", timespec="seconds"),
    ]
    conditions.append("managed_object = %s")
    args.append(str(mo.bi_id))
    for filter_name, filter_value in sorted(filters.items()):
        conditions.append(f"`{_validate_identifier(filter_name)}` = %s")
        args.append(str(filter_value))
    sql = f"""
        SELECT
            toUnixTimestamp(
                toDateTime(
                    formatDateTime(
                        toStartOfInterval(ts, toIntervalSecond({interval})),
                        '%%F %%T'
                    ),
                    %s
                )
            ) * 1000 AS t,
            arrayStringConcat(labels, '/') AS target,
            avg({value_expression}) AS value
        FROM `{table}`
        WHERE {" AND ".join(conditions)}
        GROUP BY t, target
        ORDER BY t, target
        LIMIT {MAX_QUERY_POINTS + 1}
        FORMAT TabSeparated
    """
    rows = connection().execute(sql, args=args)
    if len(rows) > MAX_QUERY_POINTS:
        raise NativeDashboardError("The query returned too many points")
    series: dict[str, list[list[int | float]]] = defaultdict(list)
    for timestamp, target, raw_value in rows:
        value = float(raw_value)
        if not math.isfinite(value):
            continue
        series[target or metric.name].append([int(timestamp), value])
    series = _filter_orphan_series(series)
    return [
        {
            "key": f"{metric.id}:{target}",
            "metric_id": str(metric.id),
            "name": metric.name,
            "target": target,
            "unit": metric_to_dict(metric)["unit"],
            "points": points,
        }
        for target, points in sorted(series.items())
    ]


def _query_interface_metric_summary(
    mo: ManagedObject,
    metric: MetricType,
    filters: dict[str, Any],
    start: datetime.datetime,
    end: datetime.datetime,
) -> dict[str, dict[str, int | float]]:
    """Return bounded per-interface reductions for a semantic metric."""
    allowed_fields = get_allowed_filter_fields(metric)
    if "managed_object" not in allowed_fields or "interface" not in allowed_fields:
        raise NativeDashboardError(f"Metric {metric.name} is not available for interfaces")
    unknown_fields = set(filters) - allowed_fields
    if unknown_fields:
        raise NativeDashboardError(
            f"Unsupported metric filters: {', '.join(sorted(unknown_fields))}"
        )
    table = _validate_identifier(metric.scope.table_name)
    field = _validate_identifier(metric.field_name)
    value_expression = f"`{field}`"
    conditions = [
        "date >= toDate(%s)",
        "date <= toDate(%s)",
        "ts >= toDateTime(%s)",
        "ts <= toDateTime(%s)",
        "managed_object = %s",
    ]
    args: list[str] = [
        start.date().isoformat(),
        end.date().isoformat(),
        start.isoformat(sep=" ", timespec="seconds"),
        end.isoformat(sep=" ", timespec="seconds"),
        str(mo.bi_id),
    ]
    for filter_name, filter_value in sorted(filters.items()):
        if not isinstance(filter_value, (str, int, float, bool)):
            raise NativeDashboardError("Invalid metric filter value")
        if isinstance(filter_value, float) and not math.isfinite(filter_value):
            raise NativeDashboardError("Invalid metric filter value")
        conditions.append(f"`{_validate_identifier(filter_name)}` = %s")
        args.append(str(filter_value))
    sql = f"""
        SELECT
            interface,
            argMax({value_expression}, ts) AS current_value,
            avg({value_expression}) AS average_value,
            max({value_expression}) AS peak_value,
            quantile(0.95)({value_expression}) AS p95_value,
            toUnixTimestamp(max(ts)) * 1000 AS latest_ts
        FROM `{table}`
        WHERE {" AND ".join(conditions)}
        GROUP BY interface
        ORDER BY interface
        LIMIT {MAX_SUMMARY_ENTITIES + 1}
        FORMAT TabSeparated
    """
    rows = connection().execute(sql, args=args)
    if len(rows) > MAX_SUMMARY_ENTITIES:
        raise NativeDashboardError("The summary returned too many entities")
    result = {}
    for interface, current, average, peak, p95, latest_ts in rows:
        values = [float(current), float(average), float(peak), float(p95)]
        if not interface or not all(math.isfinite(value) for value in values):
            continue
        result[str(interface)] = {
            "current": values[0],
            "average": values[1],
            "peak": values[2],
            "p95": values[3],
            "latest_ts": int(latest_ts),
        }
    return result


def query_summary(mo: ManagedObject, data: dict[str, Any]) -> dict[str, Any]:
    """Return bounded inventory and metric reductions for an interface group."""
    start, end, _ = parse_time_range({**data, "interval": 60})
    manifest = build_manifest(mo)
    group = next((item for item in manifest["groups"] if item["id"] == data.get("group_id")), None)
    if not group or group["kind"] != "interface":
        raise NativeDashboardError("Unknown interface group")
    if len(group["entities"]) > MAX_SUMMARY_ENTITIES:
        raise NativeDashboardError("The interface group is too large")
    metric_ids = data.get("metric_ids")
    if not isinstance(metric_ids, list) or not metric_ids:
        raise NativeDashboardError("At least one summary metric is required")
    if (
        len(metric_ids) > MAX_SUMMARY_METRICS
        or any(not isinstance(metric_id, str) or not metric_id for metric_id in metric_ids)
        or len(set(metric_ids)) != len(metric_ids)
    ):
        raise NativeDashboardError("Invalid summary metric selection")
    configured_metrics = {metric["id"]: metric for metric in group["metrics"]}
    unknown_metrics = set(metric_ids) - set(configured_metrics)
    if unknown_metrics:
        raise NativeDashboardError("A summary metric is not enabled for this group")

    common_filters: dict[str, Any] = {}
    if group["entities"]:
        first_filters = group["entities"][0]["filters"]
        for field, value in first_filters.items():
            if field != "interface" and all(
                entity["filters"].get(field) == value for entity in group["entities"]
            ):
                common_filters[field] = value

    summaries = {}
    for metric_id in metric_ids:
        metric = MetricType.get_by_id(metric_id)
        if not metric:
            raise NativeDashboardError("Unknown summary metric")
        metric_config = configured_metrics[metric_id]
        metric_filters = {
            field: value
            for field, value in common_filters.items()
            if field in metric_config["filter_fields"] and value not in (None, "")
        }
        summaries[metric_id] = _query_interface_metric_summary(
            mo, metric, metric_filters, start, end
        )

    entities = []
    latest_ts = 0
    for entity in group["entities"]:
        values = {
            metric_id: summaries[metric_id][entity["label"]]
            for metric_id in metric_ids
            if metric_id in entity["metric_ids"] and entity["label"] in summaries[metric_id]
        }
        if values:
            latest_ts = max(latest_ts, max(int(value["latest_ts"]) for value in values.values()))
        entities.append(
            {
                "id": entity["id"],
                "label": entity["label"],
                "description": entity["description"],
                "status": entity["status"],
                "admin_status": entity["admin_status"],
                "oper_status": entity["oper_status"],
                "capacity": entity["capacity"],
                "capabilities": entity["capabilities"],
                "metric_ids": entity["metric_ids"],
                "metric_thresholds": {
                    metric_id: entity["metric_thresholds"].get(metric_id, [])
                    for metric_id in metric_ids
                    if entity["metric_thresholds"].get(metric_id)
                },
                "values": values,
            }
        )
    inventory = {
        "total": len(entities),
        "operational": sum(
            entity["admin_status"] is not False and entity["oper_status"] is True
            for entity in entities
        ),
        "down": sum(
            entity["admin_status"] is not False and entity["oper_status"] is False
            for entity in entities
        ),
        "disabled": sum(entity["admin_status"] is False for entity in entities),
        "unknown": sum(
            entity["admin_status"] is not False and entity["oper_status"] is None
            for entity in entities
        ),
        "optical": sum("optical" in entity["capabilities"] for entity in entities),
    }
    return {
        "api_version": API_VERSION,
        "object_id": str(mo.id),
        "group_id": group["id"],
        "from": int(start.timestamp() * 1000),
        "to": int(end.timestamp() * 1000),
        "latest_ts": latest_ts or None,
        "inventory": inventory,
        "entities": entities,
    }


def query_metrics(mo: ManagedObject, data: dict[str, Any]) -> dict[str, Any]:
    """Execute a bounded semantic metrics query."""
    start, end, interval = parse_time_range(data)
    requests = data.get("series")
    if not isinstance(requests, list) or not requests:
        raise NativeDashboardError("At least one metric series is required")
    if len(requests) > MAX_QUERY_SERIES:
        raise NativeDashboardError("Too many metric series requested")
    estimated_points = math.ceil((end - start).total_seconds() / interval) * len(requests)
    if estimated_points > MAX_QUERY_POINTS:
        raise NativeDashboardError("The aggregation interval is too small for this query")
    manifest = build_manifest(mo)
    groups = {group["id"]: group for group in manifest["groups"]}
    result = []
    for item in requests:
        if not isinstance(item, dict):
            raise NativeDashboardError("Invalid metric series")
        group_id = item.get("group_id")
        entity_id = item.get("entity_id")
        metric_id = item.get("metric_id")
        if any(
            not isinstance(value, str) or not value for value in (group_id, entity_id, metric_id)
        ):
            raise NativeDashboardError("Invalid metric series")
        group = groups.get(group_id)
        if not group:
            raise NativeDashboardError("Unknown dashboard group")
        entity = next(
            (entity for entity in group["entities"] if entity["id"] == entity_id),
            None,
        )
        if not entity:
            raise NativeDashboardError("Unknown dashboard entity")
        metric_config = next(
            (metric for metric in group["metrics"] if metric["id"] == metric_id), None
        )
        if not metric_config:
            raise NativeDashboardError("Metric is not enabled for this object")
        if metric_id not in entity["metric_ids"]:
            raise NativeDashboardError("Metric is not enabled for this entity")
        metric = MetricType.get_by_id(metric_id)
        if not metric:
            raise NativeDashboardError("Unknown metric")
        filters = {
            field: value
            for field, value in entity["filters"].items()
            if field in metric_config["filter_fields"] and value not in (None, "")
        }
        result.extend(_query_metric(mo, metric, filters, start, end, interval))
        if sum(len(series["points"]) for series in result) > MAX_QUERY_POINTS:
            raise NativeDashboardError("The query returned too many points")
    return {
        "api_version": API_VERSION,
        "from": int(data["from"]),
        "to": int(data["to"]),
        "interval": interval,
        "series": result,
    }
