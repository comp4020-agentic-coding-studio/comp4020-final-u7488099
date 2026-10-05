interface ColonyState {
  colony: { id: number; protein: number; queenX: number; queenY: number };
  workers: { id: number; x: number; y: number }[];
  resourceNodes: { id: number; x: number; y: number; resourceType: string }[];
}

const CELL = 36;

const mapEl = document.querySelector<HTMLDivElement>("#map")!;
const proteinEl = document.querySelector<HTMLElement>("#protein")!;

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
    mapEl.appendChild(el);
  }

  for (const worker of state.workers) {
    const el = document.createElement("div");
    el.className = "entity worker";
    el.title = `Worker #${worker.id}`;
    el.textContent = "W";
    place(el, worker.x, worker.y);
    mapEl.appendChild(el);
  }
}

async function refresh(): Promise<void> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`GET /api/state -> ${res.status}`);
  render(await res.json());
}

refresh().catch((err) => {
  mapEl.textContent = `Failed to load the colony: ${String(err)}`;
});
