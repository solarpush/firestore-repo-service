#!/usr/bin/env bun
/**
 * Script to run tests with Firestore emulator
 *
 * Usage:
 *   bun run test/run-tests.ts          # Run tests (assumes emulator is running)
 *   bun run test/run-tests.ts --start  # Start emulator, run tests, stop emulator
 */

import { spawn, spawnSync } from "bun";

const EMULATOR_HOST = "localhost:8080";
const PROJECT_ID = "demo-no-project";

// Parse args
const args = process.argv.slice(2);
const shouldStartEmulator = args.includes("--start");
const shouldExportIndexes = args.includes("--indexes");

/**
 * Check if emulator is available
 */
async function isEmulatorRunning(): Promise<boolean> {
  try {
    const response = await fetch(`http://${EMULATOR_HOST}/`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the Firestore emulator
 */
function startEmulator(): ReturnType<typeof spawn> {
  console.log("🚀 Starting Firestore emulator...");

  const proc = spawn({
    cmd: [
      "firebase",
      "emulators:start",
      "--only",
      "firestore",
      "--project",
      PROJECT_ID,
    ],
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  });

  return proc;
}

/**
 * Wait for emulator to be ready
 */
async function waitForEmulator(
  maxRetries = 60,
  delayMs = 1000
): Promise<boolean> {
  console.log("⏳ Waiting for emulator to be ready...");

  for (let i = 0; i < maxRetries; i++) {
    if (await isEmulatorRunning()) {
      console.log("✅ Emulator is ready!");
      return true;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, delayMs));
  }

  console.log("\n❌ Emulator failed to start");
  return false;
}

/**
 * Export index usage from emulator
 */
async function exportIndexes(): Promise<void> {
  console.log("\n📊 Exporting index usage...");

  try {
    const response = await fetch(
      `http://${EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}:indexUsage?database=projects/${PROJECT_ID}/databases/(default)`
    );

    if (response.ok) {
      const data = await response.json();
      const outputPath = "test/index-usage.json";
      await Bun.write(outputPath, JSON.stringify(data, null, 2));
      console.log(`✅ Index usage exported to ${outputPath}`);

      // Print summary
      if (data.indexes && data.indexes.length > 0) {
        console.log(`\n📋 ${data.indexes.length} indexes detected:`);
        for (const index of data.indexes) {
          console.log(
            `   - ${index.collectionGroup}: ${index.fields
              ?.map((f: any) => `${f.fieldPath} (${f.order || f.arrayConfig})`)
              .join(", ")}`
          );
        }
      } else {
        console.log("   No composite indexes required.");
      }
    } else {
      console.log("⚠️  Could not fetch index usage");
    }
  } catch (error) {
    console.log("⚠️  Failed to export indexes:", error);
  }
}

/**
 * Run the tests
 */
function runTests(): number {
  console.log("\n🧪 Running tests...\n");

  const result = spawnSync({
    cmd: ["bun", "test", "test/repo.test.ts"],
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      FIRESTORE_EMULATOR_HOST: EMULATOR_HOST,
      GOOGLE_CLOUD_PROJECT: PROJECT_ID,
      GCLOUD_PROJECT: PROJECT_ID,
    },
  });

  return result.exitCode ?? 1;
}

/**
 * Main function
 */
async function main(): Promise<void> {
  let emulatorProc: ReturnType<typeof spawn> | null = null;
  let exitCode = 0;

  try {
    // Check if emulator is already running
    const alreadyRunning = await isEmulatorRunning();

    if (shouldStartEmulator && !alreadyRunning) {
      // Start emulator
      emulatorProc = startEmulator();

      // Wait for it to be ready
      const ready = await waitForEmulator();
      if (!ready) {
        process.exit(1);
      }
    } else if (!alreadyRunning) {
      console.log("❌ Emulator is not running. Start it with:");
      console.log("   bun run emulator");
      console.log("\nOr run tests with --start flag:");
      console.log("   bun run test/run-tests.ts --start");
      process.exit(1);
    } else {
      console.log("✅ Emulator is already running");
    }

    // Run tests
    exitCode = runTests();

    // Export indexes if requested or after tests
    if (shouldExportIndexes || exitCode === 0) {
      await exportIndexes();
    }
  } finally {
    // Stop emulator if we started it
    if (emulatorProc) {
      console.log("\n🛑 Stopping emulator...");
      emulatorProc.kill();
    }
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
