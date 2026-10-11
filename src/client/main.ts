interface ColonyState {
  world: { width: number; height: number };
  colony: { id: number; queenX: number; queenY: number; resources: Record<string, number> };
  workers: { id: number; x: number; y: number }[];
  resourceNodes: {
    id: number;
    x: number;
    y: number;
    resourceType: string;
    amount: number | null;
    maxAmount: number | null;
  }[];
}

const canvas = document.querySelector<HTMLCanvasElement>("#world")!;
const ctx = canvas.getContext("2d")!;
const resourcesEl = document.querySelector<HTMLElement>("#resources")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const reproduceBtn = document.querySelector<HTMLButtonElement>("#reproduce")!;

const WORKER_RADIUS = 10;
const QUEEN_RADIUS = 20;
const NODE_RADIUS: Record<string, number> = { sugar: 8, protein: 14, biomass: 20 };
const NODE_COLOR: Record<string, string> = { sugar: "#f4c542", protein: "#90caf9", biomass: "#8d6e63" };
const PAN_SPEED = 600; // world units per second
const DRAG_THRESHOLD = 4; // screen px of movement before a mousedown counts as a pan, not a click

let state: ColonyState | null = null;
let selectedWorkerId: number | null = null;
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

function draw(): void {
  ctx.fillStyle = "#eef7ee";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!state) return;

  for (const node of state.resourceNodes) {
    circle(node.x, node.y, NODE_RADIUS[node.resourceType] ?? 10, NODE_COLOR[node.resourceType] ?? "#a5d6a7", "#2e7d32");
  }
  circle(state.colony.queenX, state.colony.queenY, QUEEN_RADIUS, "#ffd54d", "#b8860b");
  for (const worker of state.workers) {
    circle(worker.x, worker.y, WORKER_RADIUS, "#90caf9", worker.id === selectedWorkerId ? "#e91e63" : "#1565c0");
  }
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

// --- mouse drag-to-pan, falling back to click-to-select/gather ---------

let dragStart: { x: number; y: number; camX: number; camY: number } | null = null;
let dragged = false;

canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  dragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top, camX: camera.x, camY: camera.y };
  dragged = false;
});

window.addEventListener("mousemove", (e) => {
  if (!dragStart) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const dx = x - dragStart.x;
  const dy = y - dragStart.y;
  if (!dragged && Math.hypot(dx, dy) > DRAG_THRESHOLD) dragged = true;
  if (dragged) {
    camera.x = dragStart.camX - dx;
    camera.y = dragStart.camY - dy;
    clampCamera();
  }
});

window.addEventListener("mouseup", (e) => {
  if (!dragStart) return;
  const rect = canvas.getBoundingClientRect();
  if (!dragged) onCanvasClick(e.clientX - rect.left, e.clientY - rect.top);
  dragStart = null;
});

function hitTest(wx: number, wy: number): { kind: "worker" | "node"; id: number } | null {
  if (!state) return null;
  for (const worker of state.workers) {
    if (Math.hypot(worker.x - wx, worker.y - wy) <= WORKER_RADIUS) return { kind: "worker", id: worker.id };
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
    if (selectedWorkerId !== null) onMoveClick(wx, wy);
    return;
  }

  if (hit.kind === "worker") {
    selectedWorkerId = selectedWorkerId === hit.id ? null : hit.id;
    statusEl.textContent = selectedWorkerId
      ? `Worker #${selectedWorkerId} selected — click a resource node to gather, or empty ground to move.`
      : "";
    return;
  }
  onNodeClick(hit.id);
}

async function onMoveClick(wx: number, wy: number): Promise<void> {
  const workerId = selectedWorkerId;
  if (workerId === null) return;
  const res = await fetch("/api/command/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [workerId], x: wx, y: wy }),
  });
  const body = await res.json();
  if (!res.ok) {
    statusEl.textContent = body.error ?? "move failed";
    return;
  }
  statusEl.textContent = `Worker #${workerId} is moving.`;
  setState(body);
}

async function onNodeClick(nodeId: number): Promise<void> {
  if (selectedWorkerId === null) {
    statusEl.textContent = "Select a worker first.";
    return;
  }
  const workerId = selectedWorkerId;
  const res = await fetch("/api/command/gather", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [workerId], resourceId: nodeId }),
  });
  const body = await res.json();
  if (!res.ok) {
    statusEl.textContent = body.error ?? "gather failed";
    return;
  }
  statusEl.textContent = `Worker #${workerId} is heading to the resource.`;
  setState(body);
}

reproduceBtn.addEventListener("click", async () => {
  const res = await fetch("/api/reproduce", { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    statusEl.textContent = body.error ?? "reproduce failed";
    return;
  }
  selectedWorkerId = null;
  statusEl.textContent = "A new worker hatched!";
  setState(body);
});

async function refresh(): Promise<void> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`GET /api/state -> ${res.status}`);
  setState(await res.json());
}

refresh().catch((err) => {
  statusEl.textContent = `Failed to load the colony: ${String(err)}`;
});

const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
const ws = new WebSocket(`${wsProtocol}//${location.host}/ws`);
ws.addEventListener("message", (event) => {
  setState(JSON.parse(event.data as string));
});
