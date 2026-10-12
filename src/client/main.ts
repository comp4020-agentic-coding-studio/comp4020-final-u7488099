import { APHID_RADIUS, WORKER_RADIUS } from "../server/balance.ts";

interface ColonyState {
  world: { width: number; height: number };
  colony: { id: number; queenX: number; queenY: number; resources: Record<string, number> };
  workers: { id: number; x: number; y: number; carrying: { resourceType: string; amount: number } | null }[];
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
  colonies: { id: number; queenX: number; queenY: number }[];
}

const canvas = document.querySelector<HTMLCanvasElement>("#world")!;
const ctx = canvas.getContext("2d")!;
const resourcesEl = document.querySelector<HTMLElement>("#resources")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const reproduceBtn = document.querySelector<HTMLButtonElement>("#reproduce")!;
const helpButton = document.querySelector<HTMLButtonElement>("#help-button")!;
const helpOverlay = document.querySelector<HTMLElement>("#help-overlay")!;
const helpClose = document.querySelector<HTMLButtonElement>("#help-close")!;

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

function circle(wx: number, wy: number, r: number, fill: string, stroke: string): void {
  const [sx, sy] = worldToScreen(wx, wy);
  if (sx < -r || sy < -r || sx > canvas.width + r || sy > canvas.height + r) return;
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.stroke();
}

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

function draw(): void {
  ctx.fillStyle = "#eef7ee";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!state) return;

  for (const node of state.resourceNodes) {
    drawResourceNode(node);
  }
  for (const creature of state.creatures) {
    diamond(creature.x, creature.y, APHID_RADIUS, "#7cb342", "#33691e");
    drawHealthBar(creature.x, creature.y, APHID_RADIUS, creature.health, creature.maxHealth);
  }
  // Crit 10: every other colony's queen is part of the shared world this
  // session can see, drawn in a distinct colour from "your own" gold queen
  // below so the two are never confused. No workers/resources are rendered
  // for them — getState() never sends another colony's private economy.
  for (const colony of state.colonies) {
    if (colony.id === state.colony.id) continue;
    circle(colony.queenX, colony.queenY, QUEEN_RADIUS, "#ce93d8", "#6a1b9a");
  }
  circle(state.colony.queenX, state.colony.queenY, QUEEN_RADIUS, "#ffd54d", "#b8860b");
  for (const worker of state.workers) {
    circle(worker.x, worker.y, WORKER_RADIUS, "#90caf9", "#1565c0");
    if (selectedWorkerIds.has(worker.id)) drawSelectionRing(worker.x, worker.y, WORKER_RADIUS + 4);
    if (worker.carrying) drawCarryingBadge(worker.x, worker.y, WORKER_RADIUS, worker.carrying.resourceType);
  }

  if (dragMode === "select" && dragged && selectionDrag) drawSelectionBox(selectionDrag);
}

function renderResourceCounts(): void {
  if (!state) return;
  resourcesEl.textContent = Object.entries(state.colony.resources)
    .map(([type, amount]) => `${type}: ${amount}`)
    .join(" · ");
}

function setState(next: ColonyState): void {
  state = next;
  if (!cameraInitialised) {
    camera.x = next.colony.queenX;
    camera.y = next.colony.queenY;
    clampCamera();
    cameraInitialised = true;
  }
  renderResourceCounts();
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
  statusEl.textContent =
    selectedWorkerIds.size > 0
      ? `${selectedWorkerIds.size} worker${selectedWorkerIds.size === 1 ? "" : "s"} selected — click a resource node to gather, or empty ground to move.`
      : "";
}

function hitTest(wx: number, wy: number): { kind: "worker" | "creature" | "node"; id: number } | null {
  if (!state) return null;
  for (const worker of state.workers) {
    if (Math.hypot(worker.x - wx, worker.y - wy) <= WORKER_RADIUS) return { kind: "worker", id: worker.id };
  }
  // Stage 6: creatures are clickable (not selectable) — checked before nodes
  // so a click on an aphid standing over/near a resource node always hits
  // the creature, never falls through to the node underneath it.
  for (const creature of state.creatures) {
    if (Math.hypot(creature.x - wx, creature.y - wy) <= APHID_RADIUS + 4) return { kind: "creature", id: creature.id };
  }
  for (const node of state.resourceNodes) {
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

reproduceBtn.addEventListener("click", async () => {
  const res = await fetch("/api/reproduce", { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    statusEl.textContent = body.error ?? "reproduce failed";
    return;
  }
  selectedWorkerIds = new Set();
  statusEl.textContent = "A new worker hatched!";
  setState(body);
});

async function refresh(): Promise<void> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`GET /api/state -> ${res.status}`);
  setState(await res.json());
}

// Crit 10: the WebSocket connects only after this first fetch resolves, not
// alongside it. The very first request from a fresh browser profile is what
// sets the `sid` session cookie; opening the WS connection before that
// response lands would race the cookie and let the WS handshake go out
// cookie-less, minting a second, separate colony for the same player. See
// CLAUDE.md's Crit 10 section.
refresh()
  .then(() => {
    const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${wsProtocol}//${location.host}/ws`);
    ws.addEventListener("message", (event) => {
      setState(JSON.parse(event.data as string));
    });
  })
  .catch((err) => {
    statusEl.textContent = `Failed to load the colony: ${String(err)}`;
  });
