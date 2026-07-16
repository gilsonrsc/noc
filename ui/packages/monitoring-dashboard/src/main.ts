import {LineChart} from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  ToolboxComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import {CanvasRenderer} from "echarts/renderers";
import {buildMetricQuery, loadManifest, loadSeries} from "./api";
import {
  buildChartOption,
  compactMetricName,
  formatMetricValueWithUnit,
  SERIES_PALETTE,
  seriesDisplayName,
} from "./chart";
import {
  capacityForSeries,
  defaultMetricView,
  metricView,
  metricViewLabel,
  metricsForEntity,
  metricsForView,
  seriesIsStale,
  utilizationState,
  type MetricView,
  type MonitorState,
} from "./state";
import type {
  DashboardEntity,
  DashboardGroup,
  DashboardManifest,
  MetricCategory,
  MetricThresholdDescriptor,
  TimeSeries,
} from "./types";
import "./styles.css";

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  ToolboxComponent,
  CanvasRenderer,
]);

const RANGE_OPTIONS = [
  {label: "1h", value: 60 * 60 * 1000},
  {label: "6h", value: 6 * 60 * 60 * 1000},
  {label: "24h", value: 24 * 60 * 60 * 1000},
  {label: "7d", value: 7 * 24 * 60 * 60 * 1000},
] as const;

const REFRESH_OPTIONS = [
  {label: "Off", value: 0},
  {label: "30s", value: 30_000},
  {label: "60s", value: 60_000},
  {label: "5m", value: 300_000},
] as const;

const VIEW_CONTENT: Record<MetricView, {eyebrow: string; title: string; description: string}> = {
  all: {
    eyebrow: "Selected signals",
    title: "Combined history",
    description: "Compare the selected measurements over the same period.",
  },
  traffic: {
    eyebrow: "Interface throughput",
    title: "Traffic",
    description: "Inbound and outbound load, compared with the interface capacity.",
  },
  errors: {
    eyebrow: "Packet integrity",
    title: "Errors and discards",
    description: "Interface errors, drops and discards recorded during the selected period.",
  },
  health: {
    eyebrow: "Device resources",
    title: "Health",
    description: "Resource usage, reachability and operating measurements for this device.",
  },
  environment: {
    eyebrow: "Environmental telemetry",
    title: "Environment",
    description: "Temperature, power and environmental measurements reported by the device.",
  },
  optical: {
    eyebrow: "Transceiver diagnostics",
    title: "Optical levels",
    description: "Receive and transmit power with the supporting transceiver diagnostics.",
  },
  radio: {
    eyebrow: "Radio telemetry",
    title: "Radio",
    description: "Signal, noise, power and radio link measurements.",
  },
  access: {
    eyebrow: "Access telemetry",
    title: "Access",
    description: "Subscriber access and physical line measurements.",
  },
  sla: {
    eyebrow: "Service assurance",
    title: "Service level",
    description: "Latency, jitter, loss and service-level measurements.",
  },
  subscribers: {
    eyebrow: "Subscriber sessions",
    title: "Subscribers",
    description: "Session counts and subscriber service measurements.",
  },
  storage: {
    eyebrow: "Storage resources",
    title: "Storage",
    description: "Filesystem, disk and storage utilization measurements.",
  },
  routing: {
    eyebrow: "Control plane",
    title: "Routing",
    description: "Routing, neighbor and control-plane measurements.",
  },
  other: {
    eyebrow: "Additional telemetry",
    title: "Other signals",
    description: "Measurements available for this source that do not belong to another view.",
  },
};

function requireElement<T extends Element>(node: T | null, message: string): T {
  if (!node) throw new Error(message);
  return node;
}

const app = requireElement(
  document.querySelector<HTMLElement>("#app"),
  "Dashboard root element is missing",
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
  card.append(element("h1", "fatal-title", "Dashboard unavailable"));
  card.append(element("p", "fatal-message", message));
  if (legacyUrl) {
    const link = element("a", "button secondary", "Open legacy Grafana");
    link.href = legacyUrl;
    card.append(link);
  }
  app.append(card);
}

function objectMeta(manifest: DashboardManifest): string[] {
  const details = [
    manifest.object.address,
    manifest.object.vendor,
    manifest.object.platform,
    manifest.object.version,
    manifest.object.pool,
  ];
  return details.filter((value): value is string => Boolean(value));
}

function formatCapacity(value: number): string {
  if (!value) return "Not reported";
  if (value >= 1_000_000_000) return `${value / 1_000_000_000} Gbps`;
  if (value >= 1_000_000) return `${value / 1_000_000} Mbps`;
  if (value >= 1_000) return `${value / 1_000} kbps`;
  return `${value} bps`;
}

function formatThresholds(thresholds: MetricThresholdDescriptor[], unit: string): string {
  return thresholds
    .map((threshold) => `${threshold.op} ${formatMetricValueWithUnit(threshold.value, unit)}`)
    .join(" · ");
}

function metricDomainClass(category: MetricCategory | undefined): string {
  return category ? `domain-${category}` : "domain-other";
}

async function start(): Promise<void> {
  const objectId = new URLSearchParams(window.location.search).get("id");
  if (!objectId) {
    renderFatal("No managed object was selected.");
    return;
  }

  let manifest: DashboardManifest;
  try {
    manifest = await loadManifest(objectId);
  } catch (error) {
    renderFatal(error instanceof Error ? error.message : "Unable to load dashboard metadata.");
    return;
  }
  if (manifest.groups.length === 0) {
    renderFatal("This object has no stored metrics configured.", manifest.legacy_url);
    return;
  }

  app.replaceChildren();
  const header = element("header", "dashboard-header");
  const identity = element("div", "identity");
  const eyebrow = element("div", "eyebrow", "Performance monitoring");
  const titleLine = element("div", "title-line");
  titleLine.append(element("span", "live-dot"), element("h1", "object-title", manifest.object.name));
  identity.append(eyebrow, titleLine, element("p", "object-meta", objectMeta(manifest).join(" · ")));
  const headerActions = element("div", "header-actions");
  const legacyLink = element("a", "button secondary legacy-link", "Grafana");
  legacyLink.href = manifest.legacy_url;
  legacyLink.target = "_blank";
  legacyLink.rel = "noopener";
  const refreshControls = element("div", "refresh-controls");
  const autoRefreshSelect = element("select", "compact-select");
  autoRefreshSelect.setAttribute("aria-label", "Automatic refresh interval");
  for (const option of REFRESH_OPTIONS) {
    const node = element("option", "", option.label);
    node.value = String(option.value);
    autoRefreshSelect.append(node);
  }
  const pauseButton = element("button", "button secondary compact", "Pause");
  pauseButton.type = "button";
  pauseButton.setAttribute("aria-pressed", "false");
  const lastUpdated = element("span", "last-updated", "Not updated yet");
  refreshControls.append(
    element("span", "refresh-label", "Auto"),
    autoRefreshSelect,
    pauseButton,
    lastUpdated,
  );
  const refreshButton = element("button", "button primary", "Refresh");
  refreshButton.type = "button";
  headerActions.append(refreshControls, legacyLink, refreshButton);
  header.append(identity, headerActions);

  const workspace = element("main", "workspace");
  const sidebar = element("aside", "sidebar");
  sidebar.append(element("div", "section-label", "Navigate"));
  const groupList = element("nav", "group-list");
  const explorer = element("section", "entity-explorer");
  const explorerHeader = element("div", "explorer-header");
  const explorerTitle = element("div", "section-label", "Sources");
  const entityCount = element("span", "entity-count", "0");
  explorerHeader.append(explorerTitle, entityCount);
  const entityTools = element("div", "entity-tools");
  const entitySearch = element("input", "entity-search");
  entitySearch.type = "search";
  entitySearch.placeholder = "Filter by name or description";
  entitySearch.setAttribute("aria-label", "Search interfaces");
  const activeOnlyLabel = element("label", "filter-toggle");
  const activeOnlyInput = element("input");
  activeOnlyInput.type = "checkbox";
  activeOnlyLabel.append(activeOnlyInput, element("span", "", "Operational only"));
  entityTools.append(entitySearch, activeOnlyLabel);
  const entityList = element("div", "entity-list");
  const entitySelect = element("select", "sr-only");
  entitySelect.setAttribute("aria-label", "Selected entity");
  explorer.append(explorerHeader, entityTools, entityList, entitySelect);
  sidebar.append(groupList, explorer);

  const content = element("section", "content");
  const toolbar = element("div", "toolbar");
  const signalContext = element("section", "signal-context");
  const contextIdentity = element("div", "context-identity");
  const contextPath = element("div", "context-path", "Selected source");
  const contextTitleRow = element("div", "context-title-row");
  const contextTitle = element("h2", "context-title");
  const favoriteButton = element("button", "favorite-button", "☆");
  favoriteButton.type = "button";
  favoriteButton.title = "Add interface to favorites";
  favoriteButton.setAttribute("aria-label", "Add interface to favorites");
  contextTitleRow.append(contextTitle, favoriteButton);
  const contextDescription = element("p", "context-description");
  contextIdentity.append(contextPath, contextTitleRow, contextDescription);
  const contextFacts = element("dl", "context-facts");
  const entityStatus = element("span", "entity-status");
  signalContext.append(contextIdentity, contextFacts, entityStatus);
  const rangeField = element("div", "field range-field");
  rangeField.append(element("span", "field-label", "Time range"));
  const ranges = element("div", "range-options");
  rangeField.append(ranges);
  toolbar.append(signalContext, rangeField);

  const metricPanel = element("section", "metric-panel");
  const metricPanelHeader = element("div", "metric-panel-header");
  const viewIntro = element("div", "view-intro");
  const viewEyebrow = element("div", "section-label");
  const viewDescription = element("p", "view-description");
  viewIntro.append(viewEyebrow, viewDescription);
  metricPanelHeader.append(viewIntro);
  const presetOptions = element("div", "preset-options");
  metricPanelHeader.append(presetOptions);
  const metricOptions = element("div", "metric-options");
  metricPanel.append(metricPanelHeader, metricOptions);

  const chartCard = element("section", "chart-card");
  const chartHeader = element("div", "chart-header");
  const chartHeading = element("div", "chart-heading");
  const chartTitle = element("h3", "chart-title", "Performance history");
  const chartSubtitle = element("p", "chart-subtitle", "Recorded measurements");
  chartHeading.append(chartTitle, chartSubtitle);
  const status = element("div", "query-status", "Ready");
  chartHeader.append(chartHeading, status);
  const alertBanner = element("div", "alert-banner");
  alertBanner.hidden = true;
  alertBanner.setAttribute("role", "status");
  const seriesSummary = element("div", "series-summary");
  const chartFrame = element("div", "chart-frame");
  const chartNode = element("div", "chart");
  const chartState = element("section", "chart-state");
  chartState.hidden = true;
  const chartStateMark = element("span", "chart-state-mark");
  const chartStateCopy = element("div", "chart-state-copy");
  const chartStateTitle = element("strong", "chart-state-title");
  const chartStateDetail = element("p", "chart-state-detail");
  chartStateCopy.append(chartStateTitle, chartStateDetail);
  const chartStateAction = element("button", "button secondary chart-state-action", "Try again");
  chartStateAction.type = "button";
  chartState.append(chartStateMark, chartStateCopy, chartStateAction);
  chartFrame.append(chartNode, chartState);
  chartCard.append(chartHeader, alertBanner, seriesSummary, chartFrame);
  content.append(toolbar, metricPanel, chartCard);
  workspace.append(sidebar, content);
  app.append(header, workspace);

  const chart = echarts.init(chartNode, undefined, {renderer: "canvas"});
  new ResizeObserver(() => chart.resize()).observe(chartNode);

  let activeGroup = manifest.groups[0] as DashboardGroup;
  let activeEntity = activeGroup.entities[0] as DashboardEntity;
  let activeView: MetricView = defaultMetricView(metricsForEntity(activeGroup, activeEntity));
  let selectedMetricIds = new Set(
    metricsForView(metricsForEntity(activeGroup, activeEntity), activeView),
  );
  let viewPinned = false;
  let rangeMs = RANGE_OPTIONS[0].value;
  let requestNumber = 0;
  let activeOnly = false;
  let refreshTimer: number | undefined;
  let searchTimer: number | undefined;
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
      const values = item.points.map((point) => point[1]).filter(Number.isFinite);
      if (values.length === 0) continue;
      const unit = item.unit.label || item.unit.code;
      const current = values[values.length - 1] as number;
      const average = values.reduce((total, value) => total + value, 0) / values.length;
      const peak = Math.max(...values);
      const capacity = capacityForSeries(item, activeEntity);
      const utilization = capacity > 0 ? (current / capacity) * 100 : null;
      const metricInterval =
        activeEntity.metric_intervals[item.metric_id] ??
        activeGroup.metrics.find((metric) => metric.id === item.metric_id)?.interval ??
        null;
      const stale = seriesIsStale(item, metricInterval, Date.now());
      const cardState = stale ? "stale" : utilizationState(utilization);
      states.add(cardState);
      const metric = activeGroup.metrics.find((candidate) => candidate.id === item.metric_id);
      const thresholds = activeEntity.metric_thresholds?.[item.metric_id] ?? [];
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
        heading.append(element("span", "utilization-badge stale", "Delayed"));
      }
      const currentValue = element(
        "strong",
        "summary-current",
        formatMetricValueWithUnit(current, unit),
      );
      const detail = element("div", "summary-detail");
      detail.append(
        element("span", "", `Average ${formatMetricValueWithUnit(average, unit)}`),
        element("span", "", `Peak ${formatMetricValueWithUnit(peak, unit)}`),
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
          element("span", "summary-threshold-label", "Configured limits"),
          element("span", "summary-threshold-value", formatThresholds(thresholds, unit)),
        );
        thresholdDetail.title = thresholds.map((threshold) => threshold.rule_name).join(" · ");
        card.append(thresholdDetail);
      }
      seriesSummary.append(card);
    }
    seriesSummary.hidden = seriesSummary.childElementCount === 0;
    if (activeEntity.oper_status === false) {
      setAlert("critical", "Interface is down. Historical data remains available.");
    } else if (seriesSummary.childElementCount === 0) {
      setAlert("no-data", "No measurements are available for this view and time range.");
    } else if (states.has("critical")) {
      setAlert("critical", "Critical utilization: one or more interfaces reached 90% capacity.");
    } else if (states.has("warning")) {
      setAlert("warning", "High utilization: one or more interfaces reached 70% capacity.");
    } else if (states.has("stale")) {
      setAlert("stale", "Data collection is delayed for one or more metrics.");
    } else {
      setAlert("normal", "");
    }
  }

  function renderGroups(): void {
    groupList.replaceChildren();
    for (const group of manifest.groups) {
      const module = manifest.modules.find((item) => item.id === group.module_id);
      const groupHeading =
        module && module.group_ids.length > 1 ? group.title : (module?.title ?? group.title);
      const button = element("button", "group-button");
      button.type = "button";
      if (group.id === activeGroup.id) button.classList.add("active");
      if (group.id === activeGroup.id) button.setAttribute("aria-current", "page");
      const labels = element("span", "group-label");
      labels.append(element("strong", "group-title", groupHeading));
      labels.append(
        element(
          "span",
          "group-detail",
          `${group.entities.length} ${group.entities.length === 1 ? "entity" : "entities"} / ${(module?.capabilities ?? []).map((item) => metricViewLabel(item)).join(" + ")}`,
        ),
      );
      const capabilityCount = module?.capabilities.length ?? group.metrics.length;
      button.append(labels, element("span", "group-count", String(capabilityCount).padStart(2, "0")));
      button.addEventListener("click", () => {
        activeGroup = group;
        viewPinned = false;
        const firstEntity =
          group.entities.find((entity) => favorites.has(entity.id)) ??
          group.entities.find((entity) => entity.oper_status === true) ??
          group.entities[0];
        if (!firstEntity) return;
        activateEntity(firstEntity, false);
        entitySearch.value = "";
        renderGroups();
        renderPresets();
        renderEntities();
        renderMetrics();
        void refresh();
      });
      groupList.append(button);
    }
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
    const content = VIEW_CONTENT[activeView];
    viewEyebrow.textContent = content.eyebrow;
    viewDescription.textContent = content.description;
    chartTitle.textContent = content.title;
    chartSubtitle.textContent = `${activeEntity.label} · ${metricViewLabel(activeView)} history`;
  }

  function renderEntities(): void {
    const search = entitySearch.value.trim().toLocaleLowerCase();
    const filtered = activeGroup.entities
      .filter((entity) => !activeOnly || entity.oper_status === true)
      .filter(
        (entity) =>
          !search ||
          entity.label.toLocaleLowerCase().includes(search) ||
          entity.description.toLocaleLowerCase().includes(search),
      )
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
    entityList.replaceChildren();
    for (const entity of filtered) {
      const option = element("option");
      option.value = entity.id;
      const favorite = favorites.has(entity.id) ? "★ " : "";
      option.textContent = entity.description
        ? `${favorite}${entity.label} — ${entity.description}`
        : `${favorite}${entity.label}`;
      option.selected = entity.id === activeEntity.id;
      entitySelect.append(option);
      const entityButton = element("button", "entity-row");
      entityButton.type = "button";
      entityButton.classList.toggle("active", entity.id === activeEntity.id);
      const stateMark = element(
        "span",
        `entity-state ${entity.oper_status === true ? "up" : entity.oper_status === false ? "down" : "unknown"}`,
      );
      const copy = element("span", "entity-row-copy");
      copy.append(element("strong", "entity-row-name", entity.label));
      copy.append(
        element(
          "span",
          "entity-row-description",
          entity.description || entity.status.split("/").join(" / "),
        ),
      );
      const speed = entity.status.split("/")[1] ?? "-";
      const rowMeta = element(
        "span",
        "entity-row-meta",
        entity.capabilities.includes("optical") ? `DOM · ${speed}` : speed,
      );
      entityButton.append(stateMark, copy, rowMeta);
      entityButton.addEventListener("click", () => {
        activateEntity(entity, true);
        renderPresets();
        renderEntities();
        renderMetrics();
        void refresh();
      });
      entityList.append(entityButton);
    }
    entityCount.textContent = `${filtered.length}/${activeGroup.entities.length}`;
    entitySelect.disabled = filtered.length === 0;
    const isInterface = activeGroup.kind === "interface";
    entityTools.hidden = !isInterface;
    favoriteButton.hidden = !isInterface;
    explorer.classList.toggle("single-entity", !isInterface);
    const moduleTitle =
      manifest.modules.find((item) => item.id === activeGroup.module_id)?.title ?? activeGroup.title;
    contextPath.textContent =
      moduleTitle === activeGroup.title ? moduleTitle : `${moduleTitle} / ${activeGroup.title}`;
    contextTitle.textContent = filtered.length ? activeEntity.label : "No matching entities";
    contextDescription.textContent = filtered.length
      ? activeEntity.description || "No inventory description"
      : "Adjust the entity filters to continue.";
    contextFacts.replaceChildren();
    if (filtered.length) {
      const facts = [
        ["Capacity", formatCapacity(Math.max(activeEntity.capacity.in_bps, activeEntity.capacity.out_bps))],
        ["Admin", activeEntity.admin_status === null ? "N/A" : activeEntity.admin_status ? "Enabled" : "Disabled"],
        ["Duplex", activeEntity.full_duplex === null ? "N/A" : activeEntity.full_duplex ? "Full" : "Half"],
        ["Signals", activeEntity.capabilities.map((item) => metricViewLabel(item)).join(" / ")],
      ];
      for (const [label, value] of facts) {
        const fact = element("div", "context-fact");
        fact.append(element("dt", "", label), element("dd", "", value));
        contextFacts.append(fact);
      }
    }
    entityStatus.textContent = filtered.length
      ? activeEntity.oper_status === true
        ? "OPERATIONAL"
        : activeEntity.oper_status === false
          ? "DOWN"
          : "UNKNOWN"
      : "NO MATCH";
    entityStatus.className = `entity-status ${
      !filtered.length ? "unknown" : activeEntity.oper_status === true ? "up" : "down"
    }`;
    favoriteButton.textContent = favorites.has(activeEntity.id) ? "★" : "☆";
    favoriteButton.classList.toggle("active", favorites.has(activeEntity.id));
    favoriteButton.title = favorites.has(activeEntity.id)
      ? "Remove interface from favorites"
      : "Add interface to favorites";
    favoriteButton.setAttribute("aria-label", favoriteButton.title);
    if (!filtered.length) {
      chart.clear();
      renderSeriesSummary([]);
      setAlert("no-data", "No interfaces match the current search and status filters.");
      setChartState(
        "empty",
        "No matching sources",
        "Change the search or include interfaces that are not operational.",
      );
      status.textContent = "No matching interfaces";
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

  async function refresh(): Promise<void> {
    const metricIds = [...selectedMetricIds];
    if (metricIds.length === 0) {
      chart.clear();
      renderSeriesSummary([]);
      setChartState(
        "empty",
        "No signals selected",
        "Select one or more measurements above to draw the history.",
      );
      status.textContent = "Waiting for a metric";
      scheduleRefresh();
      return;
    }
    const currentRequest = ++requestNumber;
    refreshButton.setAttribute("disabled", "");
    status.textContent = "Loading…";
    status.className = "query-status loading";
    chart.clear();
    seriesSummary.hidden = true;
    setChartState("loading", "Loading measurements", "Reading the selected time range.");
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
          "No measurements in this period",
          "Collection is configured, but no samples were stored for the selected time range.",
        );
      }
      const points = response.series.reduce((total, item) => total + item.points.length, 0);
      const timestamps = response.series.flatMap((item) => item.points.map((point) => point[0]));
      const firstPoint = timestamps.length ? Math.min(...timestamps) : response.from;
      const coverage =
        firstPoint > response.from + response.interval * 2_000
          ? ` · data since ${new Intl.DateTimeFormat(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            }).format(firstPoint)}`
          : "";
      status.textContent = `${response.series.length} series · ${points.toLocaleString()} points${coverage}`;
      status.className = "query-status success";
      lastUpdated.textContent = `Updated ${new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(Date.now())}`;
    } catch (error) {
      if (currentRequest !== requestNumber) return;
      const message = error instanceof Error ? error.message : "Query failed";
      chart.clear();
      setChartState("error", "Measurements unavailable", message, true);
      status.textContent = "Query failed";
      status.className = "query-status error";
    } finally {
      if (currentRequest === requestNumber) {
        refreshButton.removeAttribute("disabled");
        scheduleRefresh();
      }
    }
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
  entitySearch.addEventListener("input", () => {
    renderEntities();
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    if (!entitySelect.disabled) searchTimer = window.setTimeout(() => void refresh(), 250);
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
  autoRefreshSelect.addEventListener("change", () => {
    refreshIntervalMs = Number(autoRefreshSelect.value);
    localStorage.setItem("noc:dashboard:refresh", String(refreshIntervalMs));
    pauseButton.toggleAttribute("disabled", refreshIntervalMs === 0);
    scheduleRefresh();
  });
  pauseButton.addEventListener("click", () => {
    refreshPaused = !refreshPaused;
    pauseButton.textContent = refreshPaused ? "Resume" : "Pause";
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
  pauseButton.toggleAttribute("disabled", refreshIntervalMs === 0);
  await refresh();
}

void start();
