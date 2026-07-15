# Native Monitoring Dashboard

The native monitoring dashboard renders NOC performance data without depending on a Grafana
plugin. It is a standalone Vite package, uses Apache ECharts, and consumes a renderer-neutral
semantic API from `pm.ddash`.

## Architecture

The implementation keeps the integration surface small:

- `services/web/apps/pm/ddash/native.py` builds the manifest and executes bounded ClickHouse
  queries.
- `services/web/apps/pm/ddash/views.py` exposes the authenticated endpoints with the existing
  `pm:ddash:launch` permission.
- `ui/packages/monitoring-dashboard/` owns the standalone renderer.
- Managed object dashboard actions in the inventory form, map inspector, and map context menu
  open the native renderer.

Grafana remains available through `legacy_url` in the manifest. Other Grafana dashboard types
continue to use their existing paths.

## Semantic API

Load the manifest for a managed object:

```http
GET /pm/ddash/manifest/?dashboard=mo&id=42
Accept: application/json
```

The response describes the object, metric groups, entities, available metrics, query endpoint,
and legacy Grafana URL. API version 1.1 exposes `metric_ids`, `metric_intervals`, and
`capabilities` on every entity. Interface profiles are consolidated into one interface catalog;
the per-entity fields define which signals are valid for each interface. Clients should select
identifiers from this response rather than constructing database filters.

Query selected series:

```http
POST /pm/ddash/query/
Content-Type: application/json

{
  "object_id": "42",
  "from": 1784138400000,
  "to": 1784142000000,
  "interval": 60,
  "series": [
    {
      "group_id": "interfaces",
      "entity_id": "65f000000000000000000002",
      "metric_id": "65f000000000000000000003"
    }
  ]
}
```

The server resolves ClickHouse filters from the selected group and entity. It rejects metrics
that are not enabled for the managed object, caps the time range, series count, aggregation
interval, and returned points, and never accepts SQL expressions from the client.

## Development

Install the workspace and run the package checks from `ui/`:

```shell
pnpm install
pnpm --filter monitoring-dashboard run typecheck
pnpm --filter monitoring-dashboard run test
pnpm run build:monitoring-dashboard
```

The build copies `monitoring-dashboard.html`, JavaScript, CSS, and the source map to `ui/dist/`.
The standard NOC production build also includes this package through `build:bundles-prod`.

## Extension Points

Add sensors, service-level agreements, links, or customer premises equipment by contributing a
new manifest group and its entities. The frontend discovers groups dynamically, so most new
group types do not require renderer changes. Keep database names and filters on the server side,
and expose only stable semantic identifiers to clients.
