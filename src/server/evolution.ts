import {
  BROOD_I_COST_MULTIPLIER,
  BROOD_II_COST_MULTIPLIER,
  BROOD_III_COST_MULTIPLIER,
  EVOLUTION_TIER_1_POPULATION,
  EVOLUTION_TIER_2_POPULATION,
  EVOLUTION_TIER_3_POPULATION,
  FORAGING_I_CARRY_MULTIPLIER,
  FORAGING_III_CARRY_SPEED_MULTIPLIER,
  FORAGING_II_GATHER_SPEED_MULTIPLIER,
  GATHER_DURATION,
  GATHER_YIELD,
  REPRODUCE_COST,
  SURVIVAL_I_HEALTH_MULTIPLIER,
  SURVIVAL_II_ATTACK_MULTIPLIER,
  SURVIVAL_III_CHASE_SPEED_MULTIPLIER,
  TRAIT_DISPLAY_NAMES,
  WORKER_ATTACK_DAMAGE,
  WORKER_MAX_HEALTH,
} from "./balance.ts";

// Stage 9: the single shared source of truth for turning a colony's three
// permanent tier choices into the actual numbers the simulation uses —
// every mechanic Stage 9 touches (gather, movement, combat, reproduction)
// calls getEvolutionModifiers() and reads the one field it needs, instead of
// scattering `if (choice === "foraging") ...` branches across simulation.ts/
// actions.ts. See CLAUDE.md's Stage 9 section.
export type EvolutionChoice = "foraging" | "survival" | "brood";

export interface EvolutionSelections {
  tier1: EvolutionChoice | null;
  tier2: EvolutionChoice | null;
  tier3: EvolutionChoice | null;
}

export const NO_EVOLUTION: EvolutionSelections = { tier1: null, tier2: null, tier3: null };

export interface EvolutionModifiers {
  carryYield: number; // GATHER_YIELD, scaled by Foraging I
  gatherDuration: number; // GATHER_DURATION, scaled by Foraging II
  carryMoveSpeedMultiplier: number; // Foraging III — applied only while worker.carrying is set
  chaseSpeedMultiplier: number; // Survival III — applied only while actively attacking/chasing
  maxHealth: number; // WORKER_MAX_HEALTH, scaled by Survival I
  attackDamage: number; // WORKER_ATTACK_DAMAGE, scaled by Survival II
  reproduceCost: number; // REPRODUCE_COST, scaled by the highest Brood tier chosen
}

function tierThresholdFor(tier: 1 | 2 | 3): number {
  if (tier === 1) return EVOLUTION_TIER_1_POPULATION;
  if (tier === 2) return EVOLUTION_TIER_2_POPULATION;
  return EVOLUTION_TIER_3_POPULATION;
}

// Exported under the plan's documented name — tierThreshold() rather than
// tierThresholdFor() — kept as a thin alias so call sites read naturally.
export const tierThreshold = tierThresholdFor;

export function traitDisplayName(tier: 1 | 2 | 3, choice: EvolutionChoice): string {
  return TRAIT_DISPLAY_NAMES[tier][choice];
}

// Brood's discount is tier-EFFECTIVE, not cumulative (§17): whichever Brood
// tier was chosen highest wins outright, regardless of what (if anything)
// was chosen at lower tiers. "Foraging I -> Brood II" gets the Tier II 35%
// discount even with no Brood I ever chosen — scanning tier3 down to tier1
// and taking the first "brood" match is exactly that rule.
function broodCostMultiplier(s: EvolutionSelections): number {
  if (s.tier3 === "brood") return BROOD_III_COST_MULTIPLIER;
  if (s.tier2 === "brood") return BROOD_II_COST_MULTIPLIER;
  if (s.tier1 === "brood") return BROOD_I_COST_MULTIPLIER;
  return 1.0;
}

export function getEvolutionModifiers(s: EvolutionSelections): EvolutionModifiers {
  const carryMultiplier = s.tier1 === "foraging" ? FORAGING_I_CARRY_MULTIPLIER : 1;
  const gatherSpeedMultiplier = s.tier2 === "foraging" ? FORAGING_II_GATHER_SPEED_MULTIPLIER : 1;
  const carryMoveSpeedMultiplier = s.tier3 === "foraging" ? FORAGING_III_CARRY_SPEED_MULTIPLIER : 1;

  const healthMultiplier = s.tier1 === "survival" ? SURVIVAL_I_HEALTH_MULTIPLIER : 1;
  const attackMultiplier = s.tier2 === "survival" ? SURVIVAL_II_ATTACK_MULTIPLIER : 1;
  const chaseSpeedMultiplier = s.tier3 === "survival" ? SURVIVAL_III_CHASE_SPEED_MULTIPLIER : 1;

  return {
    carryYield: Math.round(GATHER_YIELD * carryMultiplier),
    gatherDuration: GATHER_DURATION / gatherSpeedMultiplier,
    carryMoveSpeedMultiplier,
    chaseSpeedMultiplier,
    maxHealth: Math.round(WORKER_MAX_HEALTH * healthMultiplier),
    attackDamage: Math.round(WORKER_ATTACK_DAMAGE * attackMultiplier),
    reproduceCost: Math.round(REPRODUCE_COST * broodCostMultiplier(s)),
  };
}
