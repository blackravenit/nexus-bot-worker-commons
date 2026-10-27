// =============================================================================
// lib/buttonId.js, fleet-wide button label + id grammar.
//
// Two things lived in this file as soon as the fleet had more than one bot:
//
// 1. BUTTON_LABELS, closed set of approved button verbs. Each verb maps
//    to {label, style} so every bot's "Approve" button reads the same and
//    uses the same accent color in Nexus. New verbs require a code change
//    here, on purpose, it's the choke point.
//
// 2. buttonId(verb, kind, id) / parseButtonId(s): canonical grammar for
//    a button's custom_id. Format: "<verb>:<kind>:<id>". Verb must be a
//    key of BUTTON_LABELS (lowercase). kind is a free-form discriminator
//    (e.g. "vendor-reply", "cadence-tick"). id is the per-row identifier.
//
// Legacy aliases ("hitl-approve", "hitl-deny") are accepted for backward
// compat with the existing hitl.js processor and not flagged as drift.
//
// Per FLEET_OUTPUT_STYLE.md, calling code MUST go through these helpers.
// Hand-rolled strings will be detected by the healer scorecard.
// =============================================================================

/**
 * Closed set of approved button verbs.
 *
 * To add a new verb: append here, add a unit test in test/buttonId.test.js,
 * add a healer classifier case if it should auto-resolve to a specific kind.
 *
 * style values mirror the Nexus renderer (`success` = green, `danger` =
 * red, `primary` = teal, `secondary` = grey).
 *
 * @type {Readonly<Record<string,{label:string,style:string}>>}
 */
export const BUTTON_LABELS = Object.freeze({
  approve:  { label: "Approve",       style: "success"   },
  deny:     { label: "Deny",          style: "danger"    },
  edit:     { label: "Edit",          style: "secondary" },
  skip:     { label: "Skip",          style: "secondary" },
  ack:      { label: "Acknowledge",   style: "secondary" },
  send:     { label: "Send",          style: "primary"   },
  discard:  { label: "Discard",       style: "danger"    },
  retry:    { label: "Retry",         style: "primary"   },
  snooze:   { label: "Snooze",        style: "secondary" },
  // Runs a READ-ONLY lookup on click and posts the result back to the channel.
  // Unlike every other verb here it decides nothing and changes nothing, so
  // handlers for it must not sit behind an approver gate: any staff member
  // clicking it is just asking to see data the card already summarised.
  reveal:   { label: "Show details",  style: "primary"   },
});

/** Verbs accepted by parseButtonId but not in BUTTON_LABELS (legacy paths). */
const LEGACY_VERBS = Object.freeze(new Set(["hitl-approve", "hitl-deny"]));

const VERB_RE = /^[a-z][a-z0-9-]*$/;
const KIND_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Build a canonical button_id string.
 *
 * Example:
 *   buttonId("approve", "vendor-reply", "vr_42")  -> "approve:vendor-reply:vr_42"
 *
 * @param {string} verb  - one of Object.keys(BUTTON_LABELS) (lowercase)
 * @param {string} kind  - lowercase-kebab discriminator
 * @param {string} id    - opaque per-row identifier (any non-empty string)
 * @returns {string}
 * @throws {Error} on grammar violations, callers should fail loudly.
 */
export function buttonId(verb, kind, id) {
  const v = String(verb || "").toLowerCase();
  if (!BUTTON_LABELS[v] && !LEGACY_VERBS.has(v)) {
    throw new Error(`buttonId: unknown verb "${verb}" (allowed: ${Object.keys(BUTTON_LABELS).join(", ")})`);
  }
  const k = String(kind || "").toLowerCase();
  if (!KIND_RE.test(k)) {
    throw new Error(`buttonId: invalid kind "${kind}" (must match [a-z][a-z0-9-]*)`);
  }
  const sid = String(id ?? "");
  if (!sid) throw new Error(`buttonId: empty id`);
  if (sid.includes(":")) {
    throw new Error(`buttonId: id may not contain ":" (got "${sid}")`);
  }
  return `${v}:${k}:${sid}`;
}

/**
 * Parse a canonical button_id string.
 *
 * Returns {verb, kind, id, legacy}. `legacy: true` for hitl-approve /
 * hitl-deny so callers can route them through the existing hitl.js path.
 *
 * @param {string} s
 * @returns {{ verb: string, kind: string, id: string, legacy: boolean }}
 * @throws {Error} if the string does not match the canonical grammar.
 */
export function parseButtonId(s) {
  if (typeof s !== "string" || !s) {
    throw new Error(`parseButtonId: expected non-empty string, got ${typeof s}`);
  }
  const parts = s.split(":");
  if (parts.length < 3) {
    throw new Error(`parseButtonId: "${s}" does not match <verb>:<kind>:<id>`);
  }
  const verb = parts[0].toLowerCase();
  const kind = parts[1].toLowerCase();
  // id may legitimately contain hyphens, dots, underscores; reassemble the tail.
  const id = parts.slice(2).join(":");
  if (!VERB_RE.test(verb)) {
    throw new Error(`parseButtonId: invalid verb "${verb}"`);
  }
  const known = !!BUTTON_LABELS[verb];
  const legacy = LEGACY_VERBS.has(verb);
  if (!known && !legacy) {
    throw new Error(`parseButtonId: unknown verb "${verb}"`);
  }
  if (!KIND_RE.test(kind)) {
    throw new Error(`parseButtonId: invalid kind "${kind}"`);
  }
  if (!id) {
    throw new Error(`parseButtonId: empty id in "${s}"`);
  }
  return { verb, kind, id, legacy };
}

/**
 * Build a button descriptor ready to pass to attachButtons().
 *
 * Merges BUTTON_LABELS defaults with caller overrides. Caller must supply
 * a callback_url; verb + kind + id are required.
 *
 * @param {object} params
 * @param {string} params.verb     - BUTTON_LABELS key
 * @param {string} params.kind     - discriminator
 * @param {string} params.id       - row id
 * @param {string} params.callbackUrl
 * @param {string} [params.label]  - override default label
 * @param {string} [params.style]  - override default style
 * @returns {{button_id:string,label:string,style:string,callback_url:string}}
 */
export function makeButton({ verb, kind, id, callbackUrl, label, style }) {
  const spec = BUTTON_LABELS[String(verb).toLowerCase()];
  if (!spec) {
    throw new Error(`makeButton: verb "${verb}" not in BUTTON_LABELS`);
  }
  return {
    button_id: buttonId(verb, kind, id),
    label: label || spec.label,
    style: style || spec.style,
    callback_url: callbackUrl,
  };
}

/**
 * True if a (label, style) pair matches the canonical entry for a verb.
 * Used by the healer to flag freelanced label/style overrides.
 *
 * @param {string} verb
 * @param {string} label
 * @param {string} style
 * @returns {boolean}
 */
export function isCanonicalLabel(verb, label, style) {
  const spec = BUTTON_LABELS[String(verb).toLowerCase()];
  if (!spec) return false;
  if (label && label !== spec.label) return false;
  if (style && style !== spec.style) return false;
  return true;
}
