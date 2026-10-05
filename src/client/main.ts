interface ColonyState {
  colony: { id: number; protein: number; queenX: number; queenY: number };
  workers: { id: number; x: number; y: number }[];
  resourceNodes: { id: number; x: number; y: number; resourceType: string }[];
}

const CELL = 36;
let selectedWorkerId: number | null = null;

const mapEl = document.querySelector<HTMLDivElement>("#map")!;
const proteinEl = document.querySelector<HTMLElement>("#protein")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;

function place(el: HTMLElement, x: number, y: number): void {
  el.style.left = `${x * CELL}px`;
  el.style.top = `${y * CELL}px`;
}

function render(state: ColonyState): void {
  mapEl.innerHTML = "";
  proteinEl.textContent = String(state.colony.protein);

  const queen = document.createElement("div");
  queen.className = "entity queen";
  queen.title = "Queen";
  queen.textContent = "Q";
  place(queen, state.colony.queenX, state.colony.queenY);
  mapEl.appendChild(queen);

  for (const node of state.resourceNodes) {
    const el = document.createElement("div");
    el.className = "entity node";
    el.title = `Food node #${node.id}`;
    el.textContent = "F";
    place(el, node.x, node.y);
    el.addEventListener("click", () => onNodeClick(node.id));
    mapEl.appendChild(el);
  }

  for (const worker of state.workers) {
    const el = document.createElement("div");
    el.className = "entity worker" + (worker.id === selectedWorkerId ? " selected" : "");
    el.title = `Worker #${worker.id}`;
    el.textContent = "W";
    place(el, worker.x, worker.y);
    el.addEventListener("click", () => onWorkerClick(worker.id));
    mapEl.appendChild(el);
  }
}

function onWorkerClick(workerId: number): void {
  selectedWorkerId = selectedWorkerId === workerId ? null : workerId;
  statusEl.textContent = selectedWorkerId
    ? `Worker #${selectedWorkerId} selected — click a food node to gather.`
    : "";
  refresh().catch((err) => {
    statusEl.textContent = `Failed to refresh: ${String(err)}`;
  });
}

async function onNodeClick(nodeId: number): Promise<void> {
  if (selectedWorkerId === null) {
    statusEl.textContent = "Select a worker first.";
    return;
  }
  const res = await fetch("/api/gather", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerId: selectedWorkerId, nodeId }),
  });
  const state = await res.json();
  if (!res.ok) {
    statusEl.textContent = state.error ?? "gather failed";
    return;
  }
  statusEl.textContent = "Gathered!";
  render(state);
}

async function refresh(): Promise<void> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`GET /api/state -> ${res.status}`);
  render(await res.json());
}

refresh().catch((err) => {
  mapEl.textContent = `Failed to load the colony: ${String(err)}`;
});
