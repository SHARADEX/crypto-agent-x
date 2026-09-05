// GET /api/export/opportunities?format=csv|json&status=&category=&source=
//
// Export the opportunities table as CSV or JSON for offline analysis
// (Phase-3 DEV-REVIEW-4, priority #4).
//
// Operators often want to spreadsheet the data for reporting — this
// endpoint returns the full filtered set (no pagination, no 200-row cap)
// so the operator can pivot / chart / share it externally.
//
// Query params:
//   - format  : "csv" (default) | "json"
//   - status  : filter by status (optional)
//   - category: filter by category (optional)
//   - source  : filter by source (optional)
//
// CSV format:
//   - First row: column headers
//   - Subsequent rows: one opportunity per row
//   - Comma-separated, double-quoted fields containing commas/newlines
//   - Content-Type: text/csv; charset=utf-8
//   - Content-Disposition: attachment; filename="opportunities-YYYY-MM-DD.csv"
//
// JSON format:
//   - Returns a bare array of opportunity objects (same shape as the DB rows)
//   - Content-Type: application/json; charset=utf-8
//   - Content-Disposition: attachment; filename="opportunities-YYYY-MM-DD.json"
//
// The endpoint is capped at 10,000 rows to prevent runaway memory usage —
// enough for any realistic single-operator deployment. If the DB has
// more, the response includes a `truncated: true` flag (JSON) or a
// trailing comment line (CSV).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";

export const dynamic = "force-dynamic";

const MAX_ROWS = 10_000;

/** CSV-escape a single field: wrap in double quotes + escape inner quotes. */
function csvEscape(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  // Replace any double-quote with two double-quotes, then wrap the whole
  // thing in double-quotes. This handles commas, newlines, and quotes.
  return `"${s.replace(/"/g, '""')}"`;
}

/** Build a CSV string from a list of objects + a column list. */
function toCSV(
  rows: Record<string, unknown>[],
  columns: Array<{ key: string; label: string }>
): string {
  const header = columns.map((c) => csvEscape(c.label)).join(",");
  const body = rows
    .map((row) => columns.map((c) => csvEscape(row[c.key])).join(","))
    .join("\n");
  return `${header}\n${body}`;
}

function dateStamp(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export async function GET(req: Request) {
  try {
    await bootstrapAgent();

    const url = new URL(req.url);
    const format = (url.searchParams.get("format") ?? "csv").toLowerCase();
    const status = url.searchParams.get("status") ?? undefined;
    const category = url.searchParams.get("category") ?? undefined;
    const source = url.searchParams.get("source") ?? undefined;

    // Build the where clause from the filters.
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (category) where.category = category;
    if (source) where.source = source;

    // Fetch up to MAX_ROWS. We sort by createdAt DESC so the export
    // favors recent opportunities when the cap is hit.
    const rows = await db.opportunity.findMany({
      where: where as never,
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS + 1, // +1 so we can detect truncation.
      select: {
        id: true,
        canonicalId: true,
        title: true,
        description: true,
        source: true,
        sourceUrl: true,
        organization: true,
        category: true,
        rewardAmount: true,
        rewardCurrency: true,
        rewardUsd: true,
        deadline: true,
        estimatedHours: true,
        difficulty: true,
        competition: true,
        riskScore: true,
        verificationScore: true,
        confidence: true,
        status: true,
        expectedValue: true,
        expectedHourly: true,
        riskAdjustedHourly: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const truncated = rows.length > MAX_ROWS;
    const trimmed = truncated ? rows.slice(0, MAX_ROWS) : rows;

    // Serialize dates to ISO strings for stable CSV/JSON output.
    const serializable = trimmed.map((r) => ({
      ...r,
      deadline: r.deadline instanceof Date ? r.deadline.toISOString() : r.deadline,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
    }));

    const filename = `opportunities-${dateStamp()}`;

    if (format === "json") {
      return NextResponse.json(
        { opportunities: serializable, count: serializable.length, truncated },
        {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}.json"`,
            "Cache-Control": "no-store",
          },
        }
      );
    }

    // Default: CSV.
    const columns = [
      { key: "id", label: "id" },
      { key: "canonicalId", label: "canonicalId" },
      { key: "title", label: "title" },
      { key: "source", label: "source" },
      { key: "sourceUrl", label: "sourceUrl" },
      { key: "organization", label: "organization" },
      { key: "category", label: "category" },
      { key: "rewardAmount", label: "rewardAmount" },
      { key: "rewardCurrency", label: "rewardCurrency" },
      { key: "rewardUsd", label: "rewardUsd" },
      { key: "deadline", label: "deadline" },
      { key: "estimatedHours", label: "estimatedHours" },
      { key: "difficulty", label: "difficulty" },
      { key: "competition", label: "competition" },
      { key: "riskScore", label: "riskScore" },
      { key: "verificationScore", label: "verificationScore" },
      { key: "confidence", label: "confidence" },
      { key: "status", label: "status" },
      { key: "expectedValue", label: "expectedValue" },
      { key: "expectedHourly", label: "expectedHourly" },
      { key: "riskAdjustedHourly", label: "riskAdjustedHourly" },
      { key: "createdAt", label: "createdAt" },
      { key: "updatedAt", label: "updatedAt" },
    ];
    let csv = toCSV(serializable as Record<string, unknown>[], columns);
    if (truncated) {
      csv += `\n# TRUNCATED at ${MAX_ROWS} rows (more exist in the DB — apply a filter to narrow the export)`;
    }

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[api/export/opportunities GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
