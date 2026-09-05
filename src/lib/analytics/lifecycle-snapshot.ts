// Lifecycle snapshot helper (Phase-3 dev-review #3, priority #5 → DEV-REVIEW-4 priority #2).
//
// Extracted from src/app/api/analytics/lifecycle/snapshot/route.ts so the
// orchestrator loop can call it directly (without an HTTP round-trip) once
// per cycle. The HTTP route still exists for manual / cron use.
//
// The snapshot is idempotent per hourly bucket: re-running within the same
// hour updates the row in place rather than stacking duplicates.

import { db } from "@/lib/db";

function hourlyBucket(d: Date = new Date()): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}`;
}

export interface SnapshotResult {
  bucket: string;
  statuses: Array<{
    status: string;
    count: number;
    avgHoursInStatus: number;
    maxHoursInStatus: number;
  }>;
  count: number;
}

/**
 * Write a lifecycle snapshot for the current hourly bucket. Idempotent per
 * (bucket, status) via upsert — safe to call multiple times per hour.
 *
 * @returns the snapshot result (bucket + per-status counts + hours).
 */
export async function recordLifecycleSnapshot(): Promise<SnapshotResult> {
  const rows = await db.opportunity.groupBy({
    by: ["status"],
    _count: { _all: true },
    _min: { updatedAt: true },
    _max: { updatedAt: true },
  });

  const bucket = hourlyBucket();
  const nowMs = Date.now();
  const written: SnapshotResult["statuses"] = [];

  for (const row of rows) {
    const oldestDate = row._min.updatedAt;
    const newestDate = row._max.updatedAt;
    const oldestMs = oldestDate instanceof Date ? oldestDate.getTime() : null;
    const newestMs = newestDate instanceof Date ? newestDate.getTime() : null;
    const maxHours =
      oldestMs != null && Number.isFinite(oldestMs)
        ? Math.max(0, (nowMs - oldestMs) / (1000 * 60 * 60))
        : 0;
    const avgHours =
      oldestMs != null && newestMs != null
        ? Math.max(0, (nowMs - (oldestMs + newestMs) / 2) / (1000 * 60 * 60))
        : 0;
    const roundedAvg = Math.round(avgHours * 10) / 10;
    const roundedMax = Math.round(maxHours * 10) / 10;

    await db.lifecycleSnapshot.upsert({
      where: {
        bucket_status: { bucket, status: row.status },
      },
      create: {
        bucket,
        status: row.status,
        count: row._count._all,
        avgHoursInStatus: roundedAvg,
        maxHoursInStatus: roundedMax,
      },
      update: {
        count: row._count._all,
        avgHoursInStatus: roundedAvg,
        maxHoursInStatus: roundedMax,
      },
    });

    written.push({
      status: row.status,
      count: row._count._all,
      avgHoursInStatus: roundedAvg,
      maxHoursInStatus: roundedMax,
    });
  }

  return { bucket, statuses: written, count: written.length };
}
