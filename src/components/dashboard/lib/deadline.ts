// Deadline urgency helpers (v0.4.2) — shared by the Daily Briefing
// "Closing Soon" section and the Opportunities card deadline pills.
//
// Urgency ladder (days left):
//   overdue / ≤3d  → red    (act now or drop)
//   ≤7d            → amber  (plan this week)
//   >7d            → muted  (no pressure)

export interface DeadlineUrgency {
  label: string;
  /** Pill styling for badges. */
  className: string;
  /** Row/card accent styling. */
  ringClass: string;
  /** Semantic level, useful for conditionals. */
  level: "overdue" | "urgent" | "soon" | "calm";
}

/** Days left (ceiled); negative = past deadline. */
export function daysUntil(iso: string): number {
  return Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
}

export function deadlineUrgency(daysLeft: number): DeadlineUrgency {
  if (daysLeft < 0)
    return {
      label: `${Math.abs(daysLeft)}d passed`,
      className:
        "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
      ringClass: "border-red-500/30 bg-red-500/[0.03]",
      level: "overdue",
    };
  if (daysLeft <= 3)
    return {
      label: daysLeft === 0 ? "last day" : `${daysLeft}d left`,
      className:
        "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
      ringClass: "border-red-500/30 bg-red-500/[0.03]",
      level: "urgent",
    };
  if (daysLeft <= 7)
    return {
      label: `${daysLeft}d left`,
      className:
        "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
      ringClass: "border-amber-500/30 bg-amber-500/[0.03]",
      level: "soon",
    };
  return {
    label: `${daysLeft}d left`,
    className: "bg-muted text-muted-foreground border-border/60",
    ringClass: "border-border/60",
    level: "calm",
  };
}

/** Non-terminal statuses — deadline pressure only matters while there is
 *  still something to act on. */
export const DEADLINE_ACTIVE_STATUSES = new Set([
  "discovered",
  "researching",
  "verified",
  "queued",
  "planning",
  "approved",
  "executing",
  "executed",
  "submitted",
  "awaiting_payment",
  "needs_improvement",
]);
