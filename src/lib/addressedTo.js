// =============================================================================
// addressedTo.js, "is this email actually addressed to me, or am I a bystander
// on someone else's conversation?"
//
// A sender filter is not an addressing filter. A bot that auto-replies to every
// message from a trusted sender will barge into threads where it was merely
// copied. 2026-08-17: Brian asked his payroll provider a question on a thread
// with four people on it, and Maxwell answered it as though he had been asked,
// telling Brian to go ask the provider that Brian was already talking to.
//
// The gate is deliberately strict: reply only when the bot is the SOLE To
// recipient and nobody is copied. A group thread is a conversation between
// humans until someone addresses the bot alone. Courtney has run this exact
// gate since 2026-05-18; this is that rule, lifted to commons so every bot gets
// it instead of each one rediscovering it.
// =============================================================================

// A forward is someone routing material for reference, not opening a dialogue.
const FORWARD_SUBJECT_RE = /^\s*(fw|fwd)\s*:/i;

/**
 * Lowercased address of a Graph recipient entry.
 * @param {{emailAddress?: {address?: string}}} recipient
 * @returns {string}
 */
function addressOf(recipient) {
  return String(recipient?.emailAddress?.address || "").trim().toLowerCase();
}

/**
 * Decide whether a Graph message is addressed to this mailbox directly enough
 * to warrant an automatic reply.
 *
 * Fails OPEN when Graph did not return recipient data at all (the fields are
 * absent from $select), because silently muting a bot is worse than the
 * occasional unwanted reply. Callers that care should add toRecipients and
 * ccRecipients to their $select rather than rely on this fallback.
 *
 * @param {object} msg - Graph message (needs toRecipients, ccRecipients, subject)
 * @param {string} selfAddress - this bot's mailbox address
 * @returns {{direct: boolean, reason: string}} reason is a short log-friendly tag
 */
export function isAddressedDirectly(msg, selfAddress) {
  const self = String(selfAddress || "").trim().toLowerCase();
  if (!self) return { direct: true, reason: "no-self-address" };

  if (FORWARD_SUBJECT_RE.test(String(msg?.subject || ""))) {
    return { direct: false, reason: "forward" };
  }

  // Undefined means "never asked Graph for it". An empty array is a real answer.
  if (!Array.isArray(msg?.toRecipients)) {
    return { direct: true, reason: "recipients-unavailable" };
  }

  const to = msg.toRecipients.map(addressOf).filter(Boolean);
  if (!to.includes(self)) return { direct: false, reason: "not-a-to-recipient" };
  if (to.length > 1) return { direct: false, reason: `group-thread-${to.length}-to` };

  const cc = (Array.isArray(msg?.ccRecipients) ? msg.ccRecipients : []).map(addressOf).filter(Boolean);
  // Being copied on your own thread is fine; anyone ELSE copied makes it a group.
  const othersCopied = cc.filter((a) => a !== self);
  if (othersCopied.length > 0) return { direct: false, reason: `group-thread-${othersCopied.length}-cc` };

  return { direct: true, reason: "sole-recipient" };
}
