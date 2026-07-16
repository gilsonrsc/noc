# ---------------------------------------------------------------------
# Native performance dashboard tests
# ---------------------------------------------------------------------
# Copyright (C) 2007-2026 The NOC Project
# See LICENSE for details
# ---------------------------------------------------------------------

# Python modules
import datetime
from types import SimpleNamespace

# Third-party modules
import pytest

# NOC modules
from noc.services.web.apps.pm.ddash.native import (
    MAX_QUERY_RANGE_MS,
    NativeDashboardError,
    _format_interface_status,
    _filter_orphan_series,
    _get_interface_groups,
    _get_metric_thresholds,
    _query_metric,
    get_allowed_filter_fields,
    get_metric_category,
    get_metric_direction,
    metric_to_dict,
    parse_time_range,
    query_metrics,
)


def test_format_interface_status():
    assert _format_interface_status(True, 10_000_000_000, True) == "Up/10G/Full"
    assert _format_interface_status(False, 0, None) == "Down/-/-"


def test_filter_orphan_series():
    stable = [[1, 4.0], [2, 5.0]]
    assert _filter_orphan_series({"CPU item": [[1, 5.0]], "CPU Slot 0": stable}) == {
        "CPU Slot 0": stable
    }


def test_interface_groups_are_unified_with_entity_metric_capabilities(monkeypatch):
    traffic_profile = object()
    optical_profile = object()
    traffic_metric = SimpleNamespace(id="traffic", name="Interface | Load | In")
    optical_metric = SimpleNamespace(id="optical", name="Interface | DOM | RxPower")
    interfaces = [
        SimpleNamespace(
            id="if-traffic",
            name="Eth-Trunk50",
            description="",
            oper_status=True,
            admin_status=True,
            full_duplex=True,
            in_speed=1_000_000,
            out_speed=1_000_000,
            bandwidth=0,
            profile=traffic_profile,
        ),
        SimpleNamespace(
            id="if-optical",
            name="100GE0/3/0",
            description="Uplink",
            oper_status=True,
            admin_status=True,
            full_duplex=True,
            in_speed=100_000_000,
            out_speed=100_000_000,
            bandwidth=0,
            profile=optical_profile,
        ),
    ]

    def get_configs(profile):
        if profile is optical_profile:
            return [(traffic_metric, 60), (optical_metric, 300)]
        return [(traffic_metric, 60)]

    def serialize_metric(metric, interval):
        return {
            "id": metric.id,
            "name": metric.name,
            "category": "optical" if metric is optical_metric else "traffic",
            "interval": interval,
        }

    monkeypatch.setattr(
        "noc.services.web.apps.pm.ddash.native.Interface",
        SimpleNamespace(objects=SimpleNamespace(filter=lambda **_kwargs: interfaces)),
    )
    monkeypatch.setattr(
        "noc.services.web.apps.pm.ddash.native._get_latest_interface_state", lambda _mo: {}
    )
    monkeypatch.setattr("noc.services.web.apps.pm.ddash.native._get_metric_configs", get_configs)
    monkeypatch.setattr("noc.services.web.apps.pm.ddash.native.metric_to_dict", serialize_metric)
    monkeypatch.setattr(
        "noc.services.web.apps.pm.ddash.native._get_metric_thresholds",
        lambda *_args, **_kwargs: {},
    )

    groups = _get_interface_groups(SimpleNamespace(id=42))

    assert len(groups) == 1
    assert groups[0]["id"] == "interfaces"
    assert [entity["label"] for entity in groups[0]["entities"]] == [
        "100GE0/3/0",
        "Eth-Trunk50",
    ]
    assert groups[0]["entities"][0]["metric_ids"] == ["optical", "traffic"]
    assert groups[0]["entities"][0]["metric_intervals"] == {
        "traffic": 60,
        "optical": 300,
    }
    assert groups[0]["entities"][1]["metric_ids"] == ["traffic"]


def test_metric_thresholds_reuse_matching_native_metric_rules(monkeypatch):
    alarm_class = SimpleNamespace(name="NOC | PM | Low Warning", labels=["noc::severity::warning"])
    threshold = SimpleNamespace(
        op="<=",
        value=-18.0,
        clear_value=-17.5,
        alarm_class=alarm_class,
        alarm_labels=["noc::dashboard::optical"],
    )
    action = SimpleNamespace(
        is_active=True,
        metric_type=SimpleNamespace(id="optical-rx"),
        thresholds=[threshold],
    )
    rule = SimpleNamespace(id="rule-id", name="Optical Rx warning", actions=[action])
    monkeypatch.setattr(
        "noc.services.web.apps.pm.ddash.native.MetricRule.get_affected_rules",
        lambda context, scope: [["rule-id", "optical-rx"]],
    )
    monkeypatch.setattr(
        "noc.services.web.apps.pm.ddash.native.MetricRule.get_by_id", lambda _id: rule
    )

    assert _get_metric_thresholds(
        {"labels": ["noc::interface::uplink"], "service_groups": []},
        "interface",
        {"optical-rx"},
    ) == {
        "optical-rx": [
            {
                "op": "<=",
                "value": -18.0,
                "clear_value": -17.5,
                "alarm_class": "NOC | PM | Low Warning",
                "alarm_labels": ["noc::dashboard::optical"],
                "severity": "warning",
                "rule_id": "rule-id",
                "rule_name": "Optical Rx warning",
            }
        ]
    }


def test_metric_thresholds_ignore_transformed_metric_actions(monkeypatch):
    monkeypatch.setattr(
        "noc.services.web.apps.pm.ddash.native.MetricRule.get_affected_rules",
        lambda context, scope: [["rule-id", "metric-action-id"]],
    )
    monkeypatch.setattr(
        "noc.services.web.apps.pm.ddash.native.MetricRule.get_by_id",
        lambda _id: pytest.fail("transformed action must not be loaded"),
    )

    assert (
        _get_metric_thresholds({"labels": [], "service_groups": []}, "interface", {"optical-rx"})
        == {}
    )


def test_query_metric_uses_clickhouse_datetime_precision(monkeypatch):
    captured = {}

    class FakeConnection:
        def execute(self, sql, args):
            captured["sql"] = sql
            captured["args"] = args
            return []

    metric = SimpleNamespace(
        id="metric-id",
        name="Ping | RTT",
        field_name="rtt",
        scope=SimpleNamespace(
            table_name="ping",
            key_fields=[SimpleNamespace(field_name="managed_object")],
            labels=[],
        ),
    )
    monkeypatch.setattr(
        "noc.services.web.apps.pm.ddash.native.connection", lambda: FakeConnection()
    )
    _query_metric(
        SimpleNamespace(bi_id=42),
        metric,
        {},
        datetime.datetime(2026, 7, 15, 21, 34, 31, 455000),
        datetime.datetime(2026, 7, 15, 22, 34, 31, 455000),
        60,
    )
    assert "toDateTime" in captured["sql"]
    assert "formatDateTime" in captured["sql"]
    assert "toFloat64(`rtt`) / 1000.0" in captured["sql"]
    assert captured["args"] == [
        "Europe/Moscow",
        "2026-07-15",
        "2026-07-15",
        "2026-07-15 21:34:31",
        "2026-07-15 22:34:31",
        "42",
    ]


def test_parse_time_range():
    start = 1_700_000_000_000
    end = start + 3_600_000
    parsed_start, parsed_end, interval = parse_time_range(
        {"from": start, "to": end, "interval": 60}
    )
    assert parsed_start == datetime.datetime.fromtimestamp(start / 1000)
    assert parsed_end == datetime.datetime.fromtimestamp(end / 1000)
    assert interval == 60


@pytest.mark.parametrize(
    "data",
    [
        {},
        {"from": 2, "to": 1},
        {"from": 1, "to": 2, "interval": 1},
        {"from": 1, "to": MAX_QUERY_RANGE_MS + 2},
    ],
)
def test_parse_time_range_rejects_invalid_requests(data):
    with pytest.raises(NativeDashboardError):
        parse_time_range(data)


def test_get_allowed_filter_fields():
    metric = SimpleNamespace(
        scope=SimpleNamespace(
            key_fields=[SimpleNamespace(field_name="managed_object")],
            labels=[
                SimpleNamespace(store_column="interface", view_column=""),
                SimpleNamespace(store_column="", view_column="slot"),
            ],
        )
    )
    assert get_allowed_filter_fields(metric) == {"managed_object", "interface", "slot"}


def test_metric_to_dict():
    metric = SimpleNamespace(
        id="metric-id",
        name="Interface | Load | In",
        description="Input load",
        scope=SimpleNamespace(
            name="Interface",
            key_fields=[SimpleNamespace(field_name="managed_object")],
            labels=[SimpleNamespace(store_column="interface", view_column="")],
        ),
        units=SimpleNamespace(
            code="bit/s",
            label="bit/s",
            dashboard_label="bps",
            dashboard_sr_color=0x336699,
        ),
        measure="bps",
        is_delta=False,
    )
    assert metric_to_dict(metric, 60) == {
        "id": "metric-id",
        "name": "Interface | Load | In",
        "description": "Input load",
        "scope": "Interface",
        "category": "traffic",
        "direction": "in",
        "unit": {"code": "bit/s", "label": "bps"},
        "color": "#336699",
        "is_delta": False,
        "interval": 60,
        "filter_fields": ["interface"],
    }


@pytest.mark.parametrize(
    ("name", "scope", "category"),
    [
        ("Radio | RSSI", "Interface", "radio"),
        ("Interface | DOM | RxPower", "Interface", "optical"),
        ("Environment | Temperature", "Environment", "environment"),
        ("Interface | xDSL | Line | SNR | Downstream", "Interface", "access"),
        ("SLA | RTT | Avg", "SLA", "sla"),
        ("Disk | Usage", "Disk", "storage"),
        ("Vendor neutral custom metric", "Object", "health"),
    ],
)
def test_metric_capability_is_vendor_neutral(name, scope, category):
    metric = SimpleNamespace(name=name, scope=SimpleNamespace(name=scope))
    assert get_metric_category(metric) == category


def test_metric_direction():
    inbound = SimpleNamespace(name="Interface | Load | In")
    outbound = SimpleNamespace(name="Radio | Tx | Power")
    assert get_metric_direction(inbound) == "in"
    assert get_metric_direction(outbound) == "out"


def test_metric_to_dict_uses_measure_for_scaled_metrics():
    metric = SimpleNamespace(
        id="metric-id",
        name="Ping | RTT",
        description="Round trip time",
        scope=SimpleNamespace(
            name="Ping",
            key_fields=[SimpleNamespace(field_name="managed_object")],
            labels=[],
        ),
        units=SimpleNamespace(
            code="s",
            label="s",
            dashboard_label="s",
            dashboard_sr_color=None,
        ),
        scale=SimpleNamespace(exp=-3),
        measure="ms",
        is_delta=False,
    )
    assert metric_to_dict(metric)["unit"] == {"code": "s", "label": "ms"}


def test_query_metrics_resolves_filters_from_manifest(monkeypatch):
    metric = SimpleNamespace(id="metric-id")
    manifest = {
        "groups": [
            {
                "id": "interfaces:profile-id",
                "metrics": [{"id": "metric-id", "filter_fields": ["interface"]}],
                "entities": [
                    {
                        "id": "interface-id",
                        "filters": {"interface": "Gi0/1", "queue": ""},
                        "metric_ids": ["metric-id"],
                    }
                ],
            }
        ]
    }
    captured = {}

    def query_metric(_mo, _metric, filters, _start, _end, _interval):
        captured.update(filters)
        return []

    monkeypatch.setattr(
        "noc.services.web.apps.pm.ddash.native.build_manifest", lambda _mo: manifest
    )
    monkeypatch.setattr(
        "noc.services.web.apps.pm.ddash.native.MetricType.get_by_id", lambda _id: metric
    )
    monkeypatch.setattr("noc.services.web.apps.pm.ddash.native._query_metric", query_metric)
    result = query_metrics(
        SimpleNamespace(),
        {
            "from": 1_700_000_000_000,
            "to": 1_700_003_600_000,
            "interval": 60,
            "series": [
                {
                    "group_id": "interfaces:profile-id",
                    "entity_id": "interface-id",
                    "metric_id": "metric-id",
                    "filters": {"interface": "attacker-controlled"},
                }
            ],
        },
    )
    assert captured == {"interface": "Gi0/1"}
    assert result["series"] == []


def test_query_metrics_rejects_metric_not_enabled_for_entity(monkeypatch):
    manifest = {
        "groups": [
            {
                "id": "interfaces",
                "metrics": [{"id": "optical", "filter_fields": ["interface"]}],
                "entities": [
                    {
                        "id": "ethernet",
                        "filters": {"interface": "Eth-Trunk50"},
                        "metric_ids": ["traffic"],
                    }
                ],
            }
        ]
    }
    monkeypatch.setattr(
        "noc.services.web.apps.pm.ddash.native.build_manifest", lambda _mo: manifest
    )

    with pytest.raises(NativeDashboardError, match="not enabled for this entity"):
        query_metrics(
            SimpleNamespace(),
            {
                "from": 1_700_000_000_000,
                "to": 1_700_003_600_000,
                "interval": 60,
                "series": [
                    {
                        "group_id": "interfaces",
                        "entity_id": "ethernet",
                        "metric_id": "optical",
                    }
                ],
            },
        )


def test_query_metrics_rejects_excessive_estimated_points():
    start = 1_700_000_000_000
    with pytest.raises(NativeDashboardError, match="aggregation interval"):
        query_metrics(
            SimpleNamespace(),
            {
                "from": start,
                "to": start + MAX_QUERY_RANGE_MS,
                "interval": 10,
                "series": [
                    {
                        "group_id": "device",
                        "entity_id": "1",
                        "metric_id": "metric-id",
                    }
                ],
            },
        )
