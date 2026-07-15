# ---------------------------------------------------------------------
# pm.ddash application
# ---------------------------------------------------------------------
# Copyright (C) 2007-2021 The NOC Project
# See LICENSE for details
# ---------------------------------------------------------------------


# Third-party modules
import orjson
from django.db.models import Q

# NOC modules
from noc.core.clickhouse.error import ClickhouseError
from noc.core.translation import ugettext as _
from noc.services.web.base.extapplication import ExtApplication, view
from noc.sa.models.managedobject import ManagedObject
from noc.sa.models.useraccess import UserAccess
from .dashboards.base import BaseDashboard
from .dashboards.loader import loader
from .native import NativeDashboardError, build_manifest, query_metrics


class DynamicDashboardApplication(ExtApplication):
    """
    MetricType application
    """

    title = _("Dynamic Dashboard")

    @staticmethod
    def get_managed_object(request, object_id):
        """Resolve managed object and apply administrative domain access."""
        try:
            object_id = int(object_id)
        except (TypeError, ValueError):
            return None
        query = Q(id=object_id) | Q(bi_id=object_id)
        objects = ManagedObject.objects.filter(query)
        if not request.user.is_superuser:
            objects = objects.filter(UserAccess.Q(request.user))
        return objects.first()

    @view(url=r"^manifest/$", method="GET", access="launch", api=True)
    def api_manifest(self, request):
        """Return renderer-neutral dashboard metadata."""
        if request.GET.get("dashboard", "mo") != "mo":
            return self.render_json({"error": "Unsupported dashboard"}, status=self.BAD_REQUEST)
        managed_object = self.get_managed_object(request, request.GET.get("id"))
        if not managed_object:
            return self.render_json({"error": "Object not found"}, status=self.NOT_FOUND)
        return build_manifest(managed_object)

    @view(url=r"^query/$", method="POST", access="launch", api=True)
    def api_query(self, request):
        """Query bounded time series for the native dashboard."""
        try:
            data = orjson.loads(request.body)
        except ValueError:
            return self.render_json({"error": "Invalid JSON body"}, status=self.BAD_REQUEST)
        if not isinstance(data, dict):
            return self.render_json({"error": "Invalid JSON body"}, status=self.BAD_REQUEST)
        managed_object = self.get_managed_object(request, data.get("object_id"))
        if not managed_object:
            return self.render_json({"error": "Object not found"}, status=self.NOT_FOUND)
        try:
            return query_metrics(managed_object, data)
        except NativeDashboardError as e:
            return self.render_json({"error": str(e)}, status=self.BAD_REQUEST)
        except ClickhouseError:
            self.logger.exception("Native dashboard ClickHouse query failed")
            return self.render_json(
                {"error": "Metrics storage is unavailable"}, status=self.INTERNAL_ERROR
            )

    @view(url=r"^$", method="GET", access="launch", api=True)
    def api_dashboard(self, request):
        dash_name = request.GET.get("dashboard")
        try:
            dt = loader[dash_name]
        except Exception:
            self.logger.error("Exception when loading dashboard: %s", request.GET.get("dashboard"))
            return self.response_not_found("Dashboard not found")
        if not dt:
            return self.response_not_found("Dashboard not found")
        oid = request.GET.get("id")
        extra_vars = {}
        for v in request.GET:
            if v.startswith("var_"):
                extra_vars[v] = request.GET[v]
        extra_template = request.GET.get("extra_template")
        try:
            dashboard = dt(oid, extra_template, extra_vars)
        except BaseDashboard.NotFound:
            return self.response_not_found("Object not found")
        print(dashboard, dashboard.template)
        return dashboard.render()
