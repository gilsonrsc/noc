import {BarChart, LineChart} from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  ToolboxComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import {CanvasRenderer} from "echarts/renderers";
import {buildMetricQuery, loadManifest, loadSeries, loadSummary} from "./api";
import {
  buildChartOption,
  buildInterfaceRankingOption,
  compactMetricName,
  earliestSeriesTimestamp,
  formatMetricValueWithUnit,
  SERIES_PALETTE,
  seriesStatistics,
  seriesDisplayName,
} from "./chart";
import {metricForDirection, rankInterfaces, summaryMetrics, utilizationFor} from "./summary";
import {__, initializeI18n} from "./i18n";
import {
  formatCapacity,
  formatPercentage,
  formatThresholds,
  formatTimestamp,
  metricDomainClass,
  objectMeta,
  RANGE_OPTIONS,
  REFRESH_OPTIONS,
  summaryMetricValue,
  thresholdMatches,
  viewContent,
} from "./presentation";
import {
  capacityForSeries,
  defaultMetricView,
  metricView,
  metricViewLabel,
  metricsForEntity,
  metricsForView,
  seriesIsStale,
  type MetricView,
  type MonitorState,
} from "./state";
import type {
  DashboardEntity,
  DashboardGroup,
  DashboardManifest,
  DashboardSummary,
  SummaryEntity,
  TimeSeries,
} from "./types";
import "./styles.css";

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  ToolboxComponent,
  CanvasRenderer,
]);

function requireElement<T extends Element>(node: T | null, message: string): T {
  if (!node) throw new Error(message);
  return node;
}

const app = requireElement(
  document.querySelector<HTMLElement>("#app"),
  __("Dashboard root element is missing"),
);

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderFatal(message: string, legacyUrl?: string): void {
  app.replaceChildren();
  const card = element("section", "fatal-card");
  card.append(element("div", "fatal-mark", "!"));
  card.append(element("h1", "fatal-title", __("Dashboard unavailable")));
  card.append(element("p", "fatal-message", message));
  if (legacyUrl) {
    const link = element("a", "button secondary", __("Open legacy Grafana"));
    link.href = legacyUrl;
    card.append(link);
  }
  app.append(card);
}

async function start(): Promise<void> {
  const objectId = new URLSearchParams(window.location.search).get("id");
  if (!objectId) {
    renderFatal(__("No managed object was selected."));
    return;
  }

  let manifest: DashboardManifest;
  try {
    manifest = await loadManifest(objectId);
  } catch (error) {
    renderFatal(error instanceof Error ? error.message : __("Unable to load dashboard metadata."));
    return;
  }
  if (manifest.groups.length === 0) {
    renderFatal(__("This object has no stored metrics configured."), manifest.legacy_url);
    return;
  }

  app.replaceChildren();
  const header = element("header", "dashboard-header");
  const identity = element("div", "identity");
  const eyebrow = element("div", "eyebrow", __("Network performance"));
  const titleLine = element("div", "title-line");
  titleLine.append(element("span", "live-dot"), element("h1", "object-title", manifest.object.name));
  identity.append(eyebrow, titleLine, element("p", "object-meta", objectMeta(manifest).join(" · ")));
  const headerActions = element("div", "header-actions");
  const legacyLink = element("a", "button secondary legacy-link", "Grafana");
  legacyLink.href = manifest.legacy_url;
  legacyLink.target = "_blank";
  legacyLink.rel = "noopener";
  const lastUpdated = element("span", "last-updated", __("Not updated yet"));
  headerActions.append(lastUpdated, legacyLink);
  header.append(identity, headerActions);

  const workspace = element("main", "workspace");
  const content = element("section", "content");
  const viewNav = element("nav", "view-nav");
  viewNav.setAttribute("aria-label", __("Dashboard sections"));
  const overviewButton = element("button", "view-nav-button", __("Overview"));
  const interfacesButton = element("button", "view-nav-button", __("Interfaces"));
  const analysisButton = element("button", "view-nav-button", __("Analysis"));
  for (const button of [overviewButton, interfacesButton, analysisButton]) button.type = "button";
  viewNav.append(overviewButton, interfacesButton, analysisButton);

  const controlBar = element("section", "dashboard-controls");
  const sourceControls = element("div", "source-controls");
  const scopeSummary = element("div", "scope-summary");
  scopeSummary.append(
    element("span", "field-label", __("Scope")),
    element("strong", "scope-summary-value", __("All monitored interfaces")),
  );
  const groupField = element("label", "control-field group-field");
  groupField.append(element("span", "field-label", __("Metric profile")));
  const groupSelect = element("select", "control-select");
  groupSelect.setAttribute("aria-label", __("Metric profile"));
  groupField.append(groupSelect);
  const entityField = element("label", "control-field entity-field");
  entityField.append(element("span", "field-label", __("Source")));
  const entitySelect = element("select", "control-select");
  entitySelect.setAttribute("aria-label", __("Selected source"));
  entityField.append(entitySelect);
  const activeOnlyLabel = element("label", "filter-toggle");
  const activeOnlyInput = element("input");
  activeOnlyInput.type = "checkbox";
  activeOnlyLabel.append(activeOnlyInput, element("span", "", __("Operational only")));
  sourceControls.append(scopeSummary, groupField, entityField, activeOnlyLabel);

  const rangeField = element("div", "control-field range-field");
  rangeField.append(element("span", "field-label", __("Time range")));
  const ranges = element("div", "range-options");
  rangeField.append(ranges);

  const updateControls = element("div", "update-controls");
  const refreshControls = element("div", "refresh-controls");
  const autoRefreshSelect = element("select", "compact-select");
  autoRefreshSelect.setAttribute("aria-label", __("Automatic refresh interval"));
  for (const option of REFRESH_OPTIONS) {
    const node = element("option", "", option.value === 0 ? __("Off") : option.label);
    node.value = String(option.value);
    autoRefreshSelect.append(node);
  }
  const pauseButton = element("button", "button secondary compact", __("Pause"));
  pauseButton.type = "button";
  pauseButton.setAttribute("aria-pressed", "false");
  refreshControls.append(
    element("span", "refresh-label", __("Auto")),
    autoRefreshSelect,
    pauseButton,
  );
  const refreshButton = element("button", "button primary", __("Refresh"));
  refreshButton.type = "button";
  updateControls.append(refreshControls, refreshButton);
  controlBar.append(sourceControls, rangeField, updateControls);

  const overviewView = element("section", "dashboard-view overview-view");
  const overviewHeading = element("header", "view-heading");
  const overviewHeadingCopy = element("div");
  overviewHeadingCopy.append(
    element("div", "eyebrow", __("Operational posture")),
    element("h2", "view-title", __("Network overview")),
    element(
      "p",
      "view-subtitle",
      __("Interface state, capacity pressure and collection coverage for this equipment."),
    ),
  );
  const overviewFreshness = element("div", "freshness-indicator", __("Waiting for data"));
  overviewHeading.append(overviewHeadingCopy, overviewFreshness);
  const kpiGrid = element("div", "kpi-grid");
  const overviewGrid = element("div", "overview-grid");
  const rankingPanel = element("section", "overview-panel ranking-panel");
  const rankingHeading = element("header", "panel-heading");
  const rankingHeadingCopy = element("div");
  rankingHeadingCopy.append(
    element("h3", "panel-title", __("Capacity pressure")),
    element("p", "panel-subtitle", __("Top interfaces by P95 utilization in the selected period.")),
  );
  rankingHeading.append(rankingHeadingCopy, element("span", "panel-tag", "P95"));
  const rankingChartNode = element("div", "ranking-chart");
  rankingChartNode.setAttribute("role", "img");
  rankingChartNode.setAttribute("aria-label", __("Top interfaces by P95 utilization"));
  rankingPanel.append(rankingHeading, rankingChartNode);
  const attentionPanel = element("section", "overview-panel attention-panel");
  const attentionHeading = element("header", "panel-heading");
  const attentionHeadingCopy = element("div");
  attentionHeadingCopy.append(
    element("h3", "panel-title", __("Needs attention")),
    element(
      "p",
      "panel-subtitle",
      __("Down links, configured limit violations and missing measurements."),
    ),
  );
  const attentionCount = element("span", "attention-count", "0");
  attentionHeading.append(attentionHeadingCopy, attentionCount);
  const attentionList = element("div", "attention-list");
  attentionPanel.append(attentionHeading, attentionList);
  overviewGrid.append(rankingPanel, attentionPanel);
  overviewView.append(overviewHeading, kpiGrid, overviewGrid);

  const interfacesView = element("section", "dashboard-view interfaces-view");
  const interfacesHeading = element("header", "view-heading interfaces-heading");
  const interfacesHeadingCopy = element("div");
  interfacesHeadingCopy.append(
    element("div", "eyebrow", __("Interface inventory")),
    element("h2", "view-title", __("Interfaces")),
    element(
      "p",
      "view-subtitle",
      __("Compare state, capacity and current traffic before opening a detailed analysis."),
    ),
  );
  const interfaceFilters = element("div", "interface-filters");
  const interfaceSearch = element("input", "interface-search");
  interfaceSearch.type = "search";
  interfaceSearch.placeholder = __("Search interface or description");
  interfaceSearch.setAttribute("aria-label", __("Search interfaces"));
  const interfaceStatusFilter = element("select", "table-filter-select");
  interfaceStatusFilter.setAttribute("aria-label", __("Filter interface status"));
  for (const [value, label] of [
    ["all", __("All states")],
    ["up", __("Operational")],
    ["down", __("Down")],
    ["disabled", __("Disabled")],
    ["unknown", __("Unknown")],
  ] as const) {
    const option = element("option", "", label);
    option.value = value;
    interfaceStatusFilter.append(option);
  }
  interfaceFilters.append(interfaceSearch, interfaceStatusFilter);
  interfacesHeading.append(interfacesHeadingCopy, interfaceFilters);
  const interfaceTableShell = element("div", "interface-table-shell");
  const interfaceTable = element("table", "interface-table");
  const interfaceTableHead = element("thead");
  const interfaceTableHeadRow = element("tr");
  for (const label of [
    __("Status"),
    __("Interface"),
    __("Capacity"),
    __("Traffic in"),
    __("Traffic out"),
    __("P95 load"),
    __("Signals"),
    __("Action"),
  ]) {
    const cell = element("th");
    if (label === __("Action")) cell.append(element("span", "sr-only", label));
    else cell.textContent = label;
    interfaceTableHeadRow.append(cell);
  }
  interfaceTableHead.append(interfaceTableHeadRow);
  interfaceTable.append(interfaceTableHead);
  const interfaceTableBody = element("tbody");
  interfaceTable.append(interfaceTableBody);
  interfaceTableShell.append(interfaceTable);
  interfacesView.append(interfacesHeading, interfaceTableShell);

  const detailView = element("section", "dashboard-view detail-view");

  const toolbar = element("div", "toolbar");
  const signalContext = element("section", "signal-context");
  const contextIdentity = element("div", "context-identity");
  const contextPath = element("div", "context-path", __("Selected source"));
  const contextTitleRow = element("div", "context-title-row");
  const contextTitle = element("h2", "context-title");
  const favoriteButton = element("button", "favorite-button", "☆");
  favoriteButton.type = "button";
  favoriteButton.title = __("Add interface to favorites");
  favoriteButton.setAttribute("aria-label", __("Add interface to favorites"));
  contextTitleRow.append(contextTitle, favoriteButton);
  const contextDescription = element("p", "context-description");
  contextIdentity.append(contextPath, contextTitleRow, contextDescription);
  const contextFacts = element("dl", "context-facts");
  const entityStatus = element("span", "entity-status");
  signalContext.append(contextIdentity, contextFacts, entityStatus);
  toolbar.append(signalContext);

  const metricPanel = element("section", "metric-panel");
  const metricPanelHeader = element("div", "metric-panel-header");
  const presetOptions = element("div", "preset-options");
  const viewIntro = element("div", "view-intro");
  const viewEyebrow = element("div", "section-label");
  const viewDescription = element("p", "view-description");
  viewIntro.append(viewEyebrow, viewDescription);
  metricPanelHeader.append(presetOptions, viewIntro);
  const metricOptions = element("div", "metric-options");
  metricPanel.append(metricPanelHeader);

  const chartCard = element("section", "chart-card");
  const chartHeader = element("div", "chart-header");
  const chartHeading = element("div", "chart-heading");
  const chartTitle = element("h3", "chart-title", __("Performance history"));
  const chartSubtitle = element("p", "chart-subtitle", __("Recorded measurements"));
  chartHeading.append(chartTitle, chartSubtitle);
  const status = element("div", "query-status", __("Ready"));
  chartHeader.append(chartHeading, metricOptions, status);
  const alertBanner = element("div", "alert-banner");
  alertBanner.hidden = true;
  alertBanner.setAttribute("role", "status");
  const seriesSummary = element("div", "series-summary");
  const chartFrame = element("div", "chart-frame");
  const chartNode = element("div", "chart");
  chartNode.setAttribute("role", "img");
  chartNode.setAttribute("aria-label", __("Performance history chart"));
  const chartState = element("section", "chart-state");
  chartState.hidden = true;
  const chartStateMark = element("span", "chart-state-mark");
  const chartStateCopy = element("div", "chart-state-copy");
  const chartStateTitle = element("strong", "chart-state-title");
  const chartStateDetail = element("p", "chart-state-detail");
  chartStateCopy.append(chartStateTitle, chartStateDetail);
  const chartStateAction = element("button", "button secondary chart-state-action", __("Try again"));
  chartStateAction.type = "button";
  chartState.append(chartStateMark, chartStateCopy, chartStateAction);
  chartFrame.append(chartNode, chartState);
  chartCard.append(toolbar, metricPanel, chartHeader, alertBanner, seriesSummary, chartFrame);
  detailView.append(chartCard);
  content.append(viewNav, controlBar, overviewView, interfacesView, detailView);
  workspace.append(content);
  app.append(header, workspace);

  const chart = echarts.init(chartNode, undefined, {renderer: "canvas"});
  const rankingChart = echarts.init(rankingChartNode, undefined, {renderer: "canvas"});
  new ResizeObserver(() => chart.resize()).observe(chartNode);
  new ResizeObserver(() => rankingChart.resize()).observe(rankingChartNode);

  type DashboardScreen = "overview" | "interfaces" | "detail";

  const interfaceGroup = manifest.groups.find((group) => group.kind === "interface");
  const availableSummaryMetrics = interfaceGroup ? summaryMetrics(interfaceGroup) : [];
  let activeScreen: DashboardScreen = interfaceGroup ? "overview" : "detail";
  let activeGroup = (interfaceGroup ?? manifest.groups[0]) as DashboardGroup;
  let activeEntity = activeGroup.entities[0] as DashboardEntity;
  let activeView: MetricView = defaultMetricView(metricsForEntity(activeGroup, activeEntity));
  let selectedMetricIds = new Set(
    metricsForView(metricsForEntity(activeGroup, activeEntity), activeView),
  );
  let viewPinned = false;
  let rangeMs = RANGE_OPTIONS[0].value;
  let requestNumber = 0;
  let summaryRequestNumber = 0;
  let dashboardSummary: DashboardSummary | null = null;
  let activeOnly = false;
  let refreshTimer: number | undefined;
  let refreshIntervalMs = Number(localStorage.getItem("noc:dashboard:refresh")) || 60_000;
  let refreshPaused = false;
  const favoriteKey = `noc:dashboard:favorites:${manifest.object.id}`;
  let favorites = new Set<string>();
  try {
    favorites = new Set(JSON.parse(localStorage.getItem(favoriteKey) ?? "[]") as string[]);
  } catch {
    favorites = new Set();
  }
  autoRefreshSelect.value = String(refreshIntervalMs);

  function updateControlVisibility(): void {
    const isDetail = activeScreen === "detail";
    scopeSummary.hidden = isDetail;
    groupField.hidden = !isDetail || manifest.groups.length < 2;
    entityField.hidden = !isDetail;
    activeOnlyLabel.hidden = !isDetail || activeGroup.kind !== "interface";
  }

  function setScreen(screen: DashboardScreen): void {
    const screenChanged = activeScreen !== screen;
    activeScreen = screen;
    for (const [button, value] of [
      [overviewButton, "overview"],
      [interfacesButton, "interfaces"],
      [analysisButton, "detail"],
    ] as const) {
      const selected = value === screen;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-current", selected ? "page" : "false");
    }
    overviewView.hidden = screen !== "overview";
    interfacesView.hidden = screen !== "interfaces";
    detailView.hidden = screen !== "detail";
    updateControlVisibility();
    if (screenChanged) window.scrollTo(0, 0);
    requestAnimationFrame(() => {
      if (screen === "overview") rankingChart.resize();
      if (screen === "detail") chart.resize();
    });
  }

  function setChartState(
    kind: "hidden" | "loading" | "empty" | "error",
    title = "",
    detail = "",
    retry = false,
  ): void {
    chartState.hidden = kind === "hidden";
    chartState.className = `chart-state ${kind}`;
    chartStateTitle.textContent = title;
    chartStateDetail.textContent = detail;
    chartStateAction.hidden = !retry;
    chartState.setAttribute("role", kind === "error" ? "alert" : "status");
    chartFrame.classList.toggle("has-state", kind !== "hidden");
    chartNode.setAttribute("aria-busy", String(kind === "loading"));
  }

  function activateEntity(entity: DashboardEntity, preserveView: boolean): void {
    activeEntity = entity;
    const availableMetrics = metricsForEntity(activeGroup, activeEntity);
    const availableViews = new Set(availableMetrics.map((metric) => metricView(metric)));
    const canPreserveView =
      preserveView &&
      viewPinned &&
      (activeView === "all" ? availableMetrics.length > 1 : availableViews.has(activeView));
    if (!canPreserveView) {
      activeView = defaultMetricView(availableMetrics);
    }
    selectedMetricIds = new Set(metricsForView(availableMetrics, activeView));
  }

  function saveFavorites(): void {
    localStorage.setItem(favoriteKey, JSON.stringify([...favorites]));
  }

  function scheduleRefresh(): void {
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    refreshTimer = undefined;
    if (!refreshIntervalMs || refreshPaused || document.hidden) return;
    refreshTimer = window.setTimeout(() => void refresh(), refreshIntervalMs);
  }

  function setAlert(state: MonitorState, message: string): void {
    alertBanner.className = `alert-banner ${state}`;
    alertBanner.textContent = message;
    alertBanner.hidden = state === "normal";
  }

  function renderSeriesSummary(series: TimeSeries[]): void {
    seriesSummary.replaceChildren();
    const states = new Set<MonitorState>();
    for (const [index, item] of series.entries()) {
      const statistics = seriesStatistics(item.points);
      if (!statistics) continue;
      const unit = item.unit.label || item.unit.code;
      const {current, average, peak} = statistics;
      const capacity = capacityForSeries(item, activeEntity);
      const utilization = capacity > 0 ? (current / capacity) * 100 : null;
      const metricInterval =
        activeEntity.metric_intervals[item.metric_id] ??
        activeGroup.metrics.find((metric) => metric.id === item.metric_id)?.interval ??
        null;
      const stale = seriesIsStale(item, metricInterval, Date.now());
      const metric = activeGroup.metrics.find((candidate) => candidate.id === item.metric_id);
      const thresholds = activeEntity.metric_thresholds?.[item.metric_id] ?? [];
      const matchedThreshold = thresholds.find((threshold) =>
        thresholdMatches(current, threshold),
      );
      const severity = matchedThreshold?.severity?.toLowerCase() ?? "";
      const cardState: MonitorState = stale
        ? "stale"
        : matchedThreshold
          ? severity.includes("critical") || severity.includes("major")
            ? "critical"
            : "warning"
          : "normal";
      states.add(cardState);
      const card = element(
        "article",
        `summary-card ${cardState} ${metricDomainClass(metric?.category)}`,
      );
      card.style.setProperty(
        "--series-color",
        SERIES_PALETTE[index % SERIES_PALETTE.length] ?? "#5b8def",
      );
      const heading = element("div", "summary-heading");
      heading.append(
        element("span", "summary-dot"),
        element("span", "summary-name", seriesDisplayName(item, series)),
      );
      if (utilization !== null) {
        heading.append(element("span", `utilization-badge ${cardState}`, `${utilization.toFixed(1)}%`));
      } else if (stale) {
        heading.append(element("span", "utilization-badge stale", __("Delayed")));
      }
      const currentValue = element(
        "strong",
        "summary-current",
        formatMetricValueWithUnit(current, unit),
      );
      const detail = element("div", "summary-detail");
      detail.append(
        element("span", "", `${__("Average")} ${formatMetricValueWithUnit(average, unit)}`),
        element("span", "", `${__("Peak")} ${formatMetricValueWithUnit(peak, unit)}`),
      );
      card.append(heading, currentValue);
      if (utilization !== null) {
        const utilizationBar = element("div", "utilization-bar");
        const utilizationFill = element("span", `utilization-fill ${cardState}`);
        utilizationFill.style.width = `${Math.min(100, Math.max(0, utilization))}%`;
        utilizationBar.append(utilizationFill);
        card.append(utilizationBar);
      }
      card.append(detail);
      if (thresholds.length) {
        const thresholdDetail = element("div", "summary-threshold");
        thresholdDetail.append(
          element("span", "summary-threshold-label", __("Configured limits")),
          element("span", "summary-threshold-value", formatThresholds(thresholds, unit)),
        );
        thresholdDetail.title = thresholds.map((threshold) => threshold.rule_name).join(" · ");
        card.append(thresholdDetail);
      }
      seriesSummary.append(card);
    }
    seriesSummary.hidden = seriesSummary.childElementCount === 0;
    if (activeEntity.oper_status === false) {
      setAlert("critical", __("Interface is down. Historical data remains available."));
    } else if (seriesSummary.childElementCount === 0) {
      setAlert("no-data", __("No measurements are available for this view and time range."));
    } else if (states.has("critical")) {
      setAlert("critical", __("A configured critical metric limit has been crossed."));
    } else if (states.has("warning")) {
      setAlert("warning", __("A configured metric limit has been crossed."));
    } else if (states.has("stale")) {
      setAlert("stale", __("Data collection is delayed for one or more metrics."));
    } else {
      setAlert("normal", "");
    }
  }

  function renderKpi(
    label: string,
    value: string,
    detail: string,
    state: "neutral" | "positive" | "negative" | "informative" = "neutral",
  ): HTMLElement {
    const card = element("article", `kpi-card ${state}`);
    card.append(
      element("span", "kpi-label", label),
      element("strong", "kpi-value", value),
      element("span", "kpi-detail", detail),
    );
    return card;
  }

  function openInterfaceAnalysis(entityId: string): void {
    if (!interfaceGroup) return;
    const entity = interfaceGroup.entities.find((item) => item.id === entityId);
    if (!entity) return;
    activeGroup = interfaceGroup;
    viewPinned = false;
    activeOnly = false;
    activeOnlyInput.checked = false;
    activateEntity(entity, false);
    renderGroups();
    renderPresets();
    renderEntities();
    renderMetrics();
    setScreen("detail");
    void refresh();
  }

  function renderOverview(summary: DashboardSummary): void {
    const {inventory} = summary;
    const operationalPercentage = inventory.total
      ? (inventory.operational / inventory.total) * 100
      : 0;
    const reporting = summary.entities.filter((entity) => Object.keys(entity.values).length).length;
    kpiGrid.replaceChildren(
      renderKpi(__("Interfaces"), inventory.total.toLocaleString(), __("Inventory sources")),
      renderKpi(
        __("Operational"),
        inventory.operational.toLocaleString(),
        `${formatPercentage(operationalPercentage)} ${__("of inventory")}`,
        "positive",
      ),
      renderKpi(
        __("Down"),
        inventory.down.toLocaleString(),
        inventory.down ? __("Requires attention") : __("No down interfaces"),
        inventory.down ? "negative" : "positive",
      ),
      renderKpi(
        __("Disabled"),
        (inventory.disabled ?? 0).toLocaleString(),
        __("Administratively disabled"),
      ),
      renderKpi(
        __("Reporting"),
        reporting.toLocaleString(),
        `${formatPercentage(inventory.total ? (reporting / inventory.total) * 100 : 0)} ${__("with data")}`,
        "informative",
      ),
      renderKpi(
        __("Optical telemetry"),
        inventory.optical.toLocaleString(),
        __("DOM-capable interfaces"),
        "informative",
      ),
    );

    const ranked = rankInterfaces(summary.entities, availableSummaryMetrics, 10);
    const hasRankedValues = ranked.some((entity) =>
      availableSummaryMetrics.some(
        (metric) => metric.category === "traffic" && utilizationFor(entity, metric, "p95") !== null,
      ),
    );
    rankingPanel.classList.toggle("is-empty", !hasRankedValues);
    rankingChartNode.dataset.empty = __("No capacity-based traffic samples in this period.");
    if (hasRankedValues) {
      rankingChart.setOption(
        buildInterfaceRankingOption(summary.entities, availableSummaryMetrics),
        true,
      );
    } else {
      rankingChart.clear();
    }

    const attention: Array<{
      entity: SummaryEntity;
      state: "critical" | "warning" | "missing";
      title: string;
      detail: string;
    }> = [];
    for (const entity of summary.entities) {
      if (entity.admin_status === false) continue;
      if (entity.oper_status === false) {
        attention.push({
          entity,
          state: "critical",
          title: entity.label,
          detail: __("Interface is down"),
        });
        continue;
      }
      let hasRuleViolation = false;
      for (const metric of availableSummaryMetrics) {
        const reduction = entity.values[metric.id];
        if (!reduction) continue;
        const threshold = (entity.metric_thresholds[metric.id] ?? []).find((item) =>
          thresholdMatches(reduction.current, item),
        );
        if (!threshold) continue;
        const severity = threshold.severity?.toLowerCase() ?? "";
        attention.push({
          entity,
          state: severity.includes("critical") || severity.includes("major") ? "critical" : "warning",
          title: entity.label,
          detail: `${compactMetricName(metric.name)} ${__("crossed")} ${threshold.op} ${formatMetricValueWithUnit(
            threshold.value,
            metric.unit.label || metric.unit.code,
          )}`,
        });
        hasRuleViolation = true;
        break;
      }
      if (!hasRuleViolation && Object.keys(entity.values).length === 0) {
        attention.push({
          entity,
          state: "missing",
          title: entity.label,
          detail: __("No samples in the selected period"),
        });
      }
    }
    attention.sort((left, right) => {
      const order = {critical: 0, warning: 1, missing: 2};
      return order[left.state] - order[right.state] || left.title.localeCompare(right.title);
    });
    attentionCount.textContent = attention.length.toLocaleString();
    attentionList.replaceChildren();
    if (!attention.length) {
      const empty = element("div", "attention-empty");
      empty.append(
        element("span", "attention-empty-mark", "✓"),
        element("strong", "", __("No active findings")),
        element("span", "", __("No down links or configured metric limits were detected.")),
      );
      attentionList.append(empty);
    } else {
      for (const item of attention.slice(0, 8)) {
        const action = element("button", `attention-item ${item.state}`);
        action.type = "button";
        const copy = element("span", "attention-copy");
        copy.append(element("strong", "", item.title), element("span", "", item.detail));
        action.append(element("span", "attention-mark"), copy, element("span", "attention-arrow", "→"));
        action.addEventListener("click", () => openInterfaceAnalysis(item.entity.id));
        attentionList.append(action);
      }
    }

    overviewFreshness.textContent = summary.latest_ts
      ? `${__("Latest sample")} ${formatTimestamp(summary.latest_ts)}`
      : __("No samples in this period");
    overviewFreshness.className = `freshness-indicator ${summary.latest_ts ? "current" : "empty"}`;
    overviewView.classList.remove("loading", "error");
  }

  function renderInterfaceTable(summary: DashboardSummary): void {
    const query = interfaceSearch.value.trim().toLowerCase();
    const statusFilter = interfaceStatusFilter.value;
    const inbound = metricForDirection(availableSummaryMetrics, "traffic", "in");
    const outbound = metricForDirection(availableSummaryMetrics, "traffic", "out");
    const filtered = summary.entities
      .filter((entity) => {
        const matchesQuery =
          !query ||
          entity.label.toLowerCase().includes(query) ||
          entity.description.toLowerCase().includes(query);
        const matchesStatus =
          statusFilter === "all" ||
          (statusFilter === "up" &&
            entity.admin_status !== false &&
            entity.oper_status === true) ||
          (statusFilter === "down" &&
            entity.admin_status !== false &&
            entity.oper_status === false) ||
          (statusFilter === "disabled" && entity.admin_status === false) ||
          (statusFilter === "unknown" &&
            entity.admin_status !== false &&
            entity.oper_status === null);
        return matchesQuery && matchesStatus;
      })
      .sort((left, right) => {
        const stateOrder = (entity: SummaryEntity): number => {
          if (entity.admin_status === false) return 3;
          if (entity.oper_status === false) return 0;
          if (entity.oper_status === null) return 1;
          return 2;
        };
        const leftState = stateOrder(left);
        const rightState = stateOrder(right);
        return leftState - rightState || left.label.localeCompare(right.label);
      });
    interfaceTableBody.replaceChildren();
    if (!filtered.length) {
      const row = element("tr", "table-state-row");
      const cell = element("td", "table-state-cell", __("No interfaces match the current filters."));
      cell.colSpan = 8;
      row.append(cell);
      interfaceTableBody.append(row);
      return;
    }
    for (const entity of filtered) {
      const row = element("tr");
      const statusCell = element("td");
      const statusName =
        entity.admin_status === false
          ? __("Disabled")
          : entity.oper_status === true
            ? __("Operational")
            : entity.oper_status === false
              ? __("Down")
              : __("Unknown");
      const statusClass =
        entity.admin_status === false
          ? "disabled"
          : entity.oper_status === true
            ? "up"
            : entity.oper_status === false
              ? "down"
              : "unknown";
      statusCell.append(
        element(
          "span",
          `table-status ${statusClass}`,
          statusName,
        ),
      );
      const nameCell = element("td", "interface-name-cell");
      nameCell.append(
        element("strong", "interface-name", entity.label),
        element("span", "interface-description", entity.description || __("No description")),
      );
      const capacity = Math.max(entity.capacity.in_bps, entity.capacity.out_bps);
      const utilization = Math.max(
        utilizationFor(entity, inbound, "p95") ?? 0,
        utilizationFor(entity, outbound, "p95") ?? 0,
      );
      const utilizationCell = element("td", "utilization-cell");
      const utilizationValue =
        utilizationFor(entity, inbound, "p95") === null &&
        utilizationFor(entity, outbound, "p95") === null
          ? null
          : utilization;
      utilizationCell.append(element("strong", "utilization-value", formatPercentage(utilizationValue)));
      if (utilizationValue !== null) {
        const bar = element("span", "table-utilization-bar");
        const fill = element("span", "table-utilization-fill");
        fill.style.width = `${Math.min(100, utilizationValue)}%`;
        bar.append(fill);
        utilizationCell.append(bar);
      }
      const signalsCell = element("td", "signals-cell");
      for (const capability of entity.capabilities.slice(0, 3)) {
        signalsCell.append(element("span", `signal-tag ${metricDomainClass(capability)}`, metricViewLabel(capability)));
      }
      const actionCell = element("td", "table-action-cell");
      const action = element("button", "table-action", __("Analyze"));
      action.type = "button";
      action.addEventListener("click", () => openInterfaceAnalysis(entity.id));
      actionCell.append(action);
      row.append(
        statusCell,
        nameCell,
        element("td", "numeric-cell", formatCapacity(capacity)),
        element("td", "numeric-cell", summaryMetricValue(entity, inbound)),
        element("td", "numeric-cell", summaryMetricValue(entity, outbound)),
        utilizationCell,
        signalsCell,
        actionCell,
      );
      interfaceTableBody.append(row);
    }
  }

  function renderSummaryLoading(): void {
    overviewFreshness.textContent = dashboardSummary ? __("Updating…") : __("Loading inventory…");
    overviewFreshness.className = "freshness-indicator loading";
    if (dashboardSummary) return;
    overviewView.classList.add("loading");
    kpiGrid.replaceChildren(
      ...Array.from({length: 6}, () => element("div", "kpi-card kpi-skeleton")),
    );
    rankingPanel.classList.add("is-loading");
    const row = element("tr", "table-state-row");
    const cell = element("td", "table-state-cell", __("Loading interface summary…"));
    cell.colSpan = 8;
    row.append(cell);
    interfaceTableBody.replaceChildren(row);
  }

  function renderSummaryError(message: string): void {
    overviewFreshness.textContent = __("Update failed");
    overviewFreshness.className = "freshness-indicator error";
    if (dashboardSummary) return;
    overviewView.classList.remove("loading");
    overviewView.classList.add("error");
    kpiGrid.replaceChildren(
      renderKpi(
        __("Summary unavailable"),
        "—",
        __("The detailed analysis remains available."),
        "negative",
      ),
    );
    attentionList.replaceChildren(element("div", "attention-empty error", message));
    const row = element("tr", "table-state-row error");
    const cell = element("td", "table-state-cell", message);
    cell.colSpan = 8;
    row.append(cell);
    interfaceTableBody.replaceChildren(row);
  }

  function renderGroups(): void {
    groupSelect.replaceChildren();
    for (const group of manifest.groups) {
      const module = manifest.modules.find((item) => item.id === group.module_id);
      const groupHeading =
        module && module.group_ids.length > 1 ? group.title : (module?.title ?? group.title);
      const option = element("option");
      option.value = group.id;
      const sourceLabel = group.entities.length === 1 ? __("source") : __("sources");
      option.textContent = `${groupHeading} · ${group.entities.length} ${sourceLabel}`;
      option.selected = group.id === activeGroup.id;
      groupSelect.append(option);
    }
    updateControlVisibility();
  }

  function renderPresets(): void {
    presetOptions.replaceChildren();
    const availableMetrics = metricsForEntity(activeGroup, activeEntity);
    const categoryViews = [...new Set(availableMetrics.map((metric) => metricView(metric)))];
    const views: MetricView[] =
      availableMetrics.length > 1 ? ["all", ...categoryViews] : categoryViews;
    for (const view of views) {
      const button = element("button", "preset-button", metricViewLabel(view));
      button.type = "button";
      button.classList.toggle("active", view === activeView);
      button.setAttribute("aria-pressed", String(view === activeView));
      button.addEventListener("click", () => {
        activeView = view;
        viewPinned = true;
        selectedMetricIds = new Set(metricsForView(availableMetrics, view));
        renderPresets();
        renderMetrics();
        void refresh();
      });
      presetOptions.append(button);
    }
    const content = viewContent()[activeView];
    viewEyebrow.textContent = content.eyebrow;
    viewDescription.textContent = content.description;
    chartTitle.textContent = content.title;
    chartSubtitle.textContent = `${activeEntity.label} · ${metricViewLabel(activeView)} ${__("history")}`;
  }

  function renderEntities(): void {
    const filtered = activeGroup.entities
      .filter((entity) => !activeOnly || entity.oper_status === true)
      .sort((left, right) => {
        const favoriteDifference = Number(favorites.has(right.id)) - Number(favorites.has(left.id));
        return favoriteDifference || left.label.localeCompare(right.label);
      });
    const entityChanged =
      !filtered.some((entity) => entity.id === activeEntity.id) && Boolean(filtered[0]);
    if (entityChanged && filtered[0]) {
      activateEntity(filtered[0], true);
      renderPresets();
      renderMetrics();
    }
    entitySelect.replaceChildren();
    for (const entity of filtered) {
      const option = element("option");
      option.value = entity.id;
      const favorite = favorites.has(entity.id) ? "★ " : "";
      option.textContent = entity.description
        ? `${favorite}${entity.label} — ${entity.description}`
        : `${favorite}${entity.label}`;
      option.selected = entity.id === activeEntity.id;
      entitySelect.append(option);
    }
    entitySelect.disabled = filtered.length === 0;
    const isInterface = activeGroup.kind === "interface";
    activeOnlyLabel.hidden = activeScreen !== "detail" || !isInterface;
    favoriteButton.hidden = !isInterface;
    const moduleTitle =
      manifest.modules.find((item) => item.id === activeGroup.module_id)?.title ?? activeGroup.title;
    contextPath.textContent =
      moduleTitle === activeGroup.title ? moduleTitle : `${moduleTitle} / ${activeGroup.title}`;
    contextTitle.textContent = filtered.length ? activeEntity.label : __("No matching entities");
    contextDescription.textContent = filtered.length
      ? activeEntity.description || __("No inventory description")
      : __("Adjust the entity filters to continue.");
    contextFacts.replaceChildren();
    if (filtered.length) {
      const facts = [
        [__("Capacity"), formatCapacity(Math.max(activeEntity.capacity.in_bps, activeEntity.capacity.out_bps))],
        [
          __("Admin"),
          activeEntity.admin_status === null
            ? __("N/A")
            : activeEntity.admin_status
              ? __("Enabled")
              : __("Disabled"),
        ],
        [
          __("Duplex"),
          activeEntity.full_duplex === null
            ? __("N/A")
            : activeEntity.full_duplex
              ? __("Full")
              : __("Half"),
        ],
        [__("Signals"), activeEntity.capabilities.map((item) => metricViewLabel(item)).join(" / ")],
      ];
      for (const [label, value] of facts) {
        const fact = element("div", "context-fact");
        fact.append(element("dt", "", label), element("dd", "", value));
        contextFacts.append(fact);
      }
    }
    entityStatus.textContent = filtered.length
      ? activeEntity.oper_status === true
        ? __("OPERATIONAL")
        : activeEntity.oper_status === false
          ? __("DOWN")
          : __("UNKNOWN")
      : __("NO MATCH");
    entityStatus.className = `entity-status ${
      !filtered.length ? "unknown" : activeEntity.oper_status === true ? "up" : "down"
    }`;
    favoriteButton.textContent = favorites.has(activeEntity.id) ? "★" : "☆";
    favoriteButton.classList.toggle("active", favorites.has(activeEntity.id));
    favoriteButton.title = favorites.has(activeEntity.id)
      ? __("Remove interface from favorites")
      : __("Add interface to favorites");
    favoriteButton.setAttribute("aria-label", favoriteButton.title);
    if (!filtered.length) {
      chart.clear();
      renderSeriesSummary([]);
      setAlert("no-data", __("No interfaces match the current search and status filters."));
      setChartState(
        "empty",
        __("No matching sources"),
        __("Change the search or include interfaces that are not operational."),
      );
      status.textContent = __("No matching interfaces");
    }
  }

  function renderMetrics(): void {
    metricOptions.replaceChildren();
    for (const metric of metricsForEntity(activeGroup, activeEntity)) {
      const label = element("label", "metric-chip");
      if (selectedMetricIds.has(metric.id)) label.classList.add("selected");
      label.title = metric.description || metric.name;
      const input = element("input");
      input.type = "checkbox";
      input.value = metric.id;
      input.checked = selectedMetricIds.has(metric.id);
      input.setAttribute("aria-label", compactMetricName(metric.name));
      const copy = element("span", "metric-copy");
      copy.append(element("strong", "metric-name", compactMetricName(metric.name)));
      copy.append(element("span", "metric-unit", metric.unit.label || metric.unit.code));
      label.append(input, copy);
      input.addEventListener("change", () => {
        if (input.checked) selectedMetricIds.add(metric.id);
        else selectedMetricIds.delete(metric.id);
        label.classList.toggle("selected", input.checked);
        void refresh();
      });
      metricOptions.append(label);
    }
  }

  function renderRanges(): void {
    ranges.replaceChildren();
    for (const option of RANGE_OPTIONS) {
      const button = element("button", "range-button", option.label);
      button.type = "button";
      button.classList.toggle("active", option.value === rangeMs);
      button.setAttribute("aria-pressed", String(option.value === rangeMs));
      button.addEventListener("click", () => {
        rangeMs = option.value;
        renderRanges();
        void refresh();
      });
      ranges.append(button);
    }
  }

  async function refreshDetail(): Promise<void> {
    const metricIds = [...selectedMetricIds];
    if (metricIds.length === 0) {
      chart.clear();
      renderSeriesSummary([]);
      setChartState(
        "empty",
        __("No signals selected"),
        __("Select one or more measurements above to draw the history."),
      );
      status.textContent = __("Waiting for a metric");
      scheduleRefresh();
      return;
    }
    const currentRequest = ++requestNumber;
    refreshButton.setAttribute("disabled", "");
    status.textContent = __("Loading…");
    status.className = "query-status loading";
    chart.clear();
    seriesSummary.hidden = true;
    setChartState(
      "loading",
      __("Loading measurements"),
      __("Reading the selected time range."),
    );
    const to = Date.now();
    const from = to - rangeMs;
    try {
      const query = buildMetricQuery(
        manifest.object.id,
        activeGroup,
        activeEntity,
        metricIds,
        from,
        to,
      );
      const response = await loadSeries(manifest.query.url, query);
      if (currentRequest !== requestNumber) return;
      renderSeriesSummary(response.series);
      if (response.series.length) {
        setChartState("hidden");
        chart.setOption(buildChartOption(response.series, response.from, response.to), true);
      } else {
        setChartState(
          "empty",
          __("No measurements in this period"),
          __("Collection is configured, but no samples were stored for the selected time range."),
        );
      }
      const points = response.series.reduce((total, item) => total + item.points.length, 0);
      const firstPoint = earliestSeriesTimestamp(response.series) ?? response.from;
      const coverage =
        firstPoint > response.from + response.interval * 2_000
          ? ` · ${__("data since")} ${new Intl.DateTimeFormat(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            }).format(firstPoint)}`
          : "";
      status.textContent = `${response.series.length} ${__("series")} · ${points.toLocaleString()} ${__("points")}${coverage}`;
      status.className = "query-status success";
      lastUpdated.textContent = `${__("Updated")} ${new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(Date.now())}`;
    } catch (error) {
      if (currentRequest !== requestNumber) return;
      const message = error instanceof Error ? error.message : __("Query failed");
      chart.clear();
      setChartState("error", __("Measurements unavailable"), message, true);
      status.textContent = __("Query failed");
      status.className = "query-status error";
    } finally {
      if (currentRequest === requestNumber) {
        refreshButton.removeAttribute("disabled");
        scheduleRefresh();
      }
    }
  }

  async function refreshSummary(): Promise<void> {
    if (!interfaceGroup) {
      setScreen("detail");
      await refreshDetail();
      return;
    }
    const currentRequest = ++summaryRequestNumber;
    refreshButton.setAttribute("disabled", "");
    renderSummaryLoading();
    const to = Date.now();
    const from = to - rangeMs;
    try {
      const response = await loadSummary(
        manifest.summary.url,
        manifest.object.id,
        interfaceGroup.id,
        availableSummaryMetrics.map((metric) => metric.id),
        from,
        to,
      );
      if (currentRequest !== summaryRequestNumber) return;
      dashboardSummary = response;
      renderOverview(response);
      renderInterfaceTable(response);
      rankingPanel.classList.remove("is-loading");
      lastUpdated.textContent = `${__("Updated")} ${formatTimestamp(Date.now())}`;
    } catch (error) {
      if (currentRequest !== summaryRequestNumber) return;
      renderSummaryError(
        error instanceof Error ? error.message : __("Unable to load interface summary."),
      );
    } finally {
      if (currentRequest === summaryRequestNumber) {
        refreshButton.removeAttribute("disabled");
        scheduleRefresh();
      }
    }
  }

  async function refresh(): Promise<void> {
    if (activeScreen === "detail") await refreshDetail();
    else await refreshSummary();
  }

  entitySelect.addEventListener("change", () => {
    const entity = activeGroup.entities.find((item) => item.id === entitySelect.value);
    if (!entity) return;
    activateEntity(entity, true);
    renderPresets();
    renderEntities();
    renderMetrics();
    void refresh();
  });
  groupSelect.addEventListener("change", () => {
    const group = manifest.groups.find((item) => item.id === groupSelect.value);
    if (!group) return;
    activeGroup = group;
    viewPinned = false;
    activeOnly = false;
    activeOnlyInput.checked = false;
    const firstEntity =
      group.entities.find((entity) => favorites.has(entity.id)) ??
      group.entities.find((entity) => entity.oper_status === true) ??
      group.entities[0];
    if (!firstEntity) return;
    activateEntity(firstEntity, false);
    renderGroups();
    renderPresets();
    renderEntities();
    renderMetrics();
    setScreen("detail");
    void refresh();
  });
  activeOnlyInput.addEventListener("change", () => {
    activeOnly = activeOnlyInput.checked;
    renderEntities();
    if (!entitySelect.disabled) void refresh();
  });
  favoriteButton.addEventListener("click", () => {
    if (favorites.has(activeEntity.id)) favorites.delete(activeEntity.id);
    else favorites.add(activeEntity.id);
    saveFavorites();
    renderEntities();
  });
  overviewButton.addEventListener("click", () => {
    if (!interfaceGroup) return;
    setScreen("overview");
    if (dashboardSummary) renderOverview(dashboardSummary);
    void refreshSummary();
  });
  interfacesButton.addEventListener("click", () => {
    if (!interfaceGroup) return;
    setScreen("interfaces");
    if (dashboardSummary) renderInterfaceTable(dashboardSummary);
    void refreshSummary();
  });
  analysisButton.addEventListener("click", () => {
    setScreen("detail");
    void refreshDetail();
  });
  interfaceSearch.addEventListener("input", () => {
    if (dashboardSummary) renderInterfaceTable(dashboardSummary);
  });
  interfaceStatusFilter.addEventListener("change", () => {
    if (dashboardSummary) renderInterfaceTable(dashboardSummary);
  });
  autoRefreshSelect.addEventListener("change", () => {
    refreshIntervalMs = Number(autoRefreshSelect.value);
    localStorage.setItem("noc:dashboard:refresh", String(refreshIntervalMs));
    pauseButton.toggleAttribute("disabled", refreshIntervalMs === 0);
    scheduleRefresh();
  });
  pauseButton.addEventListener("click", () => {
    refreshPaused = !refreshPaused;
    pauseButton.textContent = refreshPaused ? __("Resume") : __("Pause");
    pauseButton.classList.toggle("active", refreshPaused);
    pauseButton.setAttribute("aria-pressed", String(refreshPaused));
    scheduleRefresh();
  });
  refreshButton.addEventListener("click", () => void refresh());
  chartStateAction.addEventListener("click", () => void refresh());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !refreshPaused) void refresh();
    else scheduleRefresh();
  });

  renderGroups();
  renderPresets();
  renderEntities();
  renderMetrics();
  renderRanges();
  overviewButton.hidden = !interfaceGroup;
  interfacesButton.hidden = !interfaceGroup;
  setScreen(activeScreen);
  pauseButton.toggleAttribute("disabled", refreshIntervalMs === 0);
  await refresh();
}

async function initialize(): Promise<void> {
  await initializeI18n();
  document.title = __("NOC Performance");
  const bootMessage = document.querySelector<HTMLElement>(".boot-state span:last-child");
  if (bootMessage) bootMessage.textContent = __("Loading dashboard…");
  await start();
}

void initialize();
