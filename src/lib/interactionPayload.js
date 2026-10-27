// =============================================================================
// lib/interactionPayload.js, canonical parser for inbound Nexus
// button-click and modal-submit callbacks.
//
// Nexus sends two callback shapes:
//
//   Button click:  { message_id, button_id, user_id, display_name, timestamp }
//   Modal submit:  { message_id, modal_id,  user_id, display_name,
//                    values: {...} | fields: {...},  timestamp }
//
// Historically a few bots read modal payloads as `payload.fields` while
// others used `payload.values`. The Nexus server emits `values`, so the
// `fields` readers silently no-op'd. This helper accepts either, returns
// a canonical shape, and records which shape arrived so the QA telemetry
// can drive the deprecation of `fields` callers.
//
// Returned shape (all fields always present, normalized types):
//   {
//     messageId: string,
//     buttonId:  string | null,
//     modalId:   string | null,
//     userId:    string,
//     displayName: string,
//     values:    Record<string,string>,   // {} when none
//     timestamp: number,                  // unix ms
//     payloadShape: "values" | "fields" | "none",
//   }
// =============================================================================

/**
 * Normalize a Nexus button-click or modal-submit callback payload.
 *
 * Never throws on malformed shapes, missing fields become empty strings
 * or null so handler code can branch without try/catch.
 *
 * @param {any} raw
 * @returns {{
 *   messageId: string,
 *   buttonId:  string | null,
 *   modalId:   string | null,
 *   userId:    string,
 *   displayName: string,
 *   values:    Record<string,string>,
 *   timestamp: number,
 *   payloadShape: "values" | "fields" | "none",
 * }}
 */
export function parseInteractionPayload(raw) {
  const p = raw && typeof raw === "object" ? raw : {};

  let values = {};
  let payloadShape = "none";
  if (p.values && typeof p.values === "object" && !Array.isArray(p.values)) {
    values = _coerceStrings(p.values);
    payloadShape = "values";
  } else if (p.fields && typeof p.fields === "object" && !Array.isArray(p.fields)) {
    values = _coerceStrings(p.fields);
    payloadShape = "fields";
  }

  const timestamp = _coerceTimestamp(p.timestamp);

  return {
    messageId:   _str(p.message_id),
    buttonId:    p.button_id ? _str(p.button_id) : null,
    modalId:     p.modal_id  ? _str(p.modal_id)  : null,
    userId:      _str(p.user_id),
    displayName: _str(p.display_name),
    values,
    timestamp,
    payloadShape,
  };
}

/**
 * Convenience for handler code: true if this payload should be processed
 * through the legacy `fields` path. The healer flags this; new code
 * should rely solely on the returned `values` object.
 *
 * @param {{payloadShape:string}} parsed
 * @returns {boolean}
 */
export function isLegacyFieldsPayload(parsed) {
  return !!parsed && parsed.payloadShape === "fields";
}

function _str(v) {
  return v == null ? "" : String(v);
}

function _coerceStrings(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    out[k] = v == null ? "" : String(v);
  }
  return out;
}

function _coerceTimestamp(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}
