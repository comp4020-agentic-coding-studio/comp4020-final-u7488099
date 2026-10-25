import {
  APHID_RADIUS,
  type Caste,
  DEFEATED_COLONY_VISION_RADIUS,
  EVOLUTION_TIER_1_POPULATION,
  EVOLUTION_TIER_2_POPULATION,
  EVOLUTION_TIER_3_POPULATION,
  SPIDER_RADIUS,
  TRAIT_DISPLAY_NAMES,
  VISION_RADIUS,
  WORKER_RADIUS,
} from "../server/balance.ts";

const CASTES: Caste[] = ["worker", "soldier", "scout"];
const CASTE_DISPLAY_NAMES: Record<Caste, string> = { worker: "Worker", soldier: "Soldier", scout: "Scout" };
// Stage 10: caste is communicated by size/stroke, not a second colour axis —
// own/foreign colouring (blue/gold vs. purple) is unchanged.
const CASTE_RADIUS: Record<Caste, number> = { worker: WORKER_RADIUS, soldier: 14, scout: 7 };

type EvolutionChoice = "foraging" | "survival" | "brood";

// Stage 9: one-line effect text per trait, shown in the Evolution panel and
// in each trait's confirm step — kept client-side next to the display-name
// lookup it's paired with, same duplication discipline as every other
// mirrored constant (ColonyState itself, NODE_RADIUS vs. the server's radii).
const TRAIT_EFFECT_TEXT: Record<1 | 2 | 3, Record<EvolutionChoice, string>> = {
  1: {
    foraging: "Workers carry +50% more resources per claim.",
    survival: "Workers gain +50% maximum health.",
    brood: "Reproducing a new worker costs 20% less protein.",
  },
  2: {
    foraging: "Workers gather 30% faster.",
    survival: "Workers deal +50% attack damage.",
    brood: "Reproducing a new worker costs 35% less protein.",
  },
  3: {
    foraging: "Workers move 25% faster while carrying resources home.",
    survival: "Workers move 25% faster while attacking or chasing.",
    brood: "Reproducing a new worker costs 50% less protein.",
  },
};

const EVOLUTION_TIER_POPULATION: Record<1 | 2 | 3, number> = {
  1: EVOLUTION_TIER_1_POPULATION,
  2: EVOLUTION_TIER_2_POPULATION,
  3: EVOLUTION_TIER_3_POPULATION,
};

interface ColonyState {
  world: { width: number; height: number };
  colony: {
    id: number;
    queenX: number;
    queenY: number;
    resources: Record<string, number>;
    queenHealth: number;
    queenMaxHealth: number;
    status: "active" | "defeated";
    defeatCause: string | null;
    peakPopulation: number;
    evolutionTier1: EvolutionChoice | null;
    evolutionTier2: EvolutionChoice | null;
    evolutionTier3: EvolutionChoice | null;
    reproduceCosts: Record<Caste, number>;
  };
  workers: {
    id: number;
    x: number;
    y: number;
    carrying: { resourceType: string; amount: number } | null;
    health: number;
    maxHealth: number;
    caste: Caste;
  }[];
  // Every other colony's workers, visible but never selectable/controllable
  // from this session — see hitTest/selectWorkersInBox, which only ever look
  // at `workers` above, never this.
  otherWorkers: {
    id: number;
    colonyId: number;
    x: number;
    y: number;
    carrying: { resourceType: string; amount: number } | null;
    health: number;
    maxHealth: number;
    caste: Caste;
  }[];
  resourceNodes: {
    id: number;
    x: number;
    y: number;
    resourceType: string;
    amount: number | null;
    maxAmount: number | null;
    kind: "source" | "item";
  }[];
  creatures: { id: number; species: string; x: number; y: number; health: number; maxHealth: number }[];
  colonies: {
    id: number;
    queenX: number;
    queenY: number;
    health: number;
    maxHealth: number;
    status: "active" | "defeated";
    population: number;
    peakPopulation: number;
    evolutionTier1: EvolutionChoice | null;
    evolutionTier2: EvolutionChoice | null;
    evolutionTier3: EvolutionChoice | null;
    defeatCause: string | null;
  }[];
  worldEvents: { message: string }[];
  identity: { status: "guest" | "account"; username: string | null; role: "player" | "admin" | null };
}

const canvas = document.querySelector<HTMLCanvasElement>("#world")!;
const ctx = canvas.getContext("2d")!;
const resourcesEl = document.querySelector<HTMLElement>("#resources")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const reproduceButtons: Record<Caste, HTMLButtonElement> = {
  worker: document.querySelector<HTMLButtonElement>("#reproduce-worker")!,
  soldier: document.querySelector<HTMLButtonElement>("#reproduce-soldier")!,
  scout: document.querySelector<HTMLButtonElement>("#reproduce-scout")!,
};
const helpButton = document.querySelector<HTMLButtonElement>("#help-button")!;
const helpOverlay = document.querySelector<HTMLElement>("#help-overlay")!;
const helpClose = document.querySelector<HTMLButtonElement>("#help-close")!;
const queenHealthEl = document.querySelector<HTMLElement>("#queen-health")!;
const worldEventsListEl = document.querySelector<HTMLElement>("#world-events-list")!;
const abandonButton = document.querySelector<HTMLButtonElement>("#abandon-button")!;
const abandonOverlay = document.querySelector<HTMLElement>("#abandon-overlay")!;
const abandonCancel = document.querySelector<HTMLButtonElement>("#abandon-cancel")!;
const abandonConfirm = document.querySelector<HTMLButtonElement>("#abandon-confirm")!;
const defeatOverlay = document.querySelector<HTMLElement>("#defeat-overlay")!;
const defeatMessageEl = document.querySelector<HTMLElement>("#defeat-message")!;
const startNewColonyButton = document.querySelector<HTMLButtonElement>("#start-new-colony")!;
const evolutionButton = document.querySelector<HTMLButtonElement>("#evolution-button")!;
const evolutionBadge = document.querySelector<HTMLElement>("#evolution-badge")!;
const evolutionOverlay = document.querySelector<HTMLElement>("#evolution-overlay")!;
const evolutionClose = document.querySelector<HTMLButtonElement>("#evolution-close")!;
const evolutionPeakEl = document.querySelector<HTMLElement>("#evolution-peak")!;
const evolutionTiersEl = document.querySelector<HTMLElement>("#evolution-tiers")!;
const evolutionOthersEl = document.querySelector<HTMLElement>("#evolution-others")!;
const evolutionConfirmOverlay = document.querySelector<HTMLElement>("#evolution-confirm-overlay")!;
const evolutionConfirmText = document.querySelector<HTMLElement>("#evolution-confirm-text")!;
const evolutionConfirmCancel = document.querySelector<HTMLButtonElement>("#evolution-confirm-cancel")!;
const evolutionConfirmButton = document.querySelector<HTMLButtonElement>("#evolution-confirm-confirm")!;
const returnToQueenButton = document.querySelector<HTMLButtonElement>("#return-to-queen-button")!;
const recallAllButton = document.querySelector<HTMLButtonElement>("#recall-all-button")!;

const identityIndicatorEl = document.querySelector<HTMLElement>("#identity-indicator")!;
const saveProgressButton = document.querySelector<HTMLButtonElement>("#save-progress-button")!;
const accountButton = document.querySelector<HTMLButtonElement>("#account-button")!;
const logoutButton = document.querySelector<HTMLButtonElement>("#logout-button")!;
const adminLink = document.querySelector<HTMLAnchorElement>("#admin-link")!;

const entryOverlay = document.querySelector<HTMLElement>("#entry-overlay")!;
const entryStatusEl = document.querySelector<HTMLElement>("#entry-status")!;
const entryGuestButton = document.querySelector<HTMLButtonElement>("#entry-guest-button")!;
const entryRegisterForm = document.querySelector<HTMLFormElement>("#entry-register-form")!;
const entryRegisterUsername = document.querySelector<HTMLInputElement>("#entry-register-username")!;
const entryRegisterPassword = document.querySelector<HTMLInputElement>("#entry-register-password")!;
const entryLoginForm = document.querySelector<HTMLFormElement>("#entry-login-form")!;
const entryLoginUsername = document.querySelector<HTMLInputElement>("#entry-login-username")!;
const entryLoginPassword = document.querySelector<HTMLInputElement>("#entry-login-password")!;

const registerOverlay = document.querySelector<HTMLElement>("#register-overlay")!;
const registerStatusEl = document.querySelector<HTMLElement>("#register-status")!;
const registerForm = document.querySelector<HTMLFormElement>("#register-form")!;
const registerUsername = document.querySelector<HTMLInputElement>("#register-username")!;
const registerPassword = document.querySelector<HTMLInputElement>("#register-password")!;
const registerCancel = document.querySelector<HTMLButtonElement>("#register-cancel")!;

const accountOverlay = document.querySelector<HTMLElement>("#account-overlay")!;
const accountStatusEl = document.querySelector<HTMLElement>("#account-status")!;
const accountClose = document.querySelector<HTMLButtonElement>("#account-close")!;
const resetProgressConfirm = document.querySelector<HTMLInputElement>("#reset-progress-confirm")!;
const resetProgressButton = document.querySelector<HTMLButtonElement>("#reset-progress-button")!;

const QUEEN_RADIUS = 20;
const NODE_RADIUS: Record<string, number> = { sugar: 8, protein: 14, biomass: 20 };
const NODE_COLOR: Record<string, string> = { sugar: "#f4c542", protein: "#90caf9", biomass: "#8d6e63" };
const PAN_SPEED = 600; // world units per second
const DRAG_THRESHOLD = 4; // screen px of movement before a mousedown counts as a drag, not a click

let state: ColonyState | null = null;
let selectedWorkerIds = new Set<number>();
let cameraInitialised = false;
const camera = { x: 0, y: 0 };

// --- camera transform -------------------------------------------------

function clampCamera(): void {
  if (!state) return;
  const halfW = canvas.width / 2;
  const halfH = canvas.height / 2;
  camera.x = Math.min(Math.max(camera.x, halfW), Math.max(halfW, state.world.width - halfW));
  camera.y = Math.min(Math.max(camera.y, halfH), Math.max(halfH, state.world.height - halfH));
}

function worldToScreen(x: number, y: number): [number, number] {
  return [x - camera.x + canvas.width / 2, y - camera.y + canvas.height / 2];
}

function screenToWorld(x: number, y: number): [number, number] {
  return [x - canvas.width / 2 + camera.x, y - canvas.height / 2 + camera.y];
}

// --- rendering (snap-to-latest: always draws the latest known state,
// no interpolation between updates — see CLAUDE.md) --------------------

function circle(wx: number, wy: number, r: number, fill: string, stroke: string, lineWidth = 2): void {
  const [sx, sy] = worldToScreen(wx, wy);
  if (sx < -r || sy < -r || sx > canvas.width + r || sy > canvas.height + r) return;
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

// Stage 10: caste is communicated by radius (CASTE_RADIUS) and stroke
// thickness — Soldier thicker-stroked, Scout thinner — never a second
// colour axis; own/foreign colouring is unchanged.
const CASTE_STROKE_WIDTH: Record<Caste, number> = { worker: 2, soldier: 3, scout: 1 };

// Stage 5: aphid placeholder marker. A diamond, not a circle, so it reads as
// visually distinct from every other marker (workers/queen/resource nodes are
// all circles) at a glance, per the brief — not selectable/clickable, so
// deliberately never considered by hitTest.
function diamond(wx: number, wy: number, r: number, fill: string, stroke: string): void {
  const [sx, sy] = worldToScreen(wx, wy);
  if (sx < -r || sy < -r || sx > canvas.width + r || sy > canvas.height + r) return;
  ctx.beginPath();
  ctx.moveTo(sx, sy - r);
  ctx.lineTo(sx + r, sy);
  ctx.lineTo(sx, sy + r);
  ctx.lineTo(sx - r, sy);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.stroke();
}

// Stage 7: spider placeholder marker — a dark body circle with a few short
// radiating "leg" strokes, in a danger red reserved for hostile creatures
// (purple is "other colony", green is aphid, blue/gold are own units/queen).
// Not selectable/clickable via diamond()/circle(); hitTest handles spiders
// separately since their click radius differs from an aphid's.
function drawSpider(wx: number, wy: number, r: number): void {
  const [sx, sy] = worldToScreen(wx, wy);
  if (sx < -r * 2 || sy < -r * 2 || sx > canvas.width + r * 2 || sy > canvas.height + r * 2) return;
  ctx.save();
  ctx.strokeStyle = "#4a0000";
  ctx.lineWidth = 2;
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(sx + Math.cos(angle) * r * 0.6, sy + Math.sin(angle) * r * 0.6);
    ctx.lineTo(sx + Math.cos(angle) * r * 1.6, sy + Math.sin(angle) * r * 1.6);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(sx, sy, r * 0.7, 0, Math.PI * 2);
  ctx.fillStyle = "#b71c1c";
  ctx.fill();
  ctx.strokeStyle = "#4a0000";
  ctx.stroke();
  ctx.restore();
}

// Stage 6: a carcass (resourceNodes entry with kind === "item") is drawn as
// a dashed, differently-coloured circle instead of a node's usual solid
// NODE_COLOR fill — distinct at a glance without a new drawing primitive.
function drawResourceNode(node: ColonyState["resourceNodes"][number]): void {
  const radius = NODE_RADIUS[node.resourceType] ?? 10;
  if (node.kind !== "item") {
    circle(node.x, node.y, radius, NODE_COLOR[node.resourceType] ?? "#a5d6a7", "#2e7d32");
    return;
  }
  const [sx, sy] = worldToScreen(node.x, node.y);
  if (sx < -radius || sy < -radius || sx > canvas.width + radius || sy > canvas.height + radius) return;
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.arc(sx, sy, radius, 0, Math.PI * 2);
  ctx.fillStyle = "#6d4c41";
  ctx.fill();
  ctx.strokeStyle = "#3e2723";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

// Stage 6: shown only while a creature is damaged, so a world full of
// full-health aphids stays visually quiet — placeholder graphics only, per
// the brief (no art investment).
function drawHealthBar(wx: number, wy: number, r: number, health: number, maxHealth: number): void {
  if (health >= maxHealth) return;
  const [sx, sy] = worldToScreen(wx, wy - r - 8);
  const width = r * 2;
  const height = 3;
  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
  ctx.fillRect(sx - width / 2, sy, width, height);
  ctx.fillStyle = "#e53935";
  ctx.fillRect(sx - width / 2, sy, width * Math.max(0, health / maxHealth), height);
  ctx.restore();
}

// Stage 8: a defeated colony's queen is a non-interactive "ruin" — a muted,
// desaturated marker with a small crack mark, instead of the normal filled
// circle. Never passed to hitTest/onCanvasClick, consistent with it never
// appearing in any command-target resolution.
function drawRuin(wx: number, wy: number, r: number): void {
  const [sx, sy] = worldToScreen(wx, wy);
  if (sx < -r || sy < -r || sx > canvas.width + r || sy > canvas.height + r) return;
  ctx.save();
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#9e9e9e";
  ctx.fill();
  ctx.strokeStyle = "#616161";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx - r * 0.4, sy - r * 0.6);
  ctx.lineTo(sx + r * 0.1, sy + r * 0.1);
  ctx.lineTo(sx - r * 0.1, sy + r * 0.1);
  ctx.lineTo(sx + r * 0.4, sy + r * 0.6);
  ctx.strokeStyle = "#424242";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

// Dashed ring, drawn on top of (not instead of) the worker's own circle, so
// selection never changes a worker's actual rendered colour.
function drawSelectionRing(wx: number, wy: number, r: number): void {
  const [sx, sy] = worldToScreen(wx, wy);
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = "#e91e63";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// Stage 4 placeholder: a small filled dot offset toward the worker's
// upper-right, coloured the same as the resource type it's carrying — reuses
// NODE_COLOR rather than inventing a second palette. Drawn on top of (not
// instead of) the worker's own circle, same convention as drawSelectionRing.
function drawCarryingBadge(wx: number, wy: number, r: number, resourceType: string): void {
  const [sx, sy] = worldToScreen(wx + r * 0.7, wy - r * 0.7);
  ctx.save();
  ctx.beginPath();
  ctx.arc(sx, sy, r * 0.45, 0, Math.PI * 2);
  ctx.fillStyle = NODE_COLOR[resourceType] ?? "#a5d6a7";
  ctx.fill();
  ctx.strokeStyle = "#2e7d32";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

// Drawn in world space (worldToScreen'd per corner on every frame) so it
// stays correct even if WASD panning moves the camera mid-drag.
function drawSelectionBox(box: { startWorld: [number, number]; currentWorld: [number, number] }): void {
  const [sx1, sy1] = worldToScreen(...box.startWorld);
  const [sx2, sy2] = worldToScreen(...box.currentWorld);
  const x = Math.min(sx1, sx2);
  const y = Math.min(sy1, sy2);
  const w = Math.abs(sx2 - sx1);
  const h = Math.abs(sy2 - sy1);
  ctx.save();
  ctx.fillStyle = "rgba(33, 150, 243, 0.15)";
  ctx.strokeStyle = "rgba(33, 150, 243, 0.8)";
  ctx.lineWidth = 1;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

// Stage 10 (revised): fog of war is purely a client-side rendering/
// interaction concern — the server now sends the full, unfiltered shared
// world (see CLAUDE.md's Stage 10 section and state.ts). "Illuminated
// darkness": the whole map exists underneath the fog; a colony's own queen
// and units are light sources whose circles combine, and everything else is
// filtered out of rendering and hit-testing (not deleted from `state`) when
// it falls outside every circle. This single source list is also what
// drawFogOverlay() punches holes for, so the lit area and the
// drawn/clickable area can never drift apart.
interface VisionSource {
  x: number;
  y: number;
  radius: number;
}

function computeOwnVisionSources(): VisionSource[] {
  if (!state) return [];
  if (state.colony.status !== "active") {
    return [{ x: state.colony.queenX, y: state.colony.queenY, radius: DEFEATED_COLONY_VISION_RADIUS }];
  }
  const sources: VisionSource[] = [{ x: state.colony.queenX, y: state.colony.queenY, radius: VISION_RADIUS.queen }];
  for (const worker of state.workers) {
    sources.push({ x: worker.x, y: worker.y, radius: VISION_RADIUS[worker.caste] });
  }
  return sources;
}

function isVisible(x: number, y: number, sources: VisionSource[]): boolean {
  return sources.some((s) => Math.hypot(s.x - x, s.y - y) <= s.radius);
}

function draw(): void {
  ctx.fillStyle = "#eef7ee";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!state) return;

  const vision = computeOwnVisionSources();

  for (const node of state.resourceNodes) {
    if (!isVisible(node.x, node.y, vision)) continue;
    drawResourceNode(node);
  }
  for (const creature of state.creatures) {
    if (!isVisible(creature.x, creature.y, vision)) continue;
    if (creature.species === "spider") {
      drawSpider(creature.x, creature.y, SPIDER_RADIUS);
      drawHealthBar(creature.x, creature.y, SPIDER_RADIUS, creature.health, creature.maxHealth);
      continue;
    }
    diamond(creature.x, creature.y, APHID_RADIUS, "#7cb342", "#33691e");
    drawHealthBar(creature.x, creature.y, APHID_RADIUS, creature.health, creature.maxHealth);
  }
  // Crit 10 / post-6b visibility fix: every other colony's queen and workers
  // are part of the shared world this session can see, drawn in the same
  // "other colony" purple so the convention reads consistently across unit
  // types — but never selectable/commandable (otherWorkers is never consulted
  // by hitTest or selectWorkersInBox). Resources stay private: getState()
  // never sends another colony's economy. Stage 10 (revised): now also
  // gated by this colony's own vision, since the server no longer does it.
  for (const colony of state.colonies) {
    if (colony.id === state.colony.id) continue;
    if (!isVisible(colony.queenX, colony.queenY, vision)) continue;
    if (colony.status === "defeated") {
      drawRuin(colony.queenX, colony.queenY, QUEEN_RADIUS);
      continue;
    }
    circle(colony.queenX, colony.queenY, QUEEN_RADIUS, "#ce93d8", "#6a1b9a");
    drawHealthBar(colony.queenX, colony.queenY, QUEEN_RADIUS, colony.health, colony.maxHealth);
  }
  for (const worker of state.otherWorkers) {
    if (!isVisible(worker.x, worker.y, vision)) continue;
    const r = CASTE_RADIUS[worker.caste];
    circle(worker.x, worker.y, r, "#ce93d8", "#6a1b9a", CASTE_STROKE_WIDTH[worker.caste]);
    if (worker.carrying) drawCarryingBadge(worker.x, worker.y, r, worker.carrying.resourceType);
    drawHealthBar(worker.x, worker.y, r, worker.health, worker.maxHealth);
  }
  if (state.colony.status === "defeated") {
    drawRuin(state.colony.queenX, state.colony.queenY, QUEEN_RADIUS);
  } else {
    circle(state.colony.queenX, state.colony.queenY, QUEEN_RADIUS, "#ffd54d", "#b8860b");
    drawHealthBar(state.colony.queenX, state.colony.queenY, QUEEN_RADIUS, state.colony.queenHealth, state.colony.queenMaxHealth);
  }
  for (const worker of state.workers) {
    const r = CASTE_RADIUS[worker.caste];
    circle(worker.x, worker.y, r, "#90caf9", "#1565c0", CASTE_STROKE_WIDTH[worker.caste]);
    if (selectedWorkerIds.has(worker.id)) drawSelectionRing(worker.x, worker.y, r + 4);
    if (worker.carrying) drawCarryingBadge(worker.x, worker.y, r, worker.carrying.resourceType);
    drawHealthBar(worker.x, worker.y, r, worker.health, worker.maxHealth);
  }

  if (dragMode === "select" && dragged && selectionDrag) drawSelectionBox(selectionDrag);

  drawFogOverlay(vision);
}

// Fog is built as a mask, not a light: an offscreen buffer is filled with
// opaque darkness, then each vision source *erases* (destination-out) a
// soft-edged disc from that buffer only — never a translucent white circle
// painted onto the world. Erasing can't push alpha below zero, so overlap
// from several sources can only ever reach "fully erased" (= the normal,
// unfogged world), never past it — brightness is capped at the world's own
// appearance regardless of how many vision circles cover a pixel. The
// gradient's inner stop (fully erased) matches the hard VISION_RADIUS used by
// computeOwnVisionSources()/isVisible() for hit-testing; only a small band
// just inside that radius fades out, so the softened edge is purely visual
// and never changes what's actually visible/clickable. Finally the finished
// mask is composited (plain source-over) on top of the normally-drawn world.
const VISION_FALLOFF = 48; // world units of soft edge, inside the hard radius — visual only
const FOG_FILL = "rgba(10, 15, 10, 0.55)";

let fogCanvas: HTMLCanvasElement | null = null;
let fogCtx: CanvasRenderingContext2D | null = null;

function getFogCanvas(): CanvasRenderingContext2D {
  if (!fogCanvas || fogCanvas.width !== canvas.width || fogCanvas.height !== canvas.height) {
    fogCanvas = document.createElement("canvas");
    fogCanvas.width = canvas.width;
    fogCanvas.height = canvas.height;
    fogCtx = fogCanvas.getContext("2d")!;
  }
  return fogCtx!;
}

function drawFogOverlay(vision: VisionSource[]): void {
  if (!state) return;
  const fctx = getFogCanvas();
  fctx.clearRect(0, 0, fogCanvas!.width, fogCanvas!.height);
  fctx.fillStyle = FOG_FILL;
  fctx.fillRect(0, 0, fogCanvas!.width, fogCanvas!.height);
  fctx.save();
  fctx.globalCompositeOperation = "destination-out";
  for (const source of vision) {
    const [sx, sy] = worldToScreen(source.x, source.y);
    const innerRadius = Math.max(source.radius - VISION_FALLOFF, 0);
    const gradient = fctx.createRadialGradient(sx, sy, innerRadius, sx, sy, source.radius);
    gradient.addColorStop(0, "rgba(0, 0, 0, 1)");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    fctx.fillStyle = gradient;
    fctx.beginPath();
    fctx.arc(sx, sy, source.radius, 0, Math.PI * 2);
    fctx.fill();
  }
  fctx.restore();
  ctx.drawImage(fogCanvas!, 0, 0);
}

function renderResourceCounts(): void {
  if (!state) return;
  resourcesEl.textContent = Object.entries(state.colony.resources)
    .map(([type, amount]) => `${type}: ${amount}`)
    .join(" · ");
}

// Stage 9: each reproduce button always shows its caste's current live
// effective cost (Brood discounts included) — what's displayed is exactly
// what's deducted, never a stale static label. Stage 10: one button per
// caste, Brood's discount scales each caste's own base cost proportionally.
function renderReproduceCosts(): void {
  if (!state) return;
  for (const caste of CASTES) {
    reproduceButtons[caste].textContent = `${CASTE_DISPLAY_NAMES[caste]} (${state.colony.reproduceCosts[caste]} protein)`;
  }
}

function renderQueenHealth(): void {
  if (!state) return;
  queenHealthEl.textContent =
    state.colony.status === "active"
      ? `Queen health: ${Math.round(state.colony.queenHealth)}/${state.colony.queenMaxHealth}`
      : "Queen health: —";
}

function renderWorldEvents(): void {
  if (!state) return;
  worldEventsListEl.replaceChildren(
    ...state.worldEvents.map((event) => {
      const li = document.createElement("li");
      li.textContent = event.message;
      return li;
    }),
  );
}

// Stage 9: the tier/choice a confirm sub-step is currently open for, so the
// confirm button's click handler knows what to POST without re-deriving it
// from the DOM. Cleared on cancel/confirm/close, same lifecycle as any other
// transient UI selection in this file (selectedWorkerIds, dragStart, etc.).
let pendingEvolutionChoice: { tier: 1 | 2 | 3; choice: EvolutionChoice } | null = null;

function renderEvolutionPanel(): void {
  if (!state) return;
  const peak = state.colony.peakPopulation;
  const tiers: [1 | 2 | 3, EvolutionChoice | null][] = [
    [1, state.colony.evolutionTier1],
    [2, state.colony.evolutionTier2],
    [3, state.colony.evolutionTier3],
  ];

  const anyUnlockedUnchosen = tiers.some(([tier, chosen]) => chosen === null && peak >= EVOLUTION_TIER_POPULATION[tier]);
  evolutionBadge.hidden = !anyUnlockedUnchosen;

  evolutionPeakEl.textContent = `Peak population: ${peak}`;

  evolutionTiersEl.replaceChildren(
    ...tiers.map(([tier, chosen]) => {
      const threshold = EVOLUTION_TIER_POPULATION[tier];
      const section = document.createElement("div");
      section.className = "evolution-tier";
      const heading = document.createElement("h3");
      heading.textContent = `Tier ${tier}`;
      section.append(heading);

      if (chosen !== null) {
        const p = document.createElement("p");
        p.textContent = `${TRAIT_DISPLAY_NAMES[tier][chosen]} — ${TRAIT_EFFECT_TEXT[tier][chosen]}`;
        section.append(p);
      } else if (peak < threshold) {
        const p = document.createElement("p");
        p.className = "evolution-locked";
        p.textContent = `Locked — reach ${threshold} peak population.`;
        section.append(p);
      } else {
        const choices = document.createElement("div");
        choices.className = "evolution-choices";
        for (const choice of ["foraging", "survival", "brood"] as const) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = `${TRAIT_DISPLAY_NAMES[tier][choice]} — ${TRAIT_EFFECT_TEXT[tier][choice]}`;
          button.addEventListener("click", () => openEvolutionConfirm(tier, choice));
          choices.append(button);
        }
        section.append(choices);
      }
      return section;
    }),
  );

  evolutionOthersEl.replaceChildren(
    ...state.colonies
      .filter((c) => c.id !== state!.colony.id)
      .map((c) => {
        const li = document.createElement("li");
        const traitNames = [c.evolutionTier1, c.evolutionTier2, c.evolutionTier3]
          .map((choice, i) => (choice ? TRAIT_DISPLAY_NAMES[(i + 1) as 1 | 2 | 3][choice] : "—"))
          .join(", ");
        li.textContent =
          c.status === "defeated"
            ? `Fallen Colony ${c.id} — Peak population: ${c.peakPopulation} — Evolution: ${traitNames} — Fell to: ${c.defeatCause === "abandoned" ? "Abandoned" : "Spider"}`
            : `Colony ${c.id} — Workers: ${c.population} — Evolution: ${traitNames}`;
        return li;
      }),
  );
}

function openEvolutionConfirm(tier: 1 | 2 | 3, choice: EvolutionChoice): void {
  pendingEvolutionChoice = { tier, choice };
  evolutionConfirmText.textContent = `Choose ${TRAIT_DISPLAY_NAMES[tier][choice]}? ${TRAIT_EFFECT_TEXT[tier][choice]} This evolution is permanent for this colony.`;
  evolutionConfirmOverlay.hidden = false;
}

function closeEvolutionConfirm(): void {
  pendingEvolutionChoice = null;
  evolutionConfirmOverlay.hidden = true;
}

evolutionConfirmCancel.addEventListener("click", closeEvolutionConfirm);
evolutionConfirmOverlay.addEventListener("click", (e) => {
  if (e.target === evolutionConfirmOverlay) closeEvolutionConfirm();
});

evolutionConfirmButton.addEventListener("click", async () => {
  if (!pendingEvolutionChoice) return;
  const { tier, choice } = pendingEvolutionChoice;
  const res = await fetch("/api/evolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tier, choice }),
  });
  const body = await res.json();
  closeEvolutionConfirm();
  if (!res.ok) {
    statusEl.textContent = body.error ?? "evolution failed";
    return;
  }
  statusEl.textContent = `Evolved: ${TRAIT_DISPLAY_NAMES[tier][choice]}.`;
  setState(body);
});

// Stage 9: same discoverable, non-blocking modal convention as Help — opening
// it never touches `state` or issues a command.
function openEvolution(): void {
  evolutionOverlay.hidden = false;
}
function closeEvolution(): void {
  evolutionOverlay.hidden = true;
  closeEvolutionConfirm();
}
evolutionButton.addEventListener("click", openEvolution);
evolutionClose.addEventListener("click", closeEvolution);
evolutionOverlay.addEventListener("click", (e) => {
  if (e.target === evolutionOverlay) closeEvolution();
});
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!evolutionConfirmOverlay.hidden) closeEvolutionConfirm();
  else if (!evolutionOverlay.hidden) closeEvolution();
});

// Stage 8: tracks the colony id the defeat overlay was last shown/hidden
// for, so a Start New Colony response (a *different* colony id, also
// active) doesn't get misread as "still the same defeated colony."
let lastSeenColonyId: number | null = null;

function renderLifecycle(): void {
  if (!state) return;
  const isDefeated = state.colony.status === "defeated";
  defeatOverlay.hidden = !isDefeated;
  abandonButton.disabled = isDefeated;
  recallAllButton.disabled = isDefeated;
  for (const caste of CASTES) reproduceButtons[caste].disabled = isDefeated;
  if (isDefeated) {
    defeatMessageEl.textContent =
      state.colony.defeatCause === "abandoned"
        ? "You abandoned this colony. Your queen and workers are gone, and your stored resources were lost."
        : "Your queen was killed. Your workers are gone, and your stored resources were lost.";
  }
  // A successful Start New Colony response lands here with a fresh, active
  // colony id different from the one the overlay was showing — recentre the
  // camera and drop any stale selection, same as a brand-new session's first
  // load, but without a page reload.
  if (lastSeenColonyId !== null && lastSeenColonyId !== state.colony.id) {
    selectedWorkerIds = new Set();
    cameraInitialised = false;
  }
  lastSeenColonyId = state.colony.id;
}

function setState(next: ColonyState): void {
  state = next;
  renderLifecycle();
  if (!cameraInitialised) {
    camera.x = next.colony.queenX;
    camera.y = next.colony.queenY;
    clampCamera();
    cameraInitialised = true;
  }
  renderResourceCounts();
  renderQueenHealth();
  renderReproduceCosts();
  renderWorldEvents();
  renderEvolutionPanel();
  renderIdentity();
}

function renderIdentity(): void {
  if (!state) return;
  const { identity } = state;
  if (identity.status === "account") {
    identityIndicatorEl.textContent = `Signed in as ${identity.username}`;
    saveProgressButton.hidden = true;
    accountButton.hidden = false;
    logoutButton.hidden = false;
  } else {
    identityIndicatorEl.textContent = "Playing as guest";
    saveProgressButton.hidden = false;
    accountButton.hidden = true;
    logoutButton.hidden = true;
  }
  adminLink.hidden = identity.role !== "admin";
}

// --- WASD / arrow-key panning ------------------------------------------

const keysDown = new Set<string>();
window.addEventListener("keydown", (e) => keysDown.add(e.key.toLowerCase()));
window.addEventListener("keyup", (e) => keysDown.delete(e.key.toLowerCase()));

let lastFrame = performance.now();
function frame(now: number): void {
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;

  if (state) {
    let dx = 0;
    let dy = 0;
    if (keysDown.has("w") || keysDown.has("arrowup")) dy -= 1;
    if (keysDown.has("s") || keysDown.has("arrowdown")) dy += 1;
    if (keysDown.has("a") || keysDown.has("arrowleft")) dx -= 1;
    if (keysDown.has("d") || keysDown.has("arrowright")) dx += 1;
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      camera.x += (dx / len) * PAN_SPEED * dt;
      camera.y += (dy / len) * PAN_SPEED * dt;
      clampCamera();
    }
  }

  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- mouse controls -----------------------------------------------------
// Left button: drag a box to select workers inside it, or click (no drag) to
// select a single worker / issue a move / gather. Middle or right button:
// drag to pan the camera. One button, one meaning — never both at once, so
// there's no ambiguity about which gesture a drag is. See CLAUDE.md.

let dragStart: { x: number; y: number; camX: number; camY: number } | null = null;
let dragMode: "pan" | "select" | null = null;
let dragged = false;
let selectionDrag: { startWorld: [number, number]; currentWorld: [number, number] } | null = null;

// Right-drag-to-pan would otherwise pop the browser's context menu on mouseup.
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  dragStart = { x, y, camX: camera.x, camY: camera.y };
  dragMode = e.button === 0 ? "select" : "pan";
  dragged = false;
  selectionDrag = dragMode === "select" ? { startWorld: screenToWorld(x, y), currentWorld: screenToWorld(x, y) } : null;
});

window.addEventListener("mousemove", (e) => {
  if (!dragStart) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const dx = x - dragStart.x;
  const dy = y - dragStart.y;
  if (!dragged && Math.hypot(dx, dy) > DRAG_THRESHOLD) dragged = true;
  if (!dragged) return;

  if (dragMode === "pan") {
    camera.x = dragStart.camX - dx;
    camera.y = dragStart.camY - dy;
    clampCamera();
  } else if (dragMode === "select" && selectionDrag) {
    // World-space, not screen-space: re-derived every move so the box stays
    // correct even if WASD panning shifts the camera mid-drag.
    selectionDrag.currentWorld = screenToWorld(x, y);
  }
});

window.addEventListener("mouseup", (e) => {
  if (!dragStart) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  if (dragMode === "select") {
    if (dragged && selectionDrag) {
      selectWorkersInBox(selectionDrag.startWorld, selectionDrag.currentWorld);
    } else {
      onCanvasClick(x, y);
    }
  }

  dragStart = null;
  dragMode = null;
  dragged = false;
  selectionDrag = null;
});

// Selects every worker whose centre (not just a partial overlap) falls
// inside the box; an empty box clears the selection, matching normal RTS
// drag-select behaviour.
function selectWorkersInBox(a: [number, number], b: [number, number]): void {
  if (!state) return;
  const minX = Math.min(a[0], b[0]);
  const maxX = Math.max(a[0], b[0]);
  const minY = Math.min(a[1], b[1]);
  const maxY = Math.max(a[1], b[1]);
  const hits = state.workers.filter((w) => w.x >= minX && w.x <= maxX && w.y >= minY && w.y <= maxY);
  selectedWorkerIds = new Set(hits.map((w) => w.id));
  if (selectedWorkerIds.size > 0) {
    const counts: Record<Caste, number> = { worker: 0, soldier: 0, scout: 0 };
    for (const w of hits) counts[w.caste]++;
    const breakdown = CASTES.filter((c) => counts[c] > 0)
      .map((c) => `${counts[c]} ${CASTE_DISPLAY_NAMES[c]}${counts[c] === 1 ? "" : "s"}`)
      .join(", ");
    statusEl.textContent = `${breakdown} selected — click a resource node to gather, or empty ground to move.`;
  } else {
    statusEl.textContent = "";
  }
}

function hitTest(wx: number, wy: number): { kind: "worker" | "creature" | "node"; id: number } | null {
  if (!state) return null;
  for (const worker of state.workers) {
    if (Math.hypot(worker.x - wx, worker.y - wy) <= CASTE_RADIUS[worker.caste]) return { kind: "worker", id: worker.id };
  }
  // Stage 10 (revised): a click can only ever resolve to something inside
  // this colony's own vision — a hidden creature/node is never hit, so a
  // blind click into fog always falls through to onCanvasClick's plain-move
  // branch, exactly like clicking any other empty ground.
  const vision = computeOwnVisionSources();
  // Stage 6: creatures are clickable (not selectable) — checked before nodes
  // so a click on an aphid standing over/near a resource node always hits
  // the creature, never falls through to the node underneath it.
  for (const creature of state.creatures) {
    if (!isVisible(creature.x, creature.y, vision)) continue;
    const r = creature.species === "spider" ? SPIDER_RADIUS : APHID_RADIUS;
    if (Math.hypot(creature.x - wx, creature.y - wy) <= r + 4) return { kind: "creature", id: creature.id };
  }
  for (const node of state.resourceNodes) {
    if (!isVisible(node.x, node.y, vision)) continue;
    const r = NODE_RADIUS[node.resourceType] ?? 10;
    if (Math.hypot(node.x - wx, node.y - wy) <= r) return { kind: "node", id: node.id };
  }
  return null;
}

function onCanvasClick(sx: number, sy: number): void {
  const [wx, wy] = screenToWorld(sx, sy);
  const hit = hitTest(wx, wy);

  if (!hit) {
    if (selectedWorkerIds.size > 0) onMoveClick(wx, wy);
    return;
  }

  if (hit.kind === "worker") {
    // A plain click always replaces the selection with just this worker —
    // no shift-add, no toggle-off. Drag-select (selectWorkersInBox) is the
    // only way to select more than one.
    selectedWorkerIds = new Set([hit.id]);
    const worker = state?.workers.find((w) => w.id === hit.id);
    const carryingSuffix = worker?.carrying ? ` (carrying ${worker.carrying.amount} ${worker.carrying.resourceType})` : "";
    statusEl.textContent = `Worker #${hit.id} selected${carryingSuffix} — click a resource node to gather, or empty ground to move.`;
    return;
  }
  if (hit.kind === "creature") {
    onCreatureClick(hit.id);
    return;
  }
  onNodeClick(hit.id);
}

// Commands never clear the selection — a worker can be issued several
// commands in a row (or stay selected to watch it arrive) without reselecting.
async function onMoveClick(wx: number, wy: number): Promise<void> {
  const workerIds = [...selectedWorkerIds];
  if (workerIds.length === 0) return;
  const res = await fetch("/api/command/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds, x: wx, y: wy }),
  });
  const body = await res.json();
  if (!res.ok) {
    statusEl.textContent = body.error ?? "move failed";
    return;
  }
  statusEl.textContent = describeBatchOutcome(workerIds.length, body.errors, "moving");
  setState(body);
}

// Pure camera/navigation — no fetch, no server round-trip, no selection
// change. Mirrors the same recentre setState() already does on first load.
function onReturnToQueenClick(): void {
  if (!state) return;
  camera.x = state.colony.queenX;
  camera.y = state.colony.queenY;
  clampCamera();
}

// Reuses the move command's existing group-destination spacing
// (computeGroupDestinations, server-side) by sending every living unit's id
// in one batch move to the queen's position — same spiral spacing a
// multi-worker click-to-move already gets, just targeting the queen instead
// of a clicked point. Never teleports: this is the same travel command as
// any other move, just with a destination and a wider worker set.
async function onRecallAllClick(): Promise<void> {
  if (!state || state.colony.status !== "active") return;
  const workerIds = state.workers.map((w) => w.id);
  if (workerIds.length === 0) return;
  const res = await fetch("/api/command/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds, x: state.colony.queenX, y: state.colony.queenY }),
  });
  const body = await res.json();
  if (!res.ok) {
    statusEl.textContent = body.error ?? "recall failed";
    return;
  }
  statusEl.textContent = describeBatchOutcome(workerIds.length, body.errors, "recalled");
  setState(body);
}

async function onNodeClick(nodeId: number): Promise<void> {
  const workerIds = [...selectedWorkerIds];
  if (workerIds.length === 0) {
    statusEl.textContent = "Select a worker first.";
    return;
  }
  const res = await fetch("/api/command/gather", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds, resourceId: nodeId }),
  });
  const body = await res.json();
  if (!res.ok) {
    statusEl.textContent = body.error ?? "gather failed";
    return;
  }
  statusEl.textContent = describeBatchOutcome(workerIds.length, body.errors, "heading to the resource");
  setState(body);
}

// Stage 6: mirrors onNodeClick's gather-dispatch shape exactly — same
// selected-workers precondition, same describeBatchOutcome() call for
// errors — just targeting a creature instead of a resource node.
async function onCreatureClick(creatureId: number): Promise<void> {
  const workerIds = [...selectedWorkerIds];
  if (workerIds.length === 0) {
    statusEl.textContent = "Select a worker first.";
    return;
  }
  const res = await fetch("/api/command/attack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds, creatureId }),
  });
  const body = await res.json();
  if (!res.ok) {
    statusEl.textContent = body.error ?? "attack failed";
    return;
  }
  statusEl.textContent = describeBatchOutcome(workerIds.length, body.errors, "attacking");
  setState(body);
}

// Names exactly how many of a batch command succeeded, surfacing a partial
// failure (some invalid ids, see runBatchCommand in index.ts) instead of
// silently reporting the whole batch as a plain success.
function describeBatchOutcome(total: number, errors: Record<string, string> | undefined, verb: string): string {
  const failed = errors ? Object.keys(errors).length : 0;
  const succeeded = total - failed;
  if (failed === 0) return `${succeeded} worker${succeeded === 1 ? "" : "s"} ${verb}.`;
  return `${succeeded}/${total} workers ${verb} (${failed} failed).`;
}

// Stage 6b: discoverable in-game help, opened/closed independently of
// everything else — never touches `state` or issues a command, so it's safe
// to open at any time, mid-selection or mid-drag, without side effects.
function openHelp(): void {
  helpOverlay.hidden = false;
}
function closeHelp(): void {
  helpOverlay.hidden = true;
}
helpButton.addEventListener("click", openHelp);
helpClose.addEventListener("click", closeHelp);
helpOverlay.addEventListener("click", (e) => {
  if (e.target === helpOverlay) closeHelp(); // click on the backdrop, not the panel itself
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !helpOverlay.hidden) closeHelp();
});

// Stage 8: same discoverable-modal convention as the Help overlay (hidden
// attribute toggle, Escape/backdrop-click-to-close) — opening it never
// touches `state` or issues a command. Only the explicit "Abandon Colony"
// confirm button inside it calls the server.
function openAbandonModal(): void {
  abandonOverlay.hidden = false;
}
function closeAbandonModal(): void {
  abandonOverlay.hidden = true;
}
abandonButton.addEventListener("click", openAbandonModal);
abandonCancel.addEventListener("click", closeAbandonModal);
abandonOverlay.addEventListener("click", (e) => {
  if (e.target === abandonOverlay) closeAbandonModal();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !abandonOverlay.hidden) closeAbandonModal();
});

abandonConfirm.addEventListener("click", async () => {
  const res = await fetch("/api/abandon", { method: "POST" });
  const body = await res.json();
  closeAbandonModal();
  if (!res.ok) {
    statusEl.textContent = body.error ?? "abandon failed";
    return;
  }
  selectedWorkerIds = new Set();
  statusEl.textContent = "Colony abandoned.";
  setState(body);
});

returnToQueenButton.addEventListener("click", onReturnToQueenClick);
recallAllButton.addEventListener("click", onRecallAllClick);

startNewColonyButton.addEventListener("click", async () => {
  const res = await fetch("/api/start-new-colony", { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    statusEl.textContent = body.error ?? "start new colony failed";
    return;
  }
  statusEl.textContent = "A new colony has begun.";
  setState(body);
});

for (const caste of CASTES) {
  reproduceButtons[caste].addEventListener("click", async () => {
    const res = await fetch("/api/reproduce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caste }),
    });
    const body = await res.json();
    if (!res.ok) {
      statusEl.textContent = body.error ?? "reproduce failed";
      return;
    }
    selectedWorkerIds = new Set();
    statusEl.textContent = `A new ${CASTE_DISPLAY_NAMES[caste].toLowerCase()} hatched!`;
    setState(body);
  });
}

async function refresh(): Promise<void> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`GET /api/state -> ${res.status}`);
  setState(await res.json());
}

let activeWs: WebSocket | null = null;
// Sockets we closed ourselves (as part of re-running enterGame for an auth
// transition) so their own "close" event doesn't also trigger a reconnect —
// only a close we didn't initiate (e.g. the server force-closing every
// connection after admin Reset World) should do that.
const intentionallyClosedSockets = new WeakSet<WebSocket>();

// Crit 10: the WebSocket connects only after the first /api/state fetch
// resolves, not alongside it. The very first request from a fresh browser
// profile is what sets the `sid` session cookie; opening the WS connection
// before that response lands would race the cookie and let the WS handshake
// go out cookie-less, minting a second, separate colony for the same player.
// See CLAUDE.md's Crit 10 section.
//
// Stage 11: factored into a named function so every auth transition
// (register/login/logout/reset-progress) can re-run it after closing any
// previously open socket, rather than only ever running once at page load.
// It's also the reconnect target for a server-forced close (admin Reset
// World closes every wss.clients connection) — see the "close" listener
// below, which re-invokes this; a now-unrecognized/wiped session degrades
// safely back to the entry gate because GET /api/session simply reports
// "anonymous" for it, reusing Stage 6b's existing wiped-sessions precedent.
async function enterGame(): Promise<void> {
  entryOverlay.hidden = true;
  if (activeWs) {
    intentionallyClosedSockets.add(activeWs);
    activeWs.close();
    activeWs = null;
  }
  await refresh();
  const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${wsProtocol}//${location.host}/ws`);
  activeWs = ws;
  ws.addEventListener("message", (event) => {
    setState(JSON.parse(event.data as string));
  });
  ws.addEventListener("close", () => {
    if (intentionallyClosedSockets.has(ws)) return;
    if (activeWs !== ws) return;
    activeWs = null;
    bootstrap().catch((err) => {
      statusEl.textContent = `Connection lost: ${String(err)}`;
    });
  });
}

entryGuestButton.addEventListener("click", async () => {
  entryStatusEl.textContent = "";
  const res = await fetch("/api/auth/guest", { method: "POST" });
  if (!res.ok) {
    entryStatusEl.textContent = "Failed to continue as guest.";
    return;
  }
  await enterGame();
});

entryRegisterForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  entryStatusEl.textContent = "";
  const res = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: entryRegisterUsername.value, password: entryRegisterPassword.value }),
  });
  const body = await res.json();
  if (!res.ok) {
    entryStatusEl.textContent = body.error ?? "Registration failed.";
    return;
  }
  entryRegisterForm.reset();
  await enterGame();
});

entryLoginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  entryStatusEl.textContent = "";
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: entryLoginUsername.value, password: entryLoginPassword.value }),
  });
  const body = await res.json();
  if (!res.ok) {
    entryStatusEl.textContent = body.error ?? "Login failed.";
    return;
  }
  entryLoginForm.reset();
  await enterGame();
});

saveProgressButton.addEventListener("click", () => {
  registerStatusEl.textContent = "";
  registerForm.reset();
  registerOverlay.hidden = false;
});

registerCancel.addEventListener("click", () => {
  registerOverlay.hidden = true;
});

registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  registerStatusEl.textContent = "";
  const res = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: registerUsername.value, password: registerPassword.value }),
  });
  const body = await res.json();
  if (!res.ok) {
    registerStatusEl.textContent = body.error ?? "Registration failed.";
    return;
  }
  registerOverlay.hidden = true;
  statusEl.textContent = `Account created. Signed in as ${body.username}.`;
  await enterGame();
});

logoutButton.addEventListener("click", async () => {
  const res = await fetch("/api/auth/logout", { method: "POST" });
  if (!res.ok) {
    statusEl.textContent = "Logout failed.";
    return;
  }
  entryOverlay.hidden = false;
  entryStatusEl.textContent = "";
  await enterGame();
});

accountButton.addEventListener("click", () => {
  accountStatusEl.textContent = "";
  resetProgressConfirm.value = "";
  resetProgressButton.disabled = true;
  accountOverlay.hidden = false;
});

accountClose.addEventListener("click", () => {
  accountOverlay.hidden = true;
});

resetProgressConfirm.addEventListener("input", () => {
  resetProgressButton.disabled = resetProgressConfirm.value !== "RESET";
});

resetProgressButton.addEventListener("click", async () => {
  if (resetProgressConfirm.value !== "RESET") return;
  const res = await fetch("/api/account/reset-progress", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: resetProgressConfirm.value }),
  });
  const body = await res.json();
  if (!res.ok) {
    accountStatusEl.textContent = body.error ?? "Reset failed.";
    return;
  }
  accountOverlay.hidden = true;
  selectedWorkerIds = new Set();
  statusEl.textContent = "Your progress has been reset. A new colony has begun.";
  setState(body);
});

async function bootstrap(): Promise<void> {
  try {
    const res = await fetch("/api/session");
    const session: { status: "anonymous" | "guest" | "account" } = await res.json();
    if (session.status === "anonymous") {
      entryOverlay.hidden = false;
      return;
    }
    await enterGame();
  } catch (err) {
    statusEl.textContent = `Failed to load the colony: ${String(err)}`;
  }
}

bootstrap();
