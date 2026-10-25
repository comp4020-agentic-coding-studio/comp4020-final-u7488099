// Stage 11: the standalone admin page. Separate esbuild entry point from
// main.ts, served at /admin (see index.ts's explicit route) — never merged
// into the game SPA. The real authorization gate is server-side
// (requireAdmin in index.ts, reading req.role resolved fresh from the
// session's account row); this page's own 403 handling below is purely UX —
// it never embeds any admin data in its own markup/bundle, and stops making
// further admin calls the moment any one of them 403s.

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

const unauthorizedEl = document.getElementById("unauthorized") as HTMLDivElement;
const rootEl = document.getElementById("admin-root") as HTMLDivElement;
const whoamiEl = document.getElementById("whoami") as HTMLParagraphElement;
const statsGridEl = document.getElementById("stats-grid") as HTMLDivElement;
const accountsBodyEl = document.getElementById("accounts-body") as HTMLTableSectionElement;
const coloniesBodyEl = document.getElementById("colonies-body") as HTMLTableSectionElement;
const logListEl = document.getElementById("log-list") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const resetWorldConfirmEl = document.getElementById("reset-world-confirm") as HTMLInputElement;
const resetWorldButtonEl = document.getElementById("reset-world-button") as HTMLButtonElement;

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
}

bootstrap().catch((err) => {
  statusEl.textContent = `Failed to load admin data: ${String(err)}`;
});
