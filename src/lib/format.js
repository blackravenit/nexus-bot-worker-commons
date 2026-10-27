// =============================================================================
// lib/format.js: fleet-wide formatting helpers.
//
// Pure functions. No I/O, no env reads. Safe under Cloudflare Workers.
//
// Two output modes across the fleet (see FLEET_OUTPUT_STYLE.md):
//   - Rich markdown for human-facing reports (briefings, digests, recaps).
//   - Fenced bangReport for diagnostics (errors, monitor output, raw JSON).
//
// These helpers exist so every bot formats currency, numbers, dates, mentions,
// and bullet lists identically. Drift is a review-flag.
//
// All time/date helpers default to America/Phoenix when a tz option is passed
// explicitly. They do NOT default to AZ when tz is omitted, that would shift
// legacy call sites. Callers opt in.
// =============================================================================

const AZ = "America/Phoenix";

// ─── DATES / TIMES ───────────────────────────────────────────────────────────

function toDate(d) {
  if (d instanceof Date) return d;
  if (typeof d === "number") return new Date(d);
  if (typeof d === "string") return new Date(d);
  return new Date();
}

function tzSuffix(tz) {
  if (!tz) return "";
  if (tz === AZ) return " AZ";
  // Trim "America/Phoenix" → "Phoenix" as a fallback for non-AZ explicit tzs.
  const tail = tz.split("/").pop();
  return tail ? ` ${tail}` : "";
}

/**
 * Format a date. Options:
 *   format: 'long' (default) → "May 20, 2026"
 *           'short'          → "5/20/26"
 *           'iso'            → "2026-05-20" (date-only, tz-shifted)
 *           'day'            → "Wednesday"
 *           'full'           → "Wednesday, May 20, 2026"
 *   tz: IANA tz; omit for runtime-local
 */
export function fmtDate(d, opts = {}) {
  const date = toDate(d);
  const { format = "long", tz } = opts;
  const base = { timeZone: tz || undefined };
  if (format === "iso") {
    const parts = new Intl.DateTimeFormat("en-CA", { ...base, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const m = Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, p.value]));
    return `${m.year}-${m.month}-${m.day}`;
  }
  if (format === "short") {
    return new Intl.DateTimeFormat("en-US", { ...base, year: "2-digit", month: "numeric", day: "numeric" }).format(date);
  }
  if (format === "day") {
    return new Intl.DateTimeFormat("en-US", { ...base, weekday: "long" }).format(date);
  }
  if (format === "full") {
    return new Intl.DateTimeFormat("en-US", { ...base, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat("en-US", { ...base, year: "numeric", month: "long", day: "numeric" }).format(date);
}

/**
 * Format a time. Options: tz, seconds (default false), hour12 (default true).
 * Appends " AZ" when tz === America/Phoenix so the surface is unambiguous.
 */
export function fmtTime(d, opts = {}) {
  const date = toDate(d);
  const { tz, seconds = false, hour12 = true } = opts;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || undefined,
    hour: "numeric",
    minute: "2-digit",
    second: seconds ? "2-digit" : undefined,
    hour12,
  });
  return `${fmt.format(date)}${tzSuffix(tz)}`;
}

/** Combine fmtDate('long') + fmtTime. */
export function fmtDateTime(d, opts = {}) {
  return `${fmtDate(d, opts)} ${fmtTime(d, opts)}`;
}

/**
 * Relative time string. "just now", "in 3h", "2d ago".
 * Capped at days; beyond ~30d falls back to fmtDate('short').
 */
export function fmtRelative(d, opts = {}) {
  const target = toDate(d).getTime();
  const now = opts.now ?? Date.now();
  const diff = target - now;
  const abs = Math.abs(diff);
  const sec = 1000, min = 60 * sec, hour = 60 * min, day = 24 * hour;
  if (abs < 45 * sec) return "just now";
  const past = diff < 0;
  const fmt = (n, unit) => past ? `${n}${unit} ago` : `in ${n}${unit}`;
  if (abs < hour) return fmt(Math.round(abs / min), "m");
  if (abs < day) return fmt(Math.round(abs / hour), "h");
  if (abs < 30 * day) return fmt(Math.round(abs / day), "d");
  return fmtDate(d, { format: "short", tz: opts.tz });
}

/**
 * Emit a Nexus/Discord-style timestamp token the renderer auto-converts to the
 * viewer's local tz. format is one of t/T/d/D/f/F/R. Use ONLY in rich reports
 * (never in title/preview line: push notifications strip markdown and the
 * token shows as ugly literal text).
 */
export function nexusTimestamp(d, format = "f") {
  const secs = Math.floor(toDate(d).getTime() / 1000);
  return `<t:${secs}:${format}>`;
}

/**
 * Canonical "what day/time is it in AZ?" snapshot for system-prompt grounding
 * and any cron/report that needs a stable local-day reference. AZ has no DST
 * (UTC-7 year-round) so this is rock-solid.
 *
 * Returns:
 *   iso       "2026-05-20"                 local YYYY-MM-DD
 *   weekday   "Wednesday"
 *   full      "Wednesday, May 20, 2026"
 *   time      "2:34 PM AZ"
 *   iso8601   "2026-05-20T14:34:00-07:00"  wall-clock with AZ offset
 */
export function phoenixToday(now = new Date()) {
  return {
    iso: fmtDate(now, { format: "iso", tz: AZ }),
    weekday: fmtDate(now, { format: "day", tz: AZ }),
    full: fmtDate(now, { format: "full", tz: AZ }),
    time: fmtTime(now, { tz: AZ }),
    iso8601: (() => {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: AZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).formatToParts(now);
      const m = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
      const hour = m.hour === "24" ? "00" : m.hour;
      return `${m.year}-${m.month}-${m.day}T${hour}:${m.minute}:${m.second}-07:00`;
    })(),
  };
}

// Phoenix is UTC-7 year-round (no DST), so a fixed offset is exact.
const AZ_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * Canonical "today" as YYYY-MM-DD in America/Phoenix. Use this everywhere a bot
 * needs the current local date for a tool answer, dedup key, or invoice stamp.
 *
 * Never use `new Date().toISOString().slice(0, 10)` for "today" -- CF Workers
 * run in UTC, so after ~5 PM AZ that returns TOMORROW. This is the regression
 * that keeps reappearing; route through here instead.
 *
 * @param {Date} [now] - instant to evaluate (defaults to current time)
 * @returns {string} "2026-06-05"
 */
export function todayIso(now = new Date()) {
  return phoenixToday(now).iso;
}

/**
 * Current weekday index in America/Phoenix: 0=Sunday ... 6=Saturday.
 * AZ-local, matching JS getDay() semantics but immune to the UTC rollover that
 * makes a bare `new Date().getDay()` / `getUTCDay()` report the wrong day in
 * the AZ evening.
 *
 * @param {Date} [now] - instant to evaluate (defaults to current time)
 * @returns {number} 0..6
 */
export function phoenixWeekdayIndex(now = new Date()) {
  return new Date(now.getTime() - AZ_OFFSET_MS).getUTCDay();
}

// ─── NUMBERS / MONEY ────────────────────────────────────────────────────────

/**
 * Currency. Options:
 *   currency: 'USD' (default)
 *   cents:    if true, n is integer cents (1234 → "$12.34")
 * Null / NaN → "$0.00".
 */
export function fmtCurrency(n, opts = {}) {
  const { currency = "USD", cents = false } = opts;
  let value = Number(n);
  if (!Number.isFinite(value)) value = 0;
  if (cents) value = value / 100;
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
}

/**
 * Number with locale grouping.
 *   decimals: fixed decimal places
 *   compact:  true → "1.2M" style (≥ 1000)
 */
export function fmtNumber(n, opts = {}) {
  const { decimals, compact = false } = opts;
  let value = Number(n);
  if (!Number.isFinite(value)) value = 0;
  if (compact) {
    return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: decimals ?? 1 }).format(value);
  }
  const fmtOpts = {};
  if (typeof decimals === "number") {
    fmtOpts.minimumFractionDigits = decimals;
    fmtOpts.maximumFractionDigits = decimals;
  }
  return new Intl.NumberFormat("en-US", fmtOpts).format(value);
}

/**
 * Percent. Accepts fraction (0..1) or explicit percent (>1.5 treated as %).
 * Override with mode: 'fraction' | 'percent'.
 */
export function fmtPercent(n, opts = {}) {
  const { decimals = 0, mode } = opts;
  let v = Number(n);
  if (!Number.isFinite(v)) v = 0;
  if (mode === "fraction") v = v * 100;
  else if (mode === "percent") { /* leave as-is */ }
  else if (Math.abs(v) <= 1.5) v = v * 100;
  return `${v.toFixed(decimals)}%`;
}

/** Binary bytes (1024-based). 1536 → "1.5 KB". */
export function fmtBytes(n) {
  let v = Number(n);
  if (!Number.isFinite(v)) v = 0;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const decimals = i === 0 ? 0 : 1;
  return `${v.toFixed(decimals)} ${units[i]}`;
}

// ─── STRINGS / LISTS ────────────────────────────────────────────────────────

/** Truncate to at most `max` chars, appending `suffix` if cut. Surrogate-safe. */
export function truncate(s, max, suffix = "…") {
  const str = String(s ?? "");
  if (max <= 0) return "";
  if ([...str].length <= max) return str;
  const arr = [...str];
  const cut = Math.max(0, max - [...suffix].length);
  return arr.slice(0, cut).join("") + suffix;
}

/** "3 endpoints" / "1 endpoint". Negative/null → 0. */
export function pluralize(n, singular, plural) {
  const v = Number.isFinite(Number(n)) ? Number(n) : 0;
  const word = v === 1 ? singular : (plural || singular + "s");
  return `${fmtNumber(v)} ${word}`;
}

/** Same but bare word, no count prefix. */
export function pluralizeBare(n, singular, plural) {
  const v = Number.isFinite(Number(n)) ? Number(n) : 0;
  return v === 1 ? singular : (plural || singular + "s");
}

/**
 * Bullet list with overflow handling.
 *   items: pre-formatted strings
 *   max:   visible cap (default 8); remainder rendered as "_+N more_"
 *   bullet: default "•"
 *   joiner: default "\n"
 * Empty array → "(none)" (explicit no-data marker; safer than silent blank).
 */
export function fmtList(items, opts = {}) {
  const { bullet = "•", max = 8, overflowSuffix, joiner = "\n", emptyLabel = "(none)" } = opts;
  const arr = Array.isArray(items) ? items.filter(x => x !== null && x !== undefined && x !== "") : [];
  if (arr.length === 0) return emptyLabel;
  if (arr.length <= max) {
    return arr.map(it => `${bullet} ${it}`).join(joiner);
  }
  const head = arr.slice(0, max).map(it => `${bullet} ${it}`).join(joiner);
  const remaining = arr.length - max;
  const overflow = overflowSuffix ?? `_+${remaining} more_`;
  return `${head}${joiner}${overflow}`;
}

/**
 * Aligned key:value rows. Intended for INSIDE a code fence (bangReport).
 * Don't use in rich markdown: alignment goes wrong under proportional fonts.
 */
export function fmtKv(rows, opts = {}) {
  const { align = true, sep = ": " } = opts;
  const arr = Array.isArray(rows) ? rows : [];
  if (arr.length === 0) return "";
  const cleaned = arr.map(([k, v]) => [String(k ?? ""), String(v ?? "")]);
  if (!align) return cleaned.map(([k, v]) => `${k}${sep}${v}`).join("\n");
  const maxKey = cleaned.reduce((m, [k]) => Math.max(m, k.length), 0);
  return cleaned.map(([k, v]) => `${k.padEnd(maxKey)}${sep}${v}`).join("\n");
}

/**
 * Small GFM table. Use in rich reports.
 *   headers: ["Col A", "Col B"]
 *   rows:    [["a1", "b1"], ["a2", "b2"]]
 */
export function fmtTable(headers, rows) {
  const h = Array.isArray(headers) ? headers : [];
  const r = Array.isArray(rows) ? rows : [];
  if (h.length === 0) return "";
  const sep = h.map(() => "---");
  const fmtRow = (cols) => `| ${cols.map(c => String(c ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
  return [fmtRow(h), fmtRow(sep), ...r.map(fmtRow)].join("\n");
}

/**
 * Fixed-width monospace table for bangAlert / bangReport bodies. Pads each
 * column to the widest cell so columns line up under the code-block render.
 * Use this on HITL cards and any plain-text section that mixes labels with
 * numeric columns.
 *
 *   headers: ["Description", "Qty", "Rate", "Amount"]
 *   rows:    [["Cloud Storage", "13", "$12.00", "$156.00"], ...]
 *   align:   ["left", "right", "right", "right"]      // optional per-column
 *   gap:     "  "                                     // optional, default 2 spaces
 *   indent:  "  "                                     // optional, default 2 spaces
 *
 * Returns a multi-line string (no trailing newline). Cells are coerced to
 * strings; null/undefined render as "". Headers may be omitted (pass null).
 */
export function fmtFixedTable(headers, rows, opts = {}) {
  const { align = [], gap = "  ", indent = "  " } = opts;
  const r = Array.isArray(rows) ? rows : [];
  if (r.length === 0 && !headers) return "";
  const h = Array.isArray(headers) ? headers : null;
  const cells = (h ? [h, ...r] : r).map(row =>
    (Array.isArray(row) ? row : []).map(c => String(c ?? "")),
  );
  const colCount = cells.reduce((m, row) => Math.max(m, row.length), 0);
  const widths = new Array(colCount).fill(0);
  for (const row of cells) {
    for (let i = 0; i < colCount; i++) {
      widths[i] = Math.max(widths[i], (row[i] || "").length);
    }
  }
  const pad = (s, w, a) => (a === "right" ? s.padStart(w) : s.padEnd(w));
  const renderRow = (row) => indent + row.map((c, i) => {
    const isLast = i === colCount - 1;
    const a = align[i] || (i === 0 ? "left" : "right");
    const padded = pad(c, widths[i], a);
    // Trim trailing spaces on the last column for clean line endings.
    return isLast && a === "left" ? padded.trimEnd() : padded;
  }).join(gap);
  return cells.map(renderRow).join("\n");
}

/** Oxford-comma join. ['a','b','c'] → "a, b, and c". */
export function joinOxford(items, conj = "and") {
  const arr = (Array.isArray(items) ? items : []).map(String);
  if (arr.length === 0) return "";
  if (arr.length === 1) return arr[0];
  if (arr.length === 2) return `${arr[0]} ${conj} ${arr[1]}`;
  return `${arr.slice(0, -1).join(", ")}, ${conj} ${arr[arr.length - 1]}`;
}

/**
 * Aggressive markdown-to-text. Mirrors nexus-app embedToPreview.js, keep in
 * sync. Used for the 140-char toast/push preview safety check.
 */
export function stripMarkdown(s) {
  return String(s ?? "")
    .replace(/```[\s\S]*?```/g, " ")         // fenced code
    .replace(/`([^`]*)`/g, "$1")             // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")    // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → label
    .replace(/<t:\d+:[a-zA-Z]>/g, "")        // timestamp tokens
    .replace(/[#>*_~]+/g, "")                // header/emphasis markers
    .replace(/^-+\s*$/gm, "")                // hr lines
    .replace(/\|/g, " ")                     // table pipes
    .replace(/\s+/g, " ")
    .trim();
}

// ─── NEXUS CHIPS ────────────────────────────────────────────────────────────

/** Mention chip for a Nexus user UUID. */
export function mention(userId) {
  if (!userId) return "";
  return `<@${userId}>`;
}

/** Oxford-comma join of mentions. */
export function mentionMany(ids, conj = "and") {
  const arr = (Array.isArray(ids) ? ids : []).filter(Boolean).map(id => `<@${id}>`);
  return joinOxford(arr, conj);
}

/** "#slug" channel chip. */
export function channelLink(slug) {
  if (!slug) return "";
  return `#${String(slug).replace(/^#/, "")}`;
}

/** Backtick-wrapped inline code, escaping any existing backticks. */
export function codeSpan(text) {
  const s = String(text ?? "");
  if (!s) return "";
  return `\`${s.replace(/`/g, "\\`")}\``;
}

/** Markdown link [label](url). Escapes brackets and parens in label/url. */
export function linkLabel(url, label) {
  const u = String(url ?? "").replace(/\)/g, "%29");
  const l = String(label ?? url ?? "").replace(/[\[\]]/g, "");
  return `[${l}](${u})`;
}

// ─── EMOJI PALETTE ──────────────────────────────────────────────────────────
//
// Closed set. Bots pick semantic keys, not literal emoji. Freelance emoji at
// a call site is a review-flag.
//
// Some keys map to the same glyph on purpose (OK/TASKS both ✅), semantics
// matter for grep + future renaming, not the rendered glyph.

export const PALETTE = Object.freeze({
  // Sections / digests
  SCHEDULE:   "📅",
  EMAIL:      "📧",
  REMINDERS:  "⏰",
  NOTES:      "📝",
  MONEY:      "💰",

  // Metrics / state
  METRICS:    "📊",
  DEVICES:    "🖥",
  AUDIT:      "🔍",

  // Status
  STATUS_OK:  "✅",
  OK:         "✅",   // alias of STATUS_OK; both names accepted
  WARN:       "⚠️",
  ALERT:      "🚨",
  ERROR:      "❌",
  SECURITY:   "🛡",
  BREACH:     "🔓",

  // Lifecycle
  NEW:        "🆕",
  PENDING:    "⏳",
  DONE:       "🏁",
  BLOCKED:    "🛑",

  // Comms
  MESSAGE:    "💬",
  TICKET:     "🎫",
  LINK:       "🔗",

  // DEPRECATED -- retained for backward compatibility with 6 known call
  // sites (see git grep PALETTE.TASKS|PLANNER|WEATHER|TREND|MENTION). New
  // code must NOT use these; the healer scorecard flags any addition.
  TASKS:      "✅",
  PLANNER:    "📋",
  WEATHER:    "🌤",
  TREND:      "📈",
  MENTION:    "👤",
});
