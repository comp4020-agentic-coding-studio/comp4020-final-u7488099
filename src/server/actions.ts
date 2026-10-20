import type { Caste } from "./balance.ts";
import { db } from "./db.ts";
import { type EvolutionChoice, getEvolutionModifiers, tierThreshold } from "./evolution.ts";
import {
  applyEvolutionSelection,
  defeatColony,
  getColonyEvolution,
  isColonyActive,
  maybeUpdatePeakPopulation,
  registerWorker,
} from "./simulation.ts";

export type ActionResult = { ok: true } | { ok: false; error: string };

const VALID_CASTES: Caste[] = ["worker", "soldier", "scout"];

// Stage 10 §7/§8: colonyId always resolves exclusively from session
// middleware at the call site (index.ts) — the client requests a caste,
// never colony authority.
export function reproduce(colonyId: number, caste: Caste): ActionResult {
  // Stage 8: a defeated colony has no queen left to reproduce from — checked
  // by lifecycle status itself, not incidentally via "no colony_resources
  // row" (the row is deleted on defeat, but that's not what's being tested
  // here; see §23).
  if (!isColonyActive(colonyId)) return { ok: false, error: "colony defeated" };
  if (!VALID_CASTES.includes(caste)) return { ok: false, error: "invalid caste" };

  const colony = db
    .prepare("SELECT queen_x AS queenX, queen_y AS queenY FROM colonies WHERE id = ?")
    .get(colonyId) as { queenX: number; queenY: number } | undefined;
  if (!colony) return { ok: false, error: "no such colony" };

  // Stage 9: Brood I/II/III discount the actual cost used for both the
  // affordability check and the deduction — the displayed cost and the
  // spent cost are always the same number, per §17. Stage 10: the base cost
  // is now caste-dependent too.
  const evolution = getColonyEvolution(colonyId);
  const modifiers = getEvolutionModifiers(evolution ?? { tier1: null, tier2: null, tier3: null }, caste);
  const cost = modifiers.reproduceCost;

  const protein = db
    .prepare("SELECT amount FROM colony_resources WHERE colony_id = ? AND resource_type = 'protein'")
    .get(colonyId) as { amount: number } | undefined;
  if (!protein || protein.amount < cost) return { ok: false, error: "not enough protein" };

  // Stage 9 Survival I: a newly hatched worker starts at the colony's
  // current evolved max health (full health), not the flat baseline — see
  // CLAUDE.md's Stage 9 section.
  const maxHealth = modifiers.maxHealth;

  let newWorkerId = 0;
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE colony_resources SET amount = amount - ? WHERE colony_id = ? AND resource_type = 'protein'",
    ).run(cost, colonyId);
    const info = db
      .prepare("INSERT INTO workers (colony_id, x, y, health, max_health, caste) VALUES (?, ?, ?, ?, ?, ?)")
      .run(colonyId, colony.queenX, colony.queenY, maxHealth, maxHealth, caste);
    newWorkerId = Number(info.lastInsertRowid);
  });
  tx();
  // Synchronous, immediately after the transaction commits — the sim cache
  // must never lag SQLite by so much as one tick, or a freshly reproduced
  // worker would be invisible until the next full reload. See simulation.ts.
  registerWorker({
    id: newWorkerId,
    colonyId,
    x: colony.queenX,
    y: colony.queenY,
    health: maxHealth,
    maxHealth,
    caste,
  });
  // Stage 9: reproduction is the only path that increases a colony's living
  // worker count, so this is the one place peak population needs checking.
  maybeUpdatePeakPopulation(colonyId);
  return { ok: true };
}

const VALID_TIERS = [1, 2, 3] as const;
const VALID_CHOICES: EvolutionChoice[] = ["foraging", "survival", "brood"];

// Stage 9 §8: the single authoritative evolution-selection mutation. Cheap,
// friendly pre-checks live here; the real exactly-once guarantee lives in
// applyEvolutionSelection's guarded SQL UPDATE in simulation.ts — mirrors the
// abandon()/defeatColony() relationship exactly.
export function selectEvolution(colonyId: number, tier: number, choice: string): ActionResult {
  if (!isColonyActive(colonyId)) return { ok: false, error: "colony defeated" };
  if (!VALID_TIERS.includes(tier as 1 | 2 | 3)) return { ok: false, error: "invalid tier" };
  if (!VALID_CHOICES.includes(choice as EvolutionChoice)) return { ok: false, error: "invalid choice" };

  const evolution = getColonyEvolution(colonyId);
  if (!evolution) return { ok: false, error: "no such colony" };

  const t = tier as 1 | 2 | 3;
  const key = `tier${t}` as const;
  if (evolution[key] !== null) return { ok: false, error: "tier already chosen" };

  const peakPopulation = db.prepare("SELECT peak_population AS peakPopulation FROM colonies WHERE id = ?").get(colonyId) as
    | { peakPopulation: number | null }
    | undefined;
  if (!peakPopulation || (peakPopulation.peakPopulation ?? 0) < tierThreshold(t)) {
    return { ok: false, error: "tier locked" };
  }

  const applied = applyEvolutionSelection(colonyId, t, choice as EvolutionChoice);
  if (!applied) return { ok: false, error: "tier already chosen" };
  return { ok: true };
}

// Stage 8: the manual, player-initiated counterpart to a lethal spider hit.
// Deliberately calls the exact same authoritative defeatColony() transaction
// a queen's death uses — no second reset system (§20) — differing only in
// the cause recorded. Does NOT require the player to have a worker or any
// resources: a colony soft-locked at zero workers/protein must still be
// abandonable, which is the entire point of this feature (§36).
export function abandon(colonyId: number): ActionResult {
  if (!isColonyActive(colonyId)) return { ok: false, error: "colony already defeated" };
  defeatColony(colonyId, "abandoned");
  return { ok: true };
}
