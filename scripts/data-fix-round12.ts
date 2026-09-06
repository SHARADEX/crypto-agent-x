// Round 12 data fix (one-off):
// 1. ttnn bounty sourceUrl pointed at the bounty-plaza aggregator issue
//    (#973) instead of the REAL target issue — same data bug the fibonacci
//    bounty had in Round 11. The real link is in the aggregator body:
//    tenstorrent/tt-metal#54551.
// 2. Seed the new retry-governor fields for the radar bounty, which has
//    already failed its coding specialist twice (Sep 4 + Sep 6 events) —
//    without seeding, the governor would treat the next failure as the
//    first (1h backoff) and the cycle would immediately re-burn budget.
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  // 1. ttnn → real issue URL.
  const ttnn = await db.opportunity.updateMany({
    where: {
      sourceUrl: "https://github.com/zhangjiayang6835-cyber/bounty-plaza/issues/973",
    },
    data: {
      sourceUrl: "https://github.com/tenstorrent/tt-metal/issues/54551",
    },
  });
  console.log("ttnn sourceUrl updated:", ttnn.count);

  // 2. radar bounty — 2 historical consecutive failures, cool down 2h.
  const radar = await db.opportunity.updateMany({
    where: {
      title: { contains: "[radar] SN open bounty" },
      status: "queued",
    },
    data: {
      attemptCount: 2,
      lastAttemptAt: new Date(),
      nextRetryAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    },
  });
  console.log("radar retry-governor seeded:", radar.count);

  // Show resulting mid-flight rows for the handover log.
  const rows = await db.opportunity.findMany({
    where: { status: { in: ["queued", "submitted", "awaiting_payment", "approved"] } },
    select: {
      id: true,
      title: true,
      status: true,
      sourceUrl: true,
      attemptCount: true,
      nextRetryAt: true,
    },
  });
  for (const r of rows) {
    console.log(
      `[${r.status}] ${r.title.slice(0, 50)} | attempts=${r.attemptCount} | retry=${r.nextRetryAt?.toISOString() ?? "now"} | ${r.sourceUrl}`
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
