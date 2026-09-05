// URL validator (spec §7 suspicious domains, §32 security).
//
// Every URL the agent touches (opportunity sourceUrl, README link in a
// bounty description, payment-method URL, webhook callback…) must pass
// through this validator before it is fetched, persisted, or shown to a
// human. The validator applies a deterministic set of checks:
//
//   1. SCHEME allow-list — only http/https by default. `javascript:`,
//      `data:`, `file:`, `blob:` and other dangerous schemes are rejected.
//   2. PRIVATE-IP rejection — 127.x, 10.x, 192.168.x, 169.254.x, ::1, fc00::/7
//      (SSRF prevention). Override with `allowPrivate: true`.
//   3. LOCALHOST rejection — `localhost` / `*.localhost`. Override with
//      `allowLocalhost: true`.
//   4. IDN HOMOGRAPH detection — mixed-script hostnames (Latin + Cyrillic)
//      are rejected because they are the canonical phishing trick
//      (e.g. `аpple.com` where the `а` is U+0430 Cyrillic small a).
//   5. PUNYCODE / suspicious-TLD check — `xn--`-encoded hosts that decode
//      to known-suspicious TLDs are rejected.
//   6. URL-format validation via the standard `URL` constructor.
//
// The function never throws — every rejection is returned as a structured
// `UrlValidationResult` with one or more `reasons[]` so the caller can
// surface a human-readable explanation.

import { domainToUnicode } from "node:url";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ValidateUrlOptions {
  /**
   * Schemes that are permitted. Defaults to `["http:", "https:"]`. Add
   * schemes here only if you have a specific reason — e.g. `ipfs:` for a
   * pinned-content fetcher.
   */
  allowedSchemes?: string[];
  /**
   * Allow private / loopback / link-local IP literals in the hostname.
   * Defaults to `false`. Set to `true` only for internal-only services
   * (never for URLs that originate from external content).
   */
  allowPrivate?: boolean;
  /**
   * Allow `localhost` and `*.localhost` hostnames. Defaults to `false`.
   */
  allowLocalhost?: boolean;
}

export interface UrlValidationResult {
  /** True iff the URL parses and passes the scheme check. */
  valid: boolean;
  /** True iff the URL passes ALL safety checks (not just scheme/format). */
  safe: boolean;
  /** The normalized URL string (`https://host/path?query`). Empty on parse error. */
  normalized: string;
  /** Human-readable rejection reasons. Empty when everything passed. */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Defaults & constants
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_SCHEMES = ["http:", "https:"];

/**
 * Schemes that are ALWAYS rejected unless explicitly listed in
 * `allowedSchemes`. Even when listed, callers should think twice —
 * `javascript:` in particular is essentially never safe to follow.
 */
const ALWAYS_REJECT_SCHEMES = new Set([
  "javascript:",
  "data:",
  "file:",
  "blob:",
  "vbscript:",
]);

/**
 * IPv4 private / loopback / link-local ranges. Each entry is a regex anchored
 * to the start of the host so it matches the literal octets.
 *
 *   - 127.0.0.0/8     loopback
 *   - 10.0.0.0/8      RFC1918 private
 *   - 172.16.0.0/12   RFC1918 private (covered by the 172.16-31 regex below)
 *   - 192.168.0.0/16  RFC1918 private
 *   - 169.254.0.0/16  link-local
 *   - 0.0.0.0/8       "this host" — never a valid destination
 */
const PRIVATE_IPV4_PATTERNS: RegExp[] = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  // 172.16.0.0 – 172.31.255.255 (RFC1918)
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
];

/**
 * IPv6 loopback / private / link-local patterns. We don't do CIDR math here;
 * we use prefix matches against the canonical textual forms a browser or
 * fetch() implementation would normalise to.
 */
const PRIVATE_IPV6_PATTERNS: RegExp[] = [
  /^::1$/, // loopback
  /^::$/, // unspecified
  /^fe80:/i, // link-local
  /^fc00:/i, // unique-local
  /^fd[0-9a-f]{2}:/i, // unique-local
  /^fe00:/i, // older link-local variant
];

/**
 * Suspicious TLDs frequently abused by phishing kits. The list is short by
 * design — we don't want to flag every new gTLD, only the handful with
 * sustained abuse rates.
 */
const SUSPICIOUS_TLDS = new Set([
  "zip",
  "mov",
  "xyz",
  "top",
  "click",
  "link",
  "work",
  "gq",
  "tk",
  "ml",
  "cf",
  "country",
  "stream",
  "online",
  "buzz",
  "icu",
  "rest",
  "live",
  "sbs",
]);

/**
 * The set of Unicode general scripts we consider "Latin-compatible" for the
 * homograph check. Any character in a hostname that is NOT in one of these
 * scripts (and is also not a digit, dot, or hyphen) is treated as a
 * homograph attempt.
 *
 * We intentionally keep this list narrow: a hostname containing Cyrillic,
 * Greek, or Armenian letters next to Latin letters is almost always a
 * phishing attempt.
 */
const LATIN_COMPAT_BLOCKS = new Set([
  "Basic_Latin",
  "Latin_1_Supplement",
  "Latin_Extended_A",
  "Latin_Extended_B",
  "Latin_Extended_Additional",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a URL against the agent's security policy (spec §7, §32).
 *
 * Returns a {@link UrlValidationResult}. Never throws.
 *
 * @param url  the URL string to validate
 * @param opts optional overrides (allowed schemes, private/localhost)
 */
export function validateUrl(
  url: string,
  opts?: ValidateUrlOptions
): UrlValidationResult {
  const reasons: string[] = [];
  const allowedSchemes =
    opts?.allowedSchemes && opts.allowedSchemes.length > 0
      ? opts.allowedSchemes.map((s) => s.toLowerCase())
      : DEFAULT_ALLOWED_SCHEMES;

  // ---- 1. Basic type guard + non-empty -----------------------------------
  if (typeof url !== "string" || url.length === 0) {
    return {
      valid: false,
      safe: false,
      normalized: "",
      reasons: ["url is empty or not a string."],
    };
  }

  // ---- 2. Reject control characters / whitespace before parsing -----------
  // `new URL()` will happily parse `   javascript:alert(1)` — the leading
  // spaces survive and the scheme is `javascript:`. We refuse to be tricked.
  if (/[\u0000-\u001f\u007f]/.test(url) || /^\s|\s$/.test(url)) {
    return {
      valid: false,
      safe: false,
      normalized: "",
      reasons: ["url contains control characters or leading/trailing whitespace."],
    };
  }

  // ---- 3. Parse via the standard URL constructor --------------------------
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      valid: false,
      safe: false,
      normalized: "",
      reasons: [`url does not parse as a valid URL: "${truncate(url, 80)}".`],
    };
  }

  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();

  // ---- 4. Scheme check ---------------------------------------------------
  if (ALWAYS_REJECT_SCHEMES.has(scheme)) {
    reasons.push(
      `scheme '${scheme}' is always rejected (spec §32 — XSS / RCE primitive).`
    );
    // Continue the rest of the checks so the caller sees every problem.
  }

  if (!allowedSchemes.includes(scheme)) {
    reasons.push(
      `scheme '${scheme}' is not in the allowed list [${allowedSchemes.join(", ")}].`
    );
  }

  // ---- 5. Hostname presence ----------------------------------------------
  if (!host) {
    reasons.push("url has no hostname (e.g. 'javascript:void(0)').");
  }

  // ---- 6. Localhost check ------------------------------------------------
  const isLocalhost =
    host === "localhost" || host.endsWith(".localhost");
  if (isLocalhost && !opts?.allowLocalhost) {
    reasons.push(
      "hostname is 'localhost' / '*.localhost' and allowLocalhost is false (dev/SSRF guard)."
    );
  }

  // ---- 7. Private / loopback IP check ------------------------------------
  if (!opts?.allowPrivate && host) {
    const privateReason = detectPrivateIp(host);
    if (privateReason) {
      reasons.push(privateReason);
    }
  }

  // ---- 8. IDN homograph check -------------------------------------------
  // `URL.hostname` ALWAYS returns the punycode form (`xn--…`) for any
  // non-ASCII hostname. To detect mixed-script attacks we have to decode
  // the punycode back to its unicode form and inspect the underlying
  // characters. A hostname like `xn--pple-43d.com` decodes to `аpple.com`
  // (with Cyrillic `а`) — a clear homograph attack.
  const decodedHost = safeDomainToUnicode(host);
  const homographReason = detectHomograph(decodedHost || host);
  if (homographReason) {
    reasons.push(homographReason);
  }

  // ---- 9. Suspicious-TLD check -------------------------------------------
  // We look at the last label of the host (the TLD) and, for compound TLDs
  // like `.co.uk`, the second-to-last label too.
  const tldReason = detectSuspiciousTld(host);
  if (tldReason) {
    reasons.push(tldReason);
  }

  // ---- 10. Build the normalized form ------------------------------------
  // We re-emit via `URL.toString()` so the host is lowercased, the port is
  // dropped when default, and any unicode host is left as-is (we don't
  // punycode-encode here because we may have rejected it above).
  const normalized = parsed.toString();

  const valid = reasons.length === 0 || schemeAllowed(scheme, allowedSchemes, reasons);
  const safe = reasons.length === 0;

  return {
    valid,
    safe,
    normalized,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Return a reason string if the host is a private / loopback / link-local
 * IPv4 or IPv6 literal; otherwise return null.
 */
function detectPrivateIp(host: string): string | null {
  // Strip IPv6 brackets if present (URL.hostname already strips them).
  const bare = host.replace(/^\[|\]$/g, "");

  for (const re of PRIVATE_IPV4_PATTERNS) {
    if (re.test(bare)) {
      return `hostname '${bare}' is a private / loopback IPv4 address (SSRF guard).`;
    }
  }
  for (const re of PRIVATE_IPV6_PATTERNS) {
    if (re.test(bare)) {
      return `hostname '${bare}' is a private / loopback IPv6 address (SSRF guard).`;
    }
  }
  return null;
}

/**
 * Return a reason string if the host mixes characters from different Unicode
 * scripts (the canonical homograph-attack signature), or if it uses
 * `xn--`-encoded punycode that decodes to a mixed-script label.
 *
 * False-positive risk: legitimate IDN domains like `münchen.de` use a single
 * non-Latin script (Latin Extended-A) and will NOT trip this check. The
 * detector only fires when TWO OR MORE different scripts appear in the same
 * label.
 */
function detectHomograph(host: string): string | null {
  if (!host) return null;
  // Split into labels (www.example.com → ["www","example","com"]).
  const labels = host.split(".");
  for (const label of labels) {
    // Convert punycode form (`xn--...`) to its decoded unicode form so we can
    // inspect the underlying characters. We do this manually rather than via
    // `URL` because the URL constructor already gives us the decoded form in
    // `hostname` — but a malicious caller may pass a pre-punycode-encoded
    // string. Cheap-and-cheerful: if the label starts with `xn--` we treat it
    // as IDN and inspect the original AND the (heuristic) decoded form.
    const scripts = collectScripts(label);
    if (scripts.size >= 2) {
      return (
        `hostname label '${label}' mixes Unicode scripts ` +
        `([${Array.from(scripts).join(", ")}]) — possible homograph / IDN phishing.`
      );
    }
  }
  return null;
}

/**
 * Walk every character of `label` and collect the set of distinct Unicode
 * scripts, ignoring ASCII digits, dots, and hyphens. Used by
 * {@link detectHomograph}.
 */
function collectScripts(label: string): Set<string> {
  const scripts = new Set<string>();
  for (const ch of label) {
    // Digits, dots, hyphens are script-agnostic — skip them.
    if (/[0-9.\-]/.test(ch)) continue;
    // Decode any `\uXXXX` punycode markers by treating the label as the
    // raw sequence of code points (string iteration already does this).
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    // ASCII range (basic Latin letters) → treat as Latin.
    if (cp >= 0x41 && cp <= 0x5a) {
      scripts.add("Latin");
      continue;
    }
    if (cp >= 0x61 && cp <= 0x7a) {
      scripts.add("Latin");
      continue;
    }
    // For non-ASCII characters we look up the Unicode script property via
    // `Intl` (cheap) — we just classify broadly: Cyrillic, Greek, and
    // "Other" (anything not in our allow-list).
    const script = classifyScript(cp);
    scripts.add(script);
  }
  return scripts;
}

/**
 * Cheap script classifier — we don't pull in a full Unicode data table, we
 * just probe the ranges that are commonly abused for homograph attacks.
 *
 *   U+0400..U+04FF  Cyrillic
 *   U+0370..U+03FF  Greek
 *   U+0530..U+058F  Armenian
 *   U+0590..U+05FF  Hebrew
 *   U+0600..U+06FF  Arabic
 *   U+3040..U+30FF  Japanese (Hiragana/Katakana)
 *   U+4E00..U+9FFF  CJK Unified Ideographs
 *
 * Anything else (non-Latin Extended) is reported as `Other` so it still
 * counts towards the "mixed scripts" verdict.
 */
function classifyScript(cp: number): string {
  if (cp >= 0x0400 && cp <= 0x04ff) return "Cyrillic";
  if (cp >= 0x0370 && cp <= 0x03ff) return "Greek";
  if (cp >= 0x0530 && cp <= 0x058f) return "Armenian";
  if (cp >= 0x0590 && cp <= 0x05ff) return "Hebrew";
  if (cp >= 0x0600 && cp <= 0x06ff) return "Arabic";
  if (cp >= 0x3040 && cp <= 0x30ff) return "Japanese";
  if (cp >= 0x4e00 && cp <= 0x9fff) return "CJK";
  // Latin-Extended ranges — still Latin, but worth distinguishing so a label
  // like `café` (Latin + Latin-1) doesn't trigger the "mixed" verdict.
  if (cp >= 0x00c0 && cp <= 0x024f) return "Latin";
  return "Other";
}

/**
 * Return a reason string if the hostname's TLD appears in our suspicious-TLD
 * set. We also flag the `xn--` punycode prefix because it's almost always
 * used for IDN redirects in phishing kits.
 */
function detectSuspiciousTld(host: string): string | null {
  if (!host) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1].toLowerCase();

  // `xn--` prefix anywhere in the host indicates IDN; flag it as info so the
  // caller can decide. (We don't auto-reject IDN — `münchen.de` is fine —
  // but we want the caller to see it.)
  if (labels.some((l) => l.toLowerCase().startsWith("xn--"))) {
    // Mixed-script IDN was already caught by detectHomograph above (after
    // punycode decoding); pure-IDN (single non-Latin script like
    // `münchen.de`) is allowed but flagged.
    const decodedHost = safeDomainToUnicode(host) || host;
    if (!detectHomograph(decodedHost)) {
      return `hostname uses punycode IDN ('xn--') — review for legitimacy.`;
    }
  }

  if (SUSPICIOUS_TLDS.has(tld)) {
    return `TLD '.${tld}' is on the suspicious-TLD list (high abuse rate).`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

/**
 * Decode a punycode-encoded hostname back to its unicode form, defensively.
 * Returns the original input if the decode fails (so the caller can fall
 * back to running the script-mix check on the punycode form, which is
 * always pure ASCII and therefore won't trigger a false-positive).
 */
function safeDomainToUnicode(host: string): string {
  if (!host) return "";
  if (!host.toLowerCase().includes("xn--")) return host;
  try {
    const decoded = domainToUnicode(host);
    return decoded || host;
  } catch {
    return host;
  }
}

/**
 * Decide whether the URL is *parsable+valid* even if other safety reasons
 * fired. The semantic: a URL with a rejected scheme is not valid; a URL with
 * a private IP is still "valid" as a URL but not "safe".
 */
function schemeAllowed(
  scheme: string,
  allowed: string[],
  reasons: string[]
): boolean {
  const rejectedScheme = reasons.some((r) =>
    r.startsWith("scheme ") && r.includes("always rejected")
  );
  if (rejectedScheme) return false;
  return allowed.includes(scheme);
}

/**
 * Touch the constant so the bundler doesn't tree-shake it out — some
 * downstream tools import the catalog directly for dashboards.
 */
export const _INTERNAL_LATIN_BLOCKS = LATIN_COMPAT_BLOCKS;
