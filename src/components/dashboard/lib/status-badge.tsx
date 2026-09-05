"use client";

// StatusBadge — the canonical status pill used across the dashboard.
//
// Wraps the shadcn Badge with:
//   - A colored left-border accent (border-l-2) so each status reads at a
//     glance even in monochrome prints (spec §26).
//   - A small Lucide icon prefix that visually matches the status semantic
//     (Circle for discovered, Search for researching, ShieldCheck for
//     verified, Clock for queued, Code for planning, CheckCircle for
//     approved, Loader for executing, PackageCheck for executed,
//     GitPullRequest for submitted, Wallet for awaiting_payment,
//     RefreshCw for needs_improvement, Check for paid, XCircle for
//     rejected/failed).
//   - Improved dark-mode contrast via /20 opacity backgrounds.
//
// Consumers can pass an optional `children` to override the label, plus
// standard Badge props (size, variant, className).
//
// Color + border classes are sourced from `statusColor` in `./api` so the
// palette stays in lock-step with the rest of the dashboard.

import * as React from "react";
import {
  Circle,
  Search,
  ShieldCheck,
  Clock,
  Code,
  CheckCircle,
  Loader,
  PackageCheck,
  GitPullRequest,
  Wallet,
  RefreshCw,
  Check,
  XCircle,
  HelpCircle,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { statusColor } from "./api";

/**
 * Maps an opportunity / task status to a Lucide icon component.
 *
 * Used by `StatusBadge` for the prefix icon, and by the Lifecycle tab for
 * the per-node icon. Exported so other components can render the icon
 * standalone (without the Badge wrapper).
 */
export const STATUS_ICON_MAP: Record<string, LucideIcon> = {
  discovered: Circle,
  researching: Search,
  verified: ShieldCheck,
  rejected: XCircle,
  queued: Clock,
  planning: Code,
  approved: CheckCircle,
  executing: Loader,
  executed: PackageCheck,
  submitted: GitPullRequest,
  awaiting_payment: Wallet,
  needs_improvement: RefreshCw,
  paid: Check,
  failed: XCircle,
  // Task-status aliases (the same component is reused for TaskStatus badges).
  pending: Circle,
  running: Loader,
  success: CheckCircle,
  skipped: HelpCircle,
  cancelled: XCircle,
};

/**
 * Resolve a Lucide icon for a status. Falls back to `HelpCircle` when the
 * status is unrecognized (e.g. an unknown task status) so callers never
 * render an empty prefix.
 */
export function statusIcon(status: string): LucideIcon {
  return STATUS_ICON_MAP[status] ?? HelpCircle;
}

export interface StatusBadgeProps
  extends Omit<React.ComponentProps<typeof Badge>, "ref"> {
  status: string;
  /** Override the visible label (defaults to the statusColor label). */
  label?: string;
  /** Hide the icon prefix — useful for compact table rows. */
  hideIcon?: boolean;
  /** Spin the icon (used for `executing` / `running`). */
  spin?: boolean;
}

/**
 * Renders a status pill with colored left-border accent + Lucide icon prefix.
 *
 * The pill is `variant="outline"` so the colored classes from `statusColor`
 * are applied directly via `className`. The `border-l-2 border-l-{color}/80`
 * accent is appended automatically so every status has a 2px colored strip
 * on its left edge.
 */
export const StatusBadge = React.forwardRef<
  HTMLSpanElement,
  StatusBadgeProps
>(function StatusBadge(
  { status, label, hideIcon, spin, className, children, ...rest },
  ref
) {
  const c = statusColor(status);
  const IconComp = statusIcon(status);
  const shouldSpin =
    spin ?? (status === "executing" || status === "running");

  // Render the Lucide icon via React.createElement so the ESLint
  // `react-hooks/static-components` rule doesn't flag this as a component
  // created during render (we're just *referencing* an existing component
  // from STATUS_ICON_MAP, not defining one inline).
  const iconElement = hideIcon
    ? null
    : React.createElement(IconComp, {
        className: cn("size-3 shrink-0", shouldSpin && "animate-spin"),
        "aria-hidden": true,
      });

  return (
    <Badge
      ref={ref}
      variant="outline"
      className={cn(
        "gap-1 capitalize",
        c.bg,
        c.text,
        c.border,
        c.borderLeft,
        className
      )}
      {...rest}
    >
      {iconElement}
      <span className="truncate">{children ?? label ?? c.label}</span>
    </Badge>
  );
});
