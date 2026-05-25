// Claim Type Definitions
// Single source of truth for claim table names and display labels.
// Amount resolution: lib/calculations/engine.js -> resolveStoredAmount()
//
// ARCHITECTURE:
//   All claim tables live in the `fat` schema (see docs/FAT_SCHEMA_ARCHITECTURE.md).
//   'spoilt' and 'delayed_meal' are VIRTUAL top-level claim types that both
//   write to the same DB table (fat.spoilt_meals), differentiated by meal_type:
//     claimType 'spoilt'       → fat.spoilt_meals, meal_type = 'Spoilt'
//     claimType 'delayed_meal' → fat.spoilt_meals, meal_type = 'Delayed'
//
// LEGACY: Historical records may have meal_type = 'Spoilt / Meal'
//   - handled by LEGACY_MEAL_TYPE_MAP in engine.js
//   - legacy rows with meal_type = 'Spoilt / Meal' are normalised to claimType = 'spoilt'

// DB tables actually queried in the `fat` schema. 'delayed_meal' is virtual.
export const CLAIM_TABLES = ['recalls', 'retain', 'standby', 'spoilt_meals']

// Display labels for all claim types including virtual ones
export const CLAIM_TYPE_LABELS = {
  recalls:      'Recall',
  retain:       'Retain',
  standby:      'Standby',
  spoilt:       'Spoilt Meal',
  delayed_meal: 'Delayed Meal',
}

// Top-level dropdown order — 5 options visible to user
export const CLAIM_TYPE_ORDER = ['recalls', 'retain', 'standby', 'spoilt', 'delayed_meal']

// Maps claimType (the value used throughout the app) to its `fat` table name
// and (where applicable) the meal_type discriminator forced on insert.
const CLAIM_TYPE_TO_TABLE = {
  recalls:      { table: 'recalls',      mealType: null      },
  retain:       { table: 'retain',       mealType: null      },
  standby:      { table: 'standby',      mealType: null      },
  spoilt:       { table: 'spoilt_meals', mealType: 'Spoilt'  },
  delayed_meal: { table: 'spoilt_meals', mealType: 'Delayed' },
}

// Resolve the `fat`-schema table name for any claimType (real or virtual)
export function resolveClaimTable(claimType) {
  return CLAIM_TYPE_TO_TABLE[claimType]?.table ?? claimType
}

// Resolve the forced meal_type value for a given claimType (null = user can choose)
export function resolveClaimMealType(claimType) {
  return CLAIM_TYPE_TO_TABLE[claimType]?.mealType ?? null
}
