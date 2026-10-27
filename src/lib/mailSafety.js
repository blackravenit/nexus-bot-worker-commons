// =============================================================================
// lib/mailSafety.js - Shared inbound-email "do not reply to a machine" gate.
//
// Bots must never draft or send a reply to an automatic message: out-of-office
// / vacation auto-replies, bounce/NDR notifications, and no-reply system
// senders. Replying to one is pointless at best and, with a vacation responder
// on the other end, can start an auto-reply ping-pong loop. (Courtney drafted a
// reply to a Sesotec out-of-office bounce-back of the quarterly check-in on
// 2026-06-05; Brian: "program all bots in the fleet to not respond to automatic
// replies.")
//
// isAutomaticReply() layers three independent signals so it works whether or
// not a poller fetched raw headers:
//   1. RFC 3834 + Microsoft auto-response headers (most reliable when present).
//   2. Subject heuristics (Outlook always prefixes OOO with "Automatic reply:";
//      common non-English locales included).
//   3. Sender heuristics (no-reply@ / mailer-daemon@ / postmaster@, replying
//      to these is always wrong).
//
// One source of truth so every bot's mail poller enforces the same gate.
// =============================================================================

// Subject prefixes set by auto-responders. Anchored near the start (after an
// optional Re:/Fwd:) so a human writing "out of office" mid-sentence in a real
// subject is not falsely suppressed.
const AUTO_SUBJECT_RE =
  /^\s*(?:(?:re|fwd?|aw|sv)\s*:\s*)*(automatic reply|auto[\s-]?reply|autoreply|out of (?:the )?office|out-of-office|\booo\b|away from (?:the )?office|on vacation|on holiday|abwesenheit(?:snotiz)?|automatische antwort|r[ée]ponse automatique|absence du bureau|respuesta autom[áa]tica|autorespuesta|risposta automatica|automatisch antwoord|fr[åa]nvaro|autosvar)\b/i;

// Unambiguous machine-mail phrases matched ANYWHERE in the subject, not just at
// the start. AP-intake / capture systems put their own label first, so the
// anchored rule above misses them, e.g. Concur's "Concur Auto Reply Invoice
// INV-0419 ..." which looped Maxwell into replying to a no-reply bot
// (2026-06-25). These phrases are machine-only enough to be safe unanchored;
// not replying is the safe failure mode anyway.
const AUTO_SUBJECT_ANYWHERE_RE =
  /\b(?:auto[\s-]?reply|automatic reply|automated (?:reply|response|message|notification|email)|do[\s-]?not[\s-]?reply|invoice capture)\b/i;

// System senders it is never correct to reply to. Each token may carry a
// suffix before the @ (e.g. "noreply-dmarc-support@google.com",
// "noreply-dmarc@sicher.web.de"): Google's DMARC rua sender slipped the old
// anchored-at-@ form and Robert drafted replies to report robots (2026-07-23).
const NOREPLY_SENDER_RE =
  /^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounce[sd]?|mail-?delivery|microsoftexchange[\w-]*|invoice-?capture|auto-?reply|autoreply|autonotification|automated|notifications?|dmarc-?reports?)(?:[._+-][\w.+-]*)?@/i;

// DMARC aggregate (rua) report mail. RFC 7489 fixes the subject convention
// "Report Domain: <domain> Submitter: <org> Report-ID: <id>"; some reporters
// prefix a bracketed tag (Microsoft uses "[Preview]"). Senders vary wildly
// (dmarcreport@microsoft.com has no no-reply marker at all), so match the
// subject shape too. These are machine reports, never conversations.
const DMARC_REPORT_SUBJECT_RE =
  /^\s*(?:\[[^\]]{0,40}\]\s*)*report domain\s*:/i;

// Domains whose mail is system-generated end to end (AP-intake / expense-capture
// acknowledgements). We never hold a human conversation with these, so never
// auto-reply, replying loops with their bot. Concur invoice-capture
// (concursolutions.com) is the first member; add new AP-intake systems here.
const AUTO_SENDER_DOMAIN_RE =
  /@(?:[\w-]+\.)*(?:concursolutions\.com|concur\.com)$/i;

/**
 * Normalize Graph internetMessageHeaders (array of {name,value}) or a plain
 * header map into a lowercased-key lookup object.
 * @param {Array|object|undefined} h
 * @returns {Record<string,string>}
 */
function normalizeHeaders(h) {
  const out = {};
  if (!h) return out;
  if (Array.isArray(h)) {
    for (const item of h) {
      if (item && item.name != null) out[String(item.name).toLowerCase()] = String(item.value ?? "");
    }
  } else if (typeof h === "object") {
    for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = String(v ?? "");
  }
  return out;
}

/**
 * Pull a bare email address out of a Graph from object, a "Name <addr>" string,
 * or a raw address.
 * @param {object|string|undefined} from
 * @returns {string}
 */
function extractAddress(from) {
  if (!from) return "";
  if (typeof from === "object") {
    const addr = from.emailAddress?.address || from.address || from.email || "";
    return String(addr).trim().toLowerCase();
  }
  const m = /<([^>]+)>/.exec(String(from));
  return (m ? m[1] : String(from)).trim().toLowerCase();
}

/**
 * Decide whether an inbound email is an automatic message a bot must not reply
 * to. Degrades gracefully: headers are best, but subject + sender alone still
 * catch Outlook out-of-office replies even when a poller did not fetch headers.
 *
 * @param {object} email
 * @param {string} [email.subject]
 * @param {object|string} [email.from]               Graph from object or address string
 * @param {Array|object} [email.headers]             header array/map
 * @param {Array} [email.internetMessageHeaders]     Graph headers (alternative field)
 * @returns {{ isAuto: boolean, reason: string }}
 */
export function isAutomaticReply(email = {}) {
  const reasons = [];
  const headers = normalizeHeaders(email.headers || email.internetMessageHeaders);
  const get = (name) => headers[name.toLowerCase()] || "";

  // RFC 3834: any value other than "no" marks machine-generated mail.
  const autoSubmitted = get("auto-submitted").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") reasons.push(`auto-submitted=${autoSubmitted}`);

  // Microsoft loop-suppression header is stamped on OOF / auto replies.
  if (get("x-auto-response-suppress")) reasons.push("x-auto-response-suppress");
  if (get("x-ms-exchange-inbox-rules-loop")) reasons.push("exchange-oof-loop");

  // Legacy autoresponder markers.
  if (/^(yes|true|1)/i.test(get("x-autoreply"))) reasons.push("x-autoreply");
  if (get("x-autorespond")) reasons.push("x-autorespond");
  if (get("x-autogenerated")) reasons.push("x-autogenerated");

  // Precedence: bulk / auto_reply / list / junk are non-personal mail classes.
  const precedence = get("precedence").toLowerCase();
  if (/\b(bulk|auto_reply|auto-reply|list|junk)\b/.test(precedence)) reasons.push(`precedence=${precedence}`);

  // Subject heuristic (covers Outlook OOO + common locales).
  const subject = String(email.subject || "");
  if (AUTO_SUBJECT_RE.test(subject)) reasons.push("subject");
  else if (AUTO_SUBJECT_ANYWHERE_RE.test(subject)) reasons.push("subject-anywhere");

  // DMARC rua report subject shape.
  if (DMARC_REPORT_SUBJECT_RE.test(subject)) reasons.push("dmarc-report");

  // System sender heuristic (no-reply local-part, or a known AP-intake domain).
  const from = extractAddress(email.from || email.fromAddress || email.sender);
  if (from && NOREPLY_SENDER_RE.test(from)) reasons.push(`sender=${from}`);
  else if (from && AUTO_SENDER_DOMAIN_RE.test(from)) reasons.push(`auto-domain=${from}`);

  return { isAuto: reasons.length > 0, reason: reasons.join(",") };
}
