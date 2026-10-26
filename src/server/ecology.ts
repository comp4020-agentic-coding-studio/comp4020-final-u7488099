import {
  APHIDS_PER_ANCHOR,
  BIOMASS_NODE_MAX_AMOUNT,
  BIOMASS_PER_ANCHOR,
  colonySpiralPosition,
  COLONY_PLACEMENT_MARGIN,
  ECOLOGY_ANCHOR_TARGET_DENSITY,
  ECOLOGY_ANCHOR_ZONE_RADIUS,
  ECOLOGY_BACKGROUND_CELL_SIZE,
  ECOLOGY_BACKGROUND_TARGET_DENSITY,
  ECOLOGY_DENSITY_WEIGHTS,
  ECOLOGY_QUEEN_EXCLUSION_RADIUS,
  ECOLOGY_REGEN_DEADLINE_MAX_MS,
  ECOLOGY_REGEN_DEADLINE_MIN_MS,
  ECOLOGY_TYPE_RARITY,
  GLOBAL_SCARCITY_K,
  GLOBAL_SCARCITY_MAX_MULTIPLIER,
  MAX_ECOLOGY_ENTITIES,
  PROTEIN_NODE_AMOUNT,
  RARITY_BASE_WEIGHT,
  REFERENCE_DESIRED_POPULATION,
  REFERENCE_WORLD_AREA,
  RUIN_LIFETIME_MS,
  SCARCITY_BOOST_FACTOR,
  SCATTER_APHID_COUNT,
  SCATTER_BIOMASS_COUNT,
  SCATTER_PROTEIN_COUNT,
  SCATTER_SUGAR_COUNT,
  SPAWN_ANCHOR_COUNT,
  SPECIES_MAX_HEALTH,
  SUGAR_NODE_MAX_AMOUNT,
  SUGAR_PER_ANCHOR,
  WORLD,
} from "./balance.ts";
import { db } from "./db.ts";
import { getAllColonies, getAllWorkerPositions, getCreaturesForWorld, getSpiderPositions, registerCreature } from "./simulation.ts";

type EcologyType = "sugar" | "biomass" | "protein" | "aphid" | "spider";
const ECOLOGY_TYPES: EcologyType[] = ["sugar", "biomass", "protein", "aphid", "spider"];

type ZoneKey = `anchor:${number}` | `bg:${number}:${number}`;

interface Zone {
  key: ZoneKey;
  x: number;
  y: number;
  radius: number;
  tier: "anchor" | "background";
  baseTarget: number;
}

const ANCHOR_CENTERS: { x: number; y: number }[] = Array.from({ length: SPAWN_ANCHOR_COUNT }, (_, i) =>
  colonySpiralPosition(i),
);

// Anchor tier mix (per CLAUDE.md's Stage 12 derivation): sugar:biomass:
// protein:aphid ratios matching SUGAR_PER_ANCHOR/BIOMASS_PER_ANCHOR/
// APHIDS_PER_ANCHOR, with protein's share halved (PROTEIN_ANCHOR_STRIDE=2
// means only every other anchor gets one).
const ANCHOR_BASE_SHARE: Record<EcologyType, number> = {
  sugar: SUGAR_PER_ANCHOR,
  biomass: BIOMASS_PER_ANCHOR,
  protein: 0.5,
  aphid: APHIDS_PER_ANCHOR,
  spider: 0,
};

// Background tier mix: original scatter counts, same ratios.
const BACKGROUND_BASE_SHARE: Record<EcologyType, number> = {
  sugar: SCATTER_SUGAR_COUNT,
  biomass: SCATTER_BIOMASS_COUNT,
  protein: SCATTER_PROTEIN_COUNT,
  aphid: SCATTER_APHID_COUNT,
  spider: 0,
};

const FINITE_AMOUNT: Record<"sugar" | "biomass" | "protein", number> = {
  sugar: SUGAR_NODE_MAX_AMOUNT,
  biomass: BIOMASS_NODE_MAX_AMOUNT,
  protein: PROTEIN_NODE_AMOUNT,
};

// Pure: classifies a point as its nearest anchor zone (if within radius) or
// its background grid cell — nearest-anchor-wins when a point falls inside
// more than one anchor's radius (anchors are far enough apart in practice
// that overlap is rare, but the tie-break still needs to be deterministic).
export function zoneForPosition(x: number, y: number): ZoneKey {
  let nearestIndex = -1;
  let nearestDist = Infinity;
  for (let i = 0; i < ANCHOR_CENTERS.length; i++) {
    const anchor = ANCHOR_CENTERS[i];
    const dist = Math.hypot(anchor.x - x, anchor.y - y);
    if (dist <= ECOLOGY_ANCHOR_ZONE_RADIUS && dist < nearestDist) {
      nearestDist = dist;
      nearestIndex = i;
    }
  }
  if (nearestIndex >= 0) return `anchor:${nearestIndex}`;
  const cellX = Math.floor(x / ECOLOGY_BACKGROUND_CELL_SIZE);
  const cellY = Math.floor(y / ECOLOGY_BACKGROUND_CELL_SIZE);
  return `bg:${cellX}:${cellY}`;
}

function zoneDefinition(key: ZoneKey): Zone {
  if (key.startsWith("anchor:")) {
    const index = Number(key.slice("anchor:".length));
    const center = ANCHOR_CENTERS[index];
    return {
      key,
      x: center.x,
      y: center.y,
      radius: ECOLOGY_ANCHOR_ZONE_RADIUS,
      tier: "anchor",
      baseTarget: ECOLOGY_ANCHOR_TARGET_DENSITY,
    };
  }
  const [, cxStr, cyStr] = key.split(":");
  const cellX = Number(cxStr);
  const cellY = Number(cyStr);
  return {
    key,
    x: (cellX + 0.5) * ECOLOGY_BACKGROUND_CELL_SIZE,
    y: (cellY + 0.5) * ECOLOGY_BACKGROUND_CELL_SIZE,
    radius: ECOLOGY_BACKGROUND_CELL_SIZE / 2,
    tier: "background",
    baseTarget: ECOLOGY_BACKGROUND_TARGET_DENSITY,
  };
}

// Non-expired exclusion list: active queens, plus defeated-but-not-yet-
// expired ruins — see CLAUDE.md's Stage 12 section for why this can't reuse
// isClearOfNests (that helper is deliberately "active only", a different
// question than ecology's "is this ground currently occupied").
export function isRuinExpired(defeatedAtIso: string | null, nowMs: number = Date.now()): boolean {
  if (defeatedAtIso === null) return false;
  // SQLite's datetime('now') format ("YYYY-MM-DD HH:MM:SS") has no
  // timezone suffix and Date.parse treats a bare space-separated string
  // inconsistently across engines — normalize to ISO-8601 UTC explicitly.
  const normalized = defeatedAtIso.includes("T") ? defeatedAtIso : defeatedAtIso.replace(" ", "T") + "Z";
  const parsedMs = Date.parse(normalized);
  return nowMs - parsedMs > RUIN_LIFETIME_MS;
}

function activeExclusionCircles(nowMs: number): { x: number; y: number; radius: number }[] {
  return getAllColonies()
    .filter((c) => c.status === "active" || !isRuinExpired(colonyDefeatedAt(c.id), nowMs))
    .map((c) => ({ x: c.x, y: c.y, radius: ECOLOGY_QUEEN_EXCLUSION_RADIUS }));
}

// getAllColonies() doesn't carry defeated_at (it's a durable SQL-only
// column not needed by the sim cache) — read it directly for the handful of
// defeated colonies, same discipline state.ts uses for defeat_cause.
const defeatedAtStmt = db.prepare("SELECT defeated_at AS defeatedAt FROM colonies WHERE id = ?");
function colonyDefeatedAt(colonyId: number): string | null {
  const row = defeatedAtStmt.get(colonyId) as { defeatedAt: string | null } | undefined;
  return row?.defeatedAt ?? null;
}

function circleOverlapFraction(zone: Zone, exclusion: { x: number; y: number; radius: number }): number {
  const d = Math.hypot(zone.x - exclusion.x, zone.y - exclusion.y);
  const r1 = zone.radius;
  const r2 = exclusion.radius;
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return 1; // one circle fully contains the other
  const r1sq = r1 * r1;
  const r2sq = r2 * r2;
  const alpha = Math.acos((d * d + r1sq - r2sq) / (2 * d * r1));
  const beta = Math.acos((d * d + r2sq - r1sq) / (2 * d * r2));
  const area = r1sq * (alpha - Math.sin(2 * alpha) / 2) + r2sq * (beta - Math.sin(2 * beta) / 2);
  return Math.min(1, area / (Math.PI * r1sq));
}

function effectiveTarget(zone: Zone, exclusions: { x: number; y: number; radius: number }[]): number {
  let maxOverlap = 0;
  for (const exclusion of exclusions) {
    maxOverlap = Math.max(maxOverlap, circleOverlapFraction(zone, exclusion));
  }
  return zone.baseTarget * (1 - maxOverlap);
}

interface ZoneDensity {
  zone: Zone;
  weighted: number;
  counts: Record<EcologyType, number>;
}

function computeZoneDensities(worldId: number): Map<ZoneKey, ZoneDensity> {
  const densities = new Map<ZoneKey, ZoneDensity>();
  const touch = (key: ZoneKey): ZoneDensity => {
    let entry = densities.get(key);
    if (!entry) {
      entry = {
        zone: zoneDefinition(key),
        weighted: 0,
        counts: { sugar: 0, biomass: 0, protein: 0, aphid: 0, spider: 0 },
      };
      densities.set(key, entry);
    }
    return entry;
  };

  const nodeRows = db
    .prepare("SELECT x, y, resource_type AS resourceType FROM resource_nodes WHERE world_id = ? AND kind = 'source'")
    .all(worldId) as { x: number; y: number; resourceType: EcologyType }[];
  for (const row of nodeRows) {
    if (row.resourceType !== "sugar" && row.resourceType !== "biomass" && row.resourceType !== "protein") continue;
    const entry = touch(zoneForPosition(row.x, row.y));
    entry.counts[row.resourceType] += 1;
    entry.weighted += ECOLOGY_DENSITY_WEIGHTS[row.resourceType];
  }

  for (const creature of getCreaturesForWorld(worldId)) {
    if (creature.species !== "aphid" && creature.species !== "spider") continue;
    const entry = touch(zoneForPosition(creature.x, creature.y));
    entry.counts[creature.species] += 1;
    entry.weighted += ECOLOGY_DENSITY_WEIGHTS[creature.species];
  }

  return densities;
}

// Stage 12 addendum: WHAT gets selected is now rarity x local scarcity x
// global scarcity (WHEN to regenerate is untouched — still the belowTarget +
// randomized-deadline logic in advanceEcology below; this is a second,
// independent factor on type *selection*, not a second trigger). Added after
// discovering a real extinction in the shared dev world: spider's
// ANCHOR_BASE_SHARE/BACKGROUND_BASE_SHARE of 0 meant the old `if (share <=
// 0) continue` guard unconditionally excluded spiders from ever being
// ecology-spawned, so a fully-hunted-out spider population could never
// recover. Every type is now always a candidate; a type's local
// baseShare/tier mix (ANCHOR_BASE_SHARE/BACKGROUND_BASE_SHARE, unchanged)
// still drives the local-scarcity factor exactly as before, decoupled from
// candidate inclusion. For a (type, tier) pair with no local expectation at
// all (share <= 0 — spiders are deliberately never anchor-clustered, see
// buildWorldPopulation()'s comment), the local-scarcity factor is neutral
// (1x): there's no local baseline to be "scarce" relative to, so global
// scarcity and rarity alone decide whether it gets selected there.
function pickSpawnType(
  zone: Zone,
  counts: Record<EcologyType, number>,
  globalScarcityByType: Record<EcologyType, number>,
): EcologyType {
  const baseShare = zone.tier === "anchor" ? ANCHOR_BASE_SHARE : BACKGROUND_BASE_SHARE;
  const weights: { type: EcologyType; weight: number }[] = [];
  let total = 0;
  for (const type of ECOLOGY_TYPES) {
    const share = baseShare[type];
    const rarity = RARITY_BASE_WEIGHT[ECOLOGY_TYPE_RARITY[type]];
    let localMultiplier = 1;
    if (share > 0) {
      const expected = zone.tier === "anchor" ? share : share / 90; // background per-cell expectation, scaled down
      const scarcity = Math.max(0, 1 - counts[type] / Math.max(expected, 0.0001));
      localMultiplier = 1 + SCARCITY_BOOST_FACTOR * scarcity;
    }
    const weight = rarity * localMultiplier * globalScarcityByType[type];
    weights.push({ type, weight });
    total += weight;
  }
  let roll = pendingRng() * total;
  for (const entry of weights) {
    roll -= entry.weight;
    if (roll <= 0) return entry.type;
  }
  return weights[weights.length - 1].type;
}

// worldScale generalizes desired populations to any future world size
// without ever hardcoding an absolute target: desiredPopulation_i scales
// linearly with map area relative to REFERENCE_WORLD_AREA (today's 3000x3000
// world is also the reference world, so worldScale is 1 today, but the two
// are allowed to diverge once the live world grows).
export function computeWorldScale(worldWidth: number, worldHeight: number): number {
  return (worldWidth * worldHeight) / REFERENCE_WORLD_AREA;
}

export function desiredPopulationFor(type: EcologyType, worldScale: number): number {
  return REFERENCE_DESIRED_POPULATION[type] * worldScale;
}

// Bounded exponential: at/above the desired population the multiplier is
// exactly 1 (never a bonus for being abundant — desired populations are
// ecological targets, not caps, so overpopulation never gets penalized
// either). Below it, pressure rises smoothly and is capped at
// GLOBAL_SCARCITY_MAX_MULTIPLIER so a fully extinct type gets strong but
// finite recovery pressure rather than infinite weight.
export function globalScarcityMultiplier(currentPopulation: number, desiredPopulation: number): number {
  const ratio = desiredPopulation > 0 ? currentPopulation / desiredPopulation : 1;
  const deficiency = Math.max(0, 1 - ratio);
  return Math.min(GLOBAL_SCARCITY_MAX_MULTIPLIER, Math.exp(GLOBAL_SCARCITY_K * deficiency * deficiency));
}

// Current global (whole-world) population per type — the numerator of
// populationRatio_i. Deliberately a flat O(nodes + creatures) pass, same
// shape/cost as computeZoneDensities, just not bucketed by zone.
export function computeGlobalPopulation(worldId: number): Record<EcologyType, number> {
  const counts: Record<EcologyType, number> = { sugar: 0, biomass: 0, protein: 0, aphid: 0, spider: 0 };
  const nodeRows = db
    .prepare(
      "SELECT resource_type AS resourceType, COUNT(*) AS n FROM resource_nodes WHERE world_id = ? AND kind = 'source' AND resource_type IN ('sugar','biomass','protein') GROUP BY resource_type",
    )
    .all(worldId) as { resourceType: EcologyType; n: number }[];
  for (const row of nodeRows) counts[row.resourceType] = row.n;
  for (const creature of getCreaturesForWorld(worldId)) {
    if (creature.species === "aphid" || creature.species === "spider") counts[creature.species] += 1;
  }
  return counts;
}

// One global-scarcity multiplier per type, computed once per advanceEcology
// tick (not once per zone — global population doesn't vary by zone).
function computeGlobalScarcityByType(worldId: number): Record<EcologyType, number> {
  const worldScale = computeWorldScale(WORLD.width, WORLD.height);
  const population = computeGlobalPopulation(worldId);
  const result = {} as Record<EcologyType, number>;
  for (const type of ECOLOGY_TYPES) {
    result[type] = globalScarcityMultiplier(population[type], desiredPopulationFor(type, worldScale));
  }
  return result;
}

// Deliberately not Math.random(): a dedicated, swappable RNG hook so tests
// can force deterministic spawn-type selection (test matrix item #5).
let rngOverride: (() => number) | null = null;
function pendingRng(): number {
  return rngOverride ? rngOverride() : Math.random();
}
export function setEcologyRng(fn: (() => number) | null): void {
  rngOverride = fn;
}

function randomDeadlineMs(): number {
  return ECOLOGY_REGEN_DEADLINE_MIN_MS + pendingRng() * (ECOLOGY_REGEN_DEADLINE_MAX_MS - ECOLOGY_REGEN_DEADLINE_MIN_MS);
}

function countRawEcologyEntities(worldId: number): number {
  const nodeCount = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM resource_nodes WHERE world_id = ? AND kind = 'source' AND resource_type IN ('sugar','biomass','protein')",
      )
      .get(worldId) as { n: number }
  ).n;
  const creatureCount = getCreaturesForWorld(worldId).filter((c) => c.species === "aphid" || c.species === "spider").length;
  return nodeCount + creatureCount;
}

const PLACEMENT_RETRY_ATTEMPTS = 20;
const PHYSICAL_CLEARANCE_RADIUS = 20; // don't spawn directly on top of a live unit/spider

function placeInZone(
  zone: Zone,
  exclusions: { x: number; y: number; radius: number }[],
): { x: number; y: number } | null {
  const avoidPoints = [...getAllWorkerPositions(), ...getSpiderPositions()];
  for (let attempt = 0; attempt < PLACEMENT_RETRY_ATTEMPTS; attempt++) {
    const angle = pendingRng() * Math.PI * 2;
    const radius = pendingRng() * zone.radius;
    let x = zone.x + Math.cos(angle) * radius;
    let y = zone.y + Math.sin(angle) * radius;
    x = Math.min(Math.max(x, COLONY_PLACEMENT_MARGIN), WORLD.width - COLONY_PLACEMENT_MARGIN);
    y = Math.min(Math.max(y, COLONY_PLACEMENT_MARGIN), WORLD.height - COLONY_PLACEMENT_MARGIN);

    const blockedByExclusion = exclusions.some((e) => Math.hypot(e.x - x, e.y - y) <= e.radius);
    if (blockedByExclusion) continue;
    const blockedByUnit = avoidPoints.some((p) => Math.hypot(p.x - x, p.y - y) <= PHYSICAL_CLEARANCE_RADIUS);
    if (blockedByUnit) continue;
    return { x, y };
  }
  return null;
}

const insertResourceNodeStmt = db.prepare(
  "INSERT INTO resource_nodes (world_id, x, y, resource_type, amount, max_amount) VALUES (?, ?, ?, ?, ?, ?)",
);
const insertCreatureStmt = db.prepare(
  "INSERT INTO creatures (world_id, species, x, y, health, max_health) VALUES (?, ?, ?, ?, ?, ?)",
);

function spawnEntity(worldId: number, type: EcologyType, x: number, y: number): void {
  if (type === "sugar" || type === "biomass" || type === "protein") {
    const amount = FINITE_AMOUNT[type];
    insertResourceNodeStmt.run(worldId, x, y, type, amount, amount);
    return;
  }
  // Creature max health mirrors seedCreaturesIfEmpty()'s own per-species
  // defaults via SPECIES_MAX_HEALTH, imported lazily to avoid a cycle risk
  // with simulation.ts (none today, but keeps this module's import list
  // scoped to what it actually needs at the top).
  const maxHealth = SPECIES_MAX_HEALTH_LOOKUP[type];
  const info = insertCreatureStmt.run(worldId, type, x, y, maxHealth, maxHealth);
  registerCreature({
    id: Number(info.lastInsertRowid),
    worldId,
    species: type,
    x,
    y,
    health: maxHealth,
    maxHealth,
  });
}

// aphid/spider max health — narrowed from SPECIES_MAX_HEALTH's wider
// Record<string, number> shape, since ecology only ever spawns these two.
const SPECIES_MAX_HEALTH_LOOKUP: Record<"aphid" | "spider", number> = {
  aphid: SPECIES_MAX_HEALTH.aphid,
  spider: SPECIES_MAX_HEALTH.spider,
};

// In-memory only, per the plan's binding decision — lost on restart, no
// catch-up burst (see CLAUDE.md's Stage 12 "restart-safe timing" section).
const pendingDeadlines = new Map<ZoneKey, number>();

export function resetEcologyState(): void {
  pendingDeadlines.clear();
}

export interface EcologyZoneSnapshot {
  key: ZoneKey;
  tier: "anchor" | "background";
  density: number;
  target: number;
  pendingMsRemaining: number | null;
}

// The ~5s tick: measure density per zone, update the pending-deadline map,
// spawn (respecting the global cap, queen/ruin exclusion, bounded placement
// attempts) when a deadline elapses. Pure derived state in, side effects
// (one SQL insert + one registerCreature call per spawn) out.
export function advanceEcology(nowMs: number = Date.now()): void {
  const world = db.prepare("SELECT id FROM worlds LIMIT 1").get() as { id: number } | undefined;
  if (!world) return;

  const exclusions = activeExclusionCircles(nowMs);
  const densities = computeZoneDensities(world.id);
  const globalScarcityByType = computeGlobalScarcityByType(world.id);
  const seenZones = new Set<ZoneKey>(densities.keys());

  // Zones with zero measured content never appear in computeZoneDensities'
  // result (nothing to iterate), but an empty anchor zone is exactly the
  // case that most needs a pending deadline — synthesize an empty entry for
  // every anchor so it's never silently skipped. Background cells with zero
  // content are effectively infinite in number (any empty patch of map is
  // one), so they're only tracked once something has been measured there at
  // least once; this is an accepted scope limit consistent with the plan's
  // zone-membership definition (a background zone only "exists" once it has
  // measured content or a key already present in the pending map).
  for (let i = 0; i < SPAWN_ANCHOR_COUNT; i++) {
    const key: ZoneKey = `anchor:${i}`;
    if (!seenZones.has(key)) {
      densities.set(key, { zone: zoneDefinition(key), weighted: 0, counts: { sugar: 0, biomass: 0, protein: 0, aphid: 0, spider: 0 } });
    }
  }

  let rawCount: number | null = null;
  const capReached = (): boolean => {
    if (rawCount === null) rawCount = countRawEcologyEntities(world.id);
    return rawCount >= MAX_ECOLOGY_ENTITIES;
  };

  for (const [key, entry] of densities) {
    const target = effectiveTarget(entry.zone, exclusions);
    const belowTarget = entry.weighted < target;

    if (!belowTarget) {
      pendingDeadlines.delete(key);
      continue;
    }

    const deadline = pendingDeadlines.get(key);
    if (deadline === undefined) {
      pendingDeadlines.set(key, nowMs + randomDeadlineMs());
      continue;
    }

    if (nowMs < deadline) continue;

    // Deadline elapsed while still below target: eligible to spawn.
    pendingDeadlines.set(key, nowMs + randomDeadlineMs());
    if (capReached()) continue;

    const type = pickSpawnType(entry.zone, entry.counts, globalScarcityByType);
    const placement = placeInZone(entry.zone, exclusions);
    if (!placement) continue;
    spawnEntity(world.id, type, placement.x, placement.y);
    rawCount = (rawCount ?? 0) + 1;
  }
}

export function getEcologySnapshot(nowMs: number = Date.now()): { anchors: EcologyZoneSnapshot[]; background: { zoneCount: number; averageDensity: number; pendingCount: number } } {
  const world = db.prepare("SELECT id FROM worlds LIMIT 1").get() as { id: number } | undefined;
  if (!world) return { anchors: [], background: { zoneCount: 0, averageDensity: 0, pendingCount: 0 } };

  const exclusions = activeExclusionCircles(nowMs);
  const densities = computeZoneDensities(world.id);

  const anchors: EcologyZoneSnapshot[] = [];
  for (let i = 0; i < SPAWN_ANCHOR_COUNT; i++) {
    const key: ZoneKey = `anchor:${i}`;
    const entry = densities.get(key);
    const zone = zoneDefinition(key);
    const target = effectiveTarget(zone, exclusions);
    const deadline = pendingDeadlines.get(key);
    anchors.push({
      key,
      tier: "anchor",
      density: entry?.weighted ?? 0,
      target,
      pendingMsRemaining: deadline === undefined ? null : Math.max(0, deadline - nowMs),
    });
  }

  let backgroundZoneCount = 0;
  let backgroundDensitySum = 0;
  let backgroundPendingCount = 0;
  for (const [key, entry] of densities) {
    if (!key.startsWith("bg:")) continue;
    backgroundZoneCount += 1;
    backgroundDensitySum += entry.weighted;
    if (pendingDeadlines.has(key)) backgroundPendingCount += 1;
  }

  return {
    anchors,
    background: {
      zoneCount: backgroundZoneCount,
      averageDensity: backgroundZoneCount > 0 ? backgroundDensitySum / backgroundZoneCount : 0,
      pendingCount: backgroundPendingCount,
    },
  };
}
