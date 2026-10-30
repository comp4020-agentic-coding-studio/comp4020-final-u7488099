// Stage 11: the standalone admin page. Separate esbuild entry point from
// main.ts, served at /admin (see index.ts's explicit route) — never merged
// into the game SPA. The real authorization gate is server-side
// (requireAdmin in index.ts, reading req.role resolved fresh from the
// session's account row); this page's own 403 handling below is purely UX —
// it never embeds any admin data in its own markup/bundle, and stops making
// further admin calls the moment any one of them 403s.
//
// Stage 12.5B: adds a read-only world map + ecology settings panel. The map
// below is a freshly written, self-contained camera/zoom/pan implementation
// scoped to this file — deliberately NOT a refactor/import of main.ts's
// gameplay camera, which is pan-only and wired to move/gather/attack click
// handlers that must never be reachable from this page. No function in this
// file ever calls a gameplay-mutation endpoint (/api/command/*, /api/reproduce,
// /api/evolve, /api/start-new-colony, /api/abandon, etc.) — the only fetches
// in this module are to /api/admin/* and /api/session.

import { APHID_RADIUS, RUIN_LIFETIME_MS, SPIDER_RADIUS, WORKER_RADIUS } from "../server/balance.ts";

interface AdminAccountRow {
  id: number;
  username: string;
  role: string;
  activeColonyId: number | null;
  createdAt: string;
}

interface AdminColonyRow {
  id: number;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  status: "active" | "defeated";
  population: number;
  peakPopulation: number;
  evolution: unknown;
}

interface AdminLogEntry {
  id: number;
  createdAt: string;
  colonyId: number;
  action: string;
  detail: unknown;
}

interface AdminStats {
  accounts: number;
  colonies: { total: number; active: number; defeated: number };
  actionLogRows: number;
}

interface AdminEcologyAnchor {
  key: string;
  tier: "anchor" | "background";
  density: number;
  target: number;
  pendingMsRemaining: number | null;
  x: number;
  y: number;
  radius: number;
  baseTarget: number;
  counts: Record<"sugar" | "biomass" | "protein" | "aphid" | "spider", number>;
  exclusionCoverage: number;
}

interface AdminEcologySnapshot {
  anchors: AdminEcologyAnchor[];
  background: { zoneCount: number; averageDensity: number; pendingCount: number };
}

interface AdminEcologyConfig {
  anchorBaseTargets: number[];
  backgroundBaseTarget: number;
  regenDelayMinMs: number;
  regenDelayMaxMs: number;
  updatedAt: string;
}

interface WorldMonitorResourceNode {
  id: number;
  x: number;
  y: number;
  resourceType: string;
  kind: "source" | "item";
}

interface WorldMonitorCreature {
  id: number;
  species: string;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
}

interface WorldMonitorColony {
  id: number;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  status: "active" | "defeated";
  population: number;
  peakPopulation: number;
  defeatedAt: string | null;
}

interface WorldMonitorWorker {
  id: number;
  colonyId: number;
  x: number;
  y: number;
  caste: string;
  health: number;
  maxHealth: number;
}

interface WorldMonitorSnapshot {
  world: { width: number; height: number };
  anchors: { index: number; x: number; y: number; radius: number }[];
  resourceNodes: WorldMonitorResourceNode[];
  creatures: WorldMonitorCreature[];
  colonies: WorldMonitorColony[];
  exclusions: { x: number; y: number; radius: number }[];
  workers?: WorldMonitorWorker[];
}

const unauthorizedEl = document.getElementById("unauthorized") as HTMLDivElement;
const rootEl = document.getElementById("admin-root") as HTMLDivElement;
const whoamiEl = document.getElementById("whoami") as HTMLParagraphElement;
const statsGridEl = document.getElementById("stats-grid") as HTMLDivElement;
const accountsBodyEl = document.getElementById("accounts-body") as HTMLTableSectionElement;
const coloniesBodyEl = document.getElementById("colonies-body") as HTMLTableSectionElement;
const logListEl = document.getElementById("log-list") as HTMLDivElement;
const ecologyAnchorsBodyEl = document.getElementById("ecology-anchors-body") as HTMLTableSectionElement;
const ecologyBackgroundSummaryEl = document.getElementById("ecology-background-summary") as HTMLParagraphElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const resetWorldConfirmEl = document.getElementById("reset-world-confirm") as HTMLInputElement;
const resetWorldButtonEl = document.getElementById("reset-world-button") as HTMLButtonElement;

// --- Stage 12.5B: world map -------------------------------------------------

const mapCanvas = document.getElementById("map-canvas") as HTMLCanvasElement;
const mapCanvasWrap = document.getElementById("map-canvas-wrap") as HTMLDivElement;
const mapCtx = mapCanvas.getContext("2d") as CanvasRenderingContext2D;
const mapFitWorldButton = document.getElementById("map-fit-world") as HTMLButtonElement;
const mapResetViewButton = document.getElementById("map-reset-view") as HTMLButtonElement;
const zoneInspectorEl = document.getElementById("zone-inspector") as HTMLDivElement;

const layerCheckboxes = {
  ecology: document.getElementById("layer-ecology") as HTMLInputElement,
  resources: document.getElementById("layer-resources") as HTMLInputElement,
  creatures: document.getElementById("layer-creatures") as HTMLInputElement,
  colonies: document.getElementById("layer-colonies") as HTMLInputElement,
  exclusions: document.getElementById("layer-exclusions") as HTMLInputElement,
  ruins: document.getElementById("layer-ruins") as HTMLInputElement,
  units: document.getElementById("layer-units") as HTMLInputElement,
};

const NODE_COLOR: Record<string, string> = { sugar: "#f4c542", protein: "#90caf9", biomass: "#8d6e63" };
const QUEEN_COLOR = "#ffd54d";
const RUIN_COLOR = "#9e9e9e";
const SPIDER_COLOR = "#d32f2f";
const APHID_COLOR = "#7cb342";
const EXCLUSION_COLOR = "rgba(255, 112, 67, 0.65)";
const BACKGROUND_GRID_COLOR = "rgba(255, 255, 255, 0.08)";
const ANCHOR_RING_COLOR = "rgba(129, 199, 132, 0.9)";

// Self-contained camera: {x,y} is the world point centered on screen, zoom
// is screen-pixels-per-world-unit. Freshly written for this page — see the
// module comment above for why main.ts's gameplay camera isn't reused.
const camera = { x: 1500, y: 1500, zoom: 1 };
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;

let worldSize = { width: 3000, height: 3000 };
let latestMonitor: WorldMonitorSnapshot | null = null;
let latestEcology: AdminEcologySnapshot | null = null;
let selectedAnchorIndex: number | null = null;

function resizeMapCanvas(): void {
  const rect = mapCanvasWrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  mapCanvas.width = Math.max(1, Math.round(rect.width * dpr));
  mapCanvas.height = Math.max(1, Math.round(rect.height * dpr));
  mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderMap();
}

new ResizeObserver(() => resizeMapCanvas()).observe(mapCanvasWrap);

function canvasCssSize(): { width: number; height: number } {
  const dpr = window.devicePixelRatio || 1;
  return { width: mapCanvas.width / dpr, height: mapCanvas.height / dpr };
}

function worldToScreen(wx: number, wy: number): [number, number] {
  const { width, height } = canvasCssSize();
  return [(wx - camera.x) * camera.zoom + width / 2, (wy - camera.y) * camera.zoom + height / 2];
}

function screenToWorld(sx: number, sy: number): [number, number] {
  const { width, height } = canvasCssSize();
  return [(sx - width / 2) / camera.zoom + camera.x, (sy - height / 2) / camera.zoom + camera.y];
}

function fitWorld(): void {
  const { width, height } = canvasCssSize();
  const margin = 0.92; // small padding so the world boundary isn't flush with the canvas edge
  const zoomX = (width * margin) / worldSize.width;
  const zoomY = (height * margin) / worldSize.height;
  camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(zoomX, zoomY)));
  camera.x = worldSize.width / 2;
  camera.y = worldSize.height / 2;
  renderMap();
}

mapFitWorldButton.addEventListener("click", fitWorld);
mapResetViewButton.addEventListener("click", fitWorld);

// Pan: the admin map issues no gameplay command, so there's no left-click
// select-vs-drag split to preserve like main.ts has — a single left-button
// drag is enough, with a small threshold so a plain click still reaches the
// zone-selection handler below instead of being swallowed as a pan.
const DRAG_THRESHOLD = 4;
let dragState: { startX: number; startY: number; camX: number; camY: number; moved: boolean } | null = null;

mapCanvas.addEventListener("mousedown", (e) => {
  dragState = { startX: e.clientX, startY: e.clientY, camX: camera.x, camY: camera.y, moved: false };
});

window.addEventListener("mousemove", (e) => {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  if (Math.hypot(dx, dy) > DRAG_THRESHOLD) dragState.moved = true;
  if (!dragState.moved) return;
  camera.x = dragState.camX - dx / camera.zoom;
  camera.y = dragState.camY - dy / camera.zoom;
  renderMap();
});

window.addEventListener("mouseup", (e) => {
  if (!dragState) return;
  if (!dragState.moved) {
    const rect = mapCanvas.getBoundingClientRect();
    handleMapClick(e.clientX - rect.left, e.clientY - rect.top);
  }
  dragState = null;
});

// Zoom to cursor: capture the cursor's world position before changing zoom,
// then re-center the camera so that same world point stays under the cursor.
mapCanvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = mapCanvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const [worldX, worldY] = screenToWorld(sx, sy);
    const factor = Math.exp(-e.deltaY * 0.0015);
    camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * factor));
    const [newWorldX, newWorldY] = screenToWorld(sx, sy);
    camera.x += worldX - newWorldX;
    camera.y += worldY - newWorldY;
    renderMap();
  },
  { passive: false },
);

function handleMapClick(sx: number, sy: number): void {
  if (!latestEcology) return;
  const [wx, wy] = screenToWorld(sx, sy);
  for (const anchor of latestEcology.anchors) {
    if (Math.hypot(anchor.x - wx, anchor.y - wy) <= anchor.radius) {
      selectAnchor(anchor.key);
      return;
    }
  }
}

function anchorIndexFromKey(key: string): number | null {
  const match = /^anchor:(\d+)$/.exec(key);
  return match ? Number(match[1]) : null;
}

function selectAnchor(key: string): void {
  selectedAnchorIndex = anchorIndexFromKey(key);
  renderZoneInspector();
  renderMap();
}

function zoneStateLabel(anchor: AdminEcologyAnchor): string {
  if (anchor.pendingMsRemaining !== null) {
    return `below target — regen in ${Math.ceil(anchor.pendingMsRemaining / 1000)}s`;
  }
  return anchor.density >= anchor.target ? "at target" : "below target";
}

function renderZoneInspector(): void {
  if (selectedAnchorIndex === null || !latestEcology) {
    zoneInspectorEl.innerHTML =
      '<strong>No zone selected</strong><p style="margin: 0.3rem 0 0 0; color: #666">Click an anchor zone on the map, or a row in the Ecology table below.</p>';
    return;
  }
  const anchor = latestEcology.anchors.find((a) => anchorIndexFromKey(a.key) === selectedAnchorIndex);
  if (!anchor) {
    zoneInspectorEl.innerHTML = "<strong>Zone no longer present.</strong>";
    return;
  }
  const pending =
    anchor.pendingMsRemaining === null ? "none" : `${Math.ceil(anchor.pendingMsRemaining / 1000)}s remaining`;
  zoneInspectorEl.innerHTML = `
    <strong>Anchor ${selectedAnchorIndex}</strong> — ${escapeHtml(zoneStateLabel(anchor))}
    <dl>
      <dt>Weighted density</dt><dd>${anchor.density.toFixed(2)}</dd>
      <dt>Base target</dt><dd>${anchor.baseTarget.toFixed(2)}</dd>
      <dt>Effective target</dt><dd>${anchor.target.toFixed(2)}</dd>
      <dt>Exclusion coverage</dt><dd>${(anchor.exclusionCoverage * 100).toFixed(0)}%</dd>
      <dt>Pending regen</dt><dd>${pending}</dd>
      <dt>Sugar</dt><dd>${anchor.counts.sugar}</dd>
      <dt>Biomass</dt><dd>${anchor.counts.biomass}</dd>
      <dt>Protein</dt><dd>${anchor.counts.protein}</dd>
      <dt>Aphids</dt><dd>${anchor.counts.aphid}</dd>
      <dt>Spiders</dt><dd>${anchor.counts.spider}</dd>
    </dl>
  `;
}

function isRuinNonExpired(defeatedAt: string | null): boolean {
  if (defeatedAt === null) return false;
  const normalized = defeatedAt.includes("T") ? defeatedAt : defeatedAt.replace(" ", "T") + "Z";
  return Date.now() - Date.parse(normalized) <= RUIN_LIFETIME_MS;
}

function renderMap(): void {
  const { width, height } = canvasCssSize();
  mapCtx.clearRect(0, 0, width, height);
  mapCtx.fillStyle = "#0d1b0f";
  mapCtx.fillRect(0, 0, width, height);

  // World boundary.
  const [bx0, by0] = worldToScreen(0, 0);
  const [bx1, by1] = worldToScreen(worldSize.width, worldSize.height);
  mapCtx.strokeStyle = "#4caf50";
  mapCtx.lineWidth = 2;
  mapCtx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);

  if (layerCheckboxes.ecology.checked) {
    drawBackgroundGrid();
    drawAnchorZones();
  }
  if (layerCheckboxes.exclusions.checked && latestMonitor) {
    for (const exclusion of latestMonitor.exclusions) drawCircle(exclusion.x, exclusion.y, exclusion.radius, null, EXCLUSION_COLOR, 2, [6, 4]);
  }
  if (latestMonitor) {
    if (layerCheckboxes.resources.checked) {
      for (const node of latestMonitor.resourceNodes) {
        if (node.kind !== "source") continue;
        drawCircle(node.x, node.y, 5, NODE_COLOR[node.resourceType] ?? "#a5d6a7", "#2e7d32", 1);
      }
    }
    if (layerCheckboxes.creatures.checked) {
      for (const creature of latestMonitor.creatures) {
        if (creature.species === "spider") {
          drawCircle(creature.x, creature.y, SPIDER_RADIUS * 0.5, SPIDER_COLOR, "#7f0000", 1);
        } else {
          drawCircle(creature.x, creature.y, APHID_RADIUS * 0.5, APHID_COLOR, "#33691e", 1);
        }
      }
    }
    if (layerCheckboxes.colonies.checked || layerCheckboxes.ruins.checked) {
      for (const colony of latestMonitor.colonies) {
        const ruin = colony.status === "defeated" && isRuinNonExpired(colony.defeatedAt);
        if (colony.status === "active" && layerCheckboxes.colonies.checked) {
          drawCircle(colony.x, colony.y, 9, QUEEN_COLOR, "#b8860b", 2);
        } else if (ruin && layerCheckboxes.ruins.checked) {
          drawCircle(colony.x, colony.y, 9, RUIN_COLOR, "#616161", 2);
        }
      }
    }
    if (layerCheckboxes.units.checked && latestMonitor.workers) {
      for (const worker of latestMonitor.workers) {
        drawCircle(worker.x, worker.y, WORKER_RADIUS * 0.4, "#b39ddb", "#4527a0", 1);
      }
    }
  }

  renderZoneInspector();
}

function drawCircle(
  wx: number,
  wy: number,
  worldRadius: number,
  fill: string | null,
  stroke: string | null,
  lineWidth: number,
  dash: number[] = [],
): void {
  const [sx, sy] = worldToScreen(wx, wy);
  const r = Math.max(1, worldRadius * camera.zoom);
  mapCtx.save();
  mapCtx.setLineDash(dash);
  mapCtx.beginPath();
  mapCtx.arc(sx, sy, r, 0, Math.PI * 2);
  if (fill) {
    mapCtx.fillStyle = fill;
    mapCtx.fill();
  }
  if (stroke) {
    mapCtx.strokeStyle = stroke;
    mapCtx.lineWidth = lineWidth;
    mapCtx.stroke();
  }
  mapCtx.restore();
}

const BACKGROUND_CELL_SIZE = 300;

function drawBackgroundGrid(): void {
  mapCtx.save();
  mapCtx.strokeStyle = BACKGROUND_GRID_COLOR;
  mapCtx.lineWidth = 1;
  for (let x = 0; x <= worldSize.width; x += BACKGROUND_CELL_SIZE) {
    const [sx0, sy0] = worldToScreen(x, 0);
    const [sx1, sy1] = worldToScreen(x, worldSize.height);
    mapCtx.beginPath();
    mapCtx.moveTo(sx0, sy0);
    mapCtx.lineTo(sx1, sy1);
    mapCtx.stroke();
  }
  for (let y = 0; y <= worldSize.height; y += BACKGROUND_CELL_SIZE) {
    const [sx0, sy0] = worldToScreen(0, y);
    const [sx1, sy1] = worldToScreen(worldSize.width, y);
    mapCtx.beginPath();
    mapCtx.moveTo(sx0, sy0);
    mapCtx.lineTo(sx1, sy1);
    mapCtx.stroke();
  }
  mapCtx.restore();
}

// Anchor circles: dashed stroke when pending regen (visually distinguished
// by state, not colour alone, per spec), fill opacity scaled to density/
// target ratio, labeled "Anchor N" plus a short state string.
function drawAnchorZones(): void {
  if (!latestEcology) return;
  for (const anchor of latestEcology.anchors) {
    const index = anchorIndexFromKey(anchor.key);
    const ratio = anchor.target > 0 ? Math.min(1, anchor.density / anchor.target) : 1;
    const [sx, sy] = worldToScreen(anchor.x, anchor.y);
    const r = Math.max(1, anchor.radius * camera.zoom);
    const pending = anchor.pendingMsRemaining !== null;
    mapCtx.save();
    mapCtx.beginPath();
    mapCtx.arc(sx, sy, r, 0, Math.PI * 2);
    mapCtx.fillStyle = `rgba(129, 199, 132, ${0.08 + ratio * 0.22})`;
    mapCtx.fill();
    mapCtx.setLineDash(pending ? [6, 5] : []);
    mapCtx.strokeStyle = index === selectedAnchorIndex ? "#ffffff" : ANCHOR_RING_COLOR;
    mapCtx.lineWidth = index === selectedAnchorIndex ? 3 : 1.5;
    mapCtx.stroke();
    mapCtx.restore();

    mapCtx.save();
    mapCtx.fillStyle = "#e8f5e9";
    mapCtx.font = "12px system-ui, sans-serif";
    mapCtx.fillText(`Anchor ${index}`, sx - r * 0.3, sy - 2);
    mapCtx.font = "10px system-ui, sans-serif";
    mapCtx.fillStyle = "#c8e6c9";
    mapCtx.fillText(zoneStateLabel(anchor), sx - r * 0.3, sy + 11);
    mapCtx.restore();
  }
}

for (const checkbox of Object.values(layerCheckboxes)) {
  checkbox.addEventListener("change", () => {
    void refreshMonitor();
  });
}

async function refreshMonitor(): Promise<void> {
  const url = layerCheckboxes.units.checked ? "/api/admin/world-monitor?units=1" : "/api/admin/world-monitor";
  const [monitor, ecology] = await Promise.all([
    fetch(url).then((r) => r.json()),
    fetch("/api/admin/ecology").then((r) => r.json()),
  ]);
  latestMonitor = monitor as WorldMonitorSnapshot;
  latestEcology = ecology as AdminEcologySnapshot;
  worldSize = latestMonitor.world;
  renderEcology(latestEcology);
  renderMap();
}

// --- Stage 12.5B: ecology settings ------------------------------------------
//
// The two delay fields are stored/transmitted in milliseconds (the server's
// representation, unchanged), but displayed/edited in seconds — the only
// conversion boundary is here, at form fill / form submit.

const MS_PER_SECOND = 1000;

const ecologySettingsForm = document.getElementById("ecology-settings-form") as HTMLFormElement;
const ecologyBackgroundBaseTargetInput = document.getElementById("ecology-background-base-target") as HTMLInputElement;
const ecologyRegenMinInput = document.getElementById("ecology-regen-min") as HTMLInputElement;
const ecologyRegenMaxInput = document.getElementById("ecology-regen-max") as HTMLInputElement;
const ecologySettingsStatusEl = document.getElementById("ecology-settings-status") as HTMLParagraphElement;

// Fills the remaining settings-form fields and every per-anchor table input
// (table inputs are keyed by index, same map renderEcology populates) — the
// single source of truth refilled on both initial load and after a
// successful save, per the "server is authoritative" discipline.
function fillEcologySettingsForm(config: AdminEcologyConfig): void {
  ecologyBackgroundBaseTargetInput.value = String(config.backgroundBaseTarget);
  ecologyRegenMinInput.value = String(config.regenDelayMinMs / MS_PER_SECOND);
  ecologyRegenMaxInput.value = String(config.regenDelayMaxMs / MS_PER_SECOND);
  ecologySettingsStatusEl.textContent = `Last saved: ${config.updatedAt}`;
  dirtyAnchorIndices.clear();
  config.anchorBaseTargets.forEach((value, index) => {
    const input = anchorBaseTargetInputs.get(index);
    if (input) input.value = String(value);
  });
}

async function loadEcologyConfig(): Promise<void> {
  const res = await fetch("/api/admin/ecology-config");
  if (!res.ok) return;
  fillEcologySettingsForm(await res.json());
}

// Explicit Save action only — no per-keystroke writes, per spec. Covers
// both the three remaining form fields and all per-anchor base-target
// inputs in the table as one atomic PUT. Server is authoritative: on
// success every field (form + table) is refilled from the server's own
// echo of the saved row, never from the values already in the inputs.
ecologySettingsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  void (async () => {
    const anchorBaseTargets: number[] = [];
    for (let i = 0; i < anchorBaseTargetInputs.size; i++) {
      anchorBaseTargets.push(Number(anchorBaseTargetInputs.get(i)?.value ?? NaN));
    }
    const body = {
      anchorBaseTargets,
      backgroundBaseTarget: Number(ecologyBackgroundBaseTargetInput.value),
      regenDelayMinMs: Math.round(Number(ecologyRegenMinInput.value) * MS_PER_SECOND),
      regenDelayMaxMs: Math.round(Number(ecologyRegenMaxInput.value) * MS_PER_SECOND),
    };
    const res = await fetch("/api/admin/ecology-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (!res.ok) {
      ecologySettingsStatusEl.textContent = result.error ?? "save failed";
      return;
    }
    fillEcologySettingsForm(result);
    ecologySettingsStatusEl.textContent = `Saved at ${result.updatedAt}.`;
  })();
});

function statCard(value: number | string, label: string): string {
  return `<div class="stat-card"><div class="value">${value}</div><div class="label">${label}</div></div>`;
}

function renderStats(stats: AdminStats): void {
  statsGridEl.innerHTML =
    statCard(stats.accounts, "Accounts") +
    statCard(stats.colonies.total, "Colonies (total)") +
    statCard(stats.colonies.active, "Colonies (active)") +
    statCard(stats.colonies.defeated, "Colonies (defeated)") +
    statCard(stats.actionLogRows, "Action log rows");
}

function renderAccounts(accounts: AdminAccountRow[]): void {
  accountsBodyEl.innerHTML = accounts
    .map(
      (a) =>
        `<tr><td>${a.id}</td><td>${escapeHtml(a.username)}</td><td>${escapeHtml(a.role)}</td><td>${
          a.activeColonyId ?? "—"
        }</td><td>${escapeHtml(a.createdAt)}</td></tr>`,
    )
    .join("");
}

function renderColonies(colonies: AdminColonyRow[]): void {
  coloniesBodyEl.innerHTML = colonies
    .map((c) => {
      const disabled = c.status === "defeated" ? "disabled" : "";
      return `<tr>
        <td>${c.id}</td>
        <td>${Math.round(c.x)}, ${Math.round(c.y)}</td>
        <td>${Math.round(c.health)} / ${Math.round(c.maxHealth)}</td>
        <td>${c.status}</td>
        <td>${c.population}</td>
        <td>${c.peakPopulation}</td>
        <td><button class="defeat-button" type="button" data-colony-id="${c.id}" ${disabled}>Defeat</button></td>
      </tr>`;
    })
    .join("");

  coloniesBodyEl.querySelectorAll<HTMLButtonElement>(".defeat-button").forEach((button) => {
    button.addEventListener("click", () => void defeatColony(Number(button.dataset.colonyId)));
  });
}

function renderLog(entries: AdminLogEntry[]): void {
  logListEl.innerHTML = entries
    .map((entry) => {
      const detail = entry.detail ? ` ${escapeHtml(JSON.stringify(entry.detail))}` : "";
      return `<div>${escapeHtml(entry.createdAt)} — colony ${entry.colonyId} — <strong>${escapeHtml(
        entry.action,
      )}</strong>${detail}</div>`;
    })
    .join("");
}

// Base target inputs live inside a table that re-renders on every ~1.5s
// monitor poll (renderEcology is called from refreshMonitor) — rebuilding
// the whole tbody via innerHTML every poll would wipe out an in-progress
// edit and steal focus mid-keystroke. So rows/inputs are created once per
// anchor index and updated in place afterward, and an input's value is only
// overwritten from the server snapshot when the admin isn't actively
// editing it (not focused, and not "dirty" since the last load/save).
const anchorBaseTargetInputs = new Map<number, HTMLInputElement>();
const dirtyAnchorIndices = new Set<number>();

function renderEcology(snapshot: AdminEcologySnapshot): void {
  for (const a of snapshot.anchors) {
    const index = anchorIndexFromKey(a.key);
    if (index === null) continue;
    const pending = a.pendingMsRemaining === null ? "—" : `${Math.ceil(a.pendingMsRemaining / 1000)}s`;

    let row = ecologyAnchorsBodyEl.querySelector<HTMLTableRowElement>(`tr[data-zone-key="${a.key}"]`);
    if (!row) {
      row = document.createElement("tr");
      row.dataset.zoneKey = a.key;
      row.innerHTML = `
        <td class="zone-key-cell" style="cursor:pointer">${escapeHtml(a.key)}</td>
        <td class="density-cell" style="cursor:pointer"></td>
        <td class="target-cell" style="cursor:pointer"></td>
        <td class="base-target-cell"></td>
        <td class="pending-cell" style="cursor:pointer"></td>
      `;
      for (const cls of ["zone-key-cell", "density-cell", "target-cell", "pending-cell"]) {
        row.querySelector(`.${cls}`)!.addEventListener("click", () => selectAnchor(a.key));
      }
      const input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.min = "0.01";
      input.className = "anchor-base-target-input";
      input.addEventListener("input", () => dirtyAnchorIndices.add(index));
      row.querySelector(".base-target-cell")!.appendChild(input);
      anchorBaseTargetInputs.set(index, input);
      ecologyAnchorsBodyEl.appendChild(row);
    }

    row.querySelector(".density-cell")!.textContent = a.density.toFixed(1);
    row.querySelector(".target-cell")!.textContent = a.target.toFixed(1);
    row.querySelector(".pending-cell")!.textContent = pending;

    const input = anchorBaseTargetInputs.get(index)!;
    if (document.activeElement !== input && !dirtyAnchorIndices.has(index)) {
      input.value = String(a.baseTarget);
    }
  }

  const bg = snapshot.background;
  ecologyBackgroundSummaryEl.textContent =
    `Background: ${bg.zoneCount} zones measured, average density ${bg.averageDensity.toFixed(2)}, ` +
    `${bg.pendingCount} pending regen.`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function loadAll(): Promise<void> {
  const [accounts, colonies, log] = await Promise.all([
    fetch("/api/admin/accounts").then((r) => r.json()),
    fetch("/api/admin/colonies").then((r) => r.json()),
    fetch("/api/admin/log").then((r) => r.json()),
  ]);
  renderAccounts(accounts);
  renderColonies(colonies);
  renderLog(log);
  await refreshMonitor();
}

async function defeatColony(colonyId: number): Promise<void> {
  if (!confirm(`Defeat colony ${colonyId}? This destroys its workers and stored resources.`)) return;
  const res = await fetch(`/api/admin/colonies/${colonyId}/defeat`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    statusEl.textContent = body.error ?? "defeat failed";
    return;
  }
  statusEl.textContent = `Colony ${colonyId} defeated.`;
  await loadAll();
}

resetWorldConfirmEl.addEventListener("input", () => {
  resetWorldButtonEl.disabled = resetWorldConfirmEl.value !== "RESET WORLD";
});

// Reset World is the one genuinely destructive admin action — this handler
// is fully wired and functional, but per Stage 11's plan it must never be
// invoked by anything other than a real admin operator deliberately
// clicking this confirmed control in the live page; it is never triggered
// during implementation, testing, or deployment.
resetWorldButtonEl.addEventListener("click", async () => {
  if (resetWorldConfirmEl.value !== "RESET WORLD") return;
  const res = await fetch("/api/admin/reset-world", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: resetWorldConfirmEl.value }),
  });
  const body = await res.json();
  if (!res.ok) {
    statusEl.textContent = body.error ?? "reset world failed";
    return;
  }
  statusEl.textContent = "World reset.";
  resetWorldConfirmEl.value = "";
  resetWorldButtonEl.disabled = true;
  await loadAll();
});

async function bootstrap(): Promise<void> {
  const statsRes = await fetch("/api/admin/stats");
  if (statsRes.status === 403) {
    unauthorizedEl.hidden = false;
    return;
  }
  if (!statsRes.ok) {
    unauthorizedEl.hidden = false;
    return;
  }
  const stats = (await statsRes.json()) as AdminStats;

  const sessionRes = await fetch("/api/session");
  const session = await sessionRes.json();

  rootEl.hidden = false;
  whoamiEl.textContent = session.username ? `Signed in as ${session.username} (admin)` : "Signed in as admin";
  renderStats(stats);
  await loadAll();
  await loadEcologyConfig();
  resizeMapCanvas();
  fitWorld();

  // Realtime: a low-frequency poll while the admin page is open, per spec —
  // not a new WebSocket channel, and never touches the gameplay /ws socket.
  setInterval(() => void refreshMonitor(), 1500);
}

bootstrap().catch((err) => {
  statusEl.textContent = `Failed to load admin data: ${String(err)}`;
});
