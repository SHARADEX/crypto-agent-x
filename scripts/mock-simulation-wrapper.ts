// Mock simulation wrapper — explicitly sets DATABASE_URL before anything else.
// Phase 3.2: Bun auto-loads .env which overrides command-line env vars.
// This script sets the env vars FIRST, then imports the simulation.
//
// Run: bun run scripts/mock-simulation-wrapper.ts
// Or:  bun run agent:simulate

// Set the simulation DATABASE_URL BEFORE any imports that trigger .env loading.
process.env.DATABASE_URL = "file:/tmp/cryptoearn-sim.db";
process.env.MOCK_MODE = "true";

// Now import the simulation — it will see the env vars we set above
// because process.env is already populated.
// Note: do NOT use a `.ts` extension in the import path — TypeScript's
// `allowImportingTsExtensions` is disabled, and the Bun runtime resolves
// the .ts extension automatically.
import("./mock-simulation").catch((err) => {
  console.error("[mock-simulation] failed:", err);
  process.exit(1);
});
