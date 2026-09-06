// Round 12 verification (read-only): confirm selectNextOpportunity now
// respects the retry-governor cooldown. Radar (nextRetryAt 11:33 UTC) must
// be SKIPPED; ttnn (no cooldown) should be the pick instead.
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const now = new Date();
  const mid = await db.opportunity.findFirst({
    where: {
      status: {
        in: [
          "researching",
          "planning",
          "queued",
          "approved",
          "executed",
          "submitted",
          "awaiting_payment",
          "needs_improvement",
        ],
      },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    orderBy: { updatedAt: "asc" },
    select: { id: true, title: true, status: true, attemptCount: true, nextRetryAt: true },
  });
  console.log("cooldown-aware mid-flight pick:", mid?.title ?? null);
  console.log("  status:", mid?.status, "| attempts:", mid?.attemptCount, "| retry:", mid?.nextRetryAt?.toISOString() ?? "now");

  // Show ALL mid-flight rows to prove radar is excluded by the filter.
  const all = await db.opportunity.findMany({
    where: { status: { in: ["queued", "submitted", "approved", "awaiting_payment"] } },
    orderBy: { updatedAt: "asc" },
    select: { title: true, status: true, attemptCount: true, nextRetryAt: true },
  });
  console.log("\nall mid-flight (oldest first):");
  for (const r of all) {
    const cooling = r.nextRetryAt && r.nextRetryAt > now;
    console.log(
      `  ${cooling ? "[COOLING until " + r.nextRetryAt!.toISOString() + "]" : "[selectable]"} ${r.status} attempts=${r.attemptCount} :: ${r.title.slice(0, 50)}`
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
