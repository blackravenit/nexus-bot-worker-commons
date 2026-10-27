// =============================================================================
// lib/researchShare.js, web-search-grounded watercooler shares
//
// Why this exists: the fleet's ambient watercooler posts were pure
// confabulation. The prompts said "write something you've been listening to"
// with no grounding, so every named show, article, or recommendation was
// invented. When a coworker asked a follow-up ("which podcast is it?") there
// was nothing real behind the post and the bot improvised fake specifics
// (the 2026-07-22 Wren fake-podcast + fake brother-in-law incident).
//
// This helper makes a share REAL:
//   1. Runs one Anthropic Messages call with the server-side web_search tool.
//   2. The model researches the topic and picks ONE genuinely worthwhile item.
//   3. We hard-verify the URL it wants to share actually appeared in the
//      search results (or their citations). A URL the model "remembered" is
//      rejected and the whole share is dropped. No grounded URL, no post.
//
// The returned post names the real item and carries its real link, so any
// follow-up question in chat has substance behind it.
//
// Exports:
//   researchWatercoolerShare(env, opts) -> { post, title, url }
//   collectSearchResultUrls / verifySharedUrl / parseResearchJson (pure, for tests)
// =============================================================================

import { withRetry, isRetryableAnthropicError } from "./retry.js";
import { scrubFleetDashes } from "./sanitize.js";
import { reportUsage } from "./usageReport.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Haiku supports the server-side web_search tool and is the cheapest fit for a
// two-sentence social post. Callers may override via opts.model.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1000;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_SEARCHES = 3;
// Server tool use can return stop_reason "pause_turn" mid-search; the docs say
// to resend the accumulated content to let it continue. Cap the continuations.
const MAX_PAUSE_CONTINUATIONS = 2;
const MAX_POST_CHARS = 420;
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1_000, 5_000, 15_000];

/**
 * Collect every URL that the web_search tool actually returned, from both
 * web_search_tool_result blocks and text-block citations. These are the only
 * URLs a share is allowed to carry.
 *
 * @param {Array} content - Anthropic response content blocks
 * @returns {string[]} URLs seen in real search results
 */
export function collectSearchResultUrls(content) {
  const urls = [];
  for (const block of content || []) {
    if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const item of block.content) {
        if (item?.type === "web_search_result" && typeof item.url === "string") {
          urls.push(item.url);
        }
      }
    }
    if (block?.type === "text" && Array.isArray(block.citations)) {
      for (const cite of block.citations) {
        if (typeof cite?.url === "string") urls.push(cite.url);
      }
    }
  }
  return urls;
}

/**
 * Normalize a URL for grounding comparison: lowercase host, drop trailing
 * slash, ignore hash. Query strings are kept because they can be load-bearing
 * (e.g. video ids).
 *
 * @param {string} raw
 * @returns {string|null} normalized form, or null when unparseable
 */
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return null;
  }
}

/**
 * True when the URL the model wants to share is one it actually saw in the
 * search results. Exact match first, then normalized match.
 *
 * @param {string} url - URL the model returned
 * @param {string[]} resultUrls - URLs collected from real search results
 * @returns {boolean}
 */
export function verifySharedUrl(url, resultUrls) {
  if (typeof url !== "string" || !url) return false;
  if (resultUrls.includes(url)) return true;
  const target = normalizeUrl(url);
  if (!target) return false;
  return resultUrls.some(r => normalizeUrl(r) === target);
}

/**
 * Recover the real result URL behind a near-miss claim. Haiku sometimes garbles
 * a result URL when copying it into the share (observed live: a real article
 * URL with a duplicated syllable appended). When the claimed URL is on the same
 * host as a real result and shares almost its entire normalized prefix, the
 * REAL result URL is returned so the share carries what search actually saw.
 * Anything less similar stays unrecoverable: the caller must refuse.
 *
 * @param {string} claimedUrl - URL the model returned
 * @param {string[]} resultUrls - URLs collected from real search results
 * @returns {string|null} the real result URL, or null when no safe match
 */
export function recoverGroundedUrl(claimedUrl, resultUrls) {
  const claimed = normalizeUrl(claimedUrl);
  if (!claimed) return null;
  let claimedHost;
  try {
    claimedHost = new URL(claimed).host;
  } catch {
    return null;
  }
  let best = null;
  for (const raw of resultUrls) {
    const norm = normalizeUrl(raw);
    if (!norm) continue;
    let host;
    try {
      host = new URL(norm).host;
    } catch {
      continue;
    }
    if (host !== claimedHost) continue;
    let prefixLen = 0;
    const max = Math.min(norm.length, claimed.length);
    while (prefixLen < max && norm[prefixLen] === claimed[prefixLen]) prefixLen++;
    // The shared prefix must cover nearly all of BOTH forms; that means the
    // model reproduced the real URL modulo a small tail garble.
    if (prefixLen >= norm.length * 0.9 && prefixLen >= claimed.length * 0.8) {
      if (!best || prefixLen > best.prefixLen) best = { url: raw, prefixLen };
    }
  }
  return best ? best.url : null;
}

/**
 * Parse the strict-JSON share payload out of the model's final text, tolerating
 * markdown fences and stray prose around the object.
 *
 * @param {string} text - concatenated text blocks from the response
 * @returns {{ title: string, url: string, post: string }}
 */
export function parseResearchJson(text) {
  const cleaned = (text || "").replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("[researchShare] no JSON object in model output");
  }
  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    throw new Error(`[researchShare] share JSON parse failed: ${err.message}`);
  }
  for (const field of ["title", "url", "post"]) {
    if (typeof parsed[field] !== "string" || !parsed[field].trim()) {
      throw new Error(`[researchShare] share JSON missing "${field}"`);
    }
  }
  return { title: parsed.title.trim(), url: parsed.url.trim(), post: parsed.post.trim() };
}

/**
 * Ground every URL in a free-form chat reply against an allowlist of URLs the
 * model actually saw (web_search results + links already present in the
 * conversation). Grounded URLs stay, near-miss garbles are repaired to the
 * real result URL, and anything else (a URL recalled from training data) is
 * stripped. Used by the watercooler chat pipeline's live-lookup path.
 *
 * @param {string} text - candidate reply text
 * @param {string[]} allowedUrls - URLs from search results / conversation
 * @returns {{ text: string, dropped: string[] }} cleaned text + removed URLs
 */
export function groundUrlsInText(text, allowedUrls) {
  const dropped = [];
  if (typeof text !== "string" || !text) return { text: text || "", dropped };
  const urlRe = /https?:\/\/[^\s)\]}"'<>]+/g;
  const cleaned = text.replace(urlRe, (match) => {
    // Trailing sentence punctuation is not part of the URL.
    const trimmed = match.replace(/[.,;:!?]+$/, "");
    const tail = match.slice(trimmed.length);
    if (verifySharedUrl(trimmed, allowedUrls)) return match;
    const recovered = recoverGroundedUrl(trimmed, allowedUrls);
    if (recovered) return recovered + tail;
    dropped.push(trimmed);
    return "";
  });
  return { text: cleaned.replace(/[ \t]{2,}/g, " ").trim(), dropped };
}

/**
 * Build the research system prompt around the caller's persona voice.
 *
 * @param {string} personaPrompt - who is sharing and how they sound
 * @param {string} query - what to research
 * @param {number} maxSearches
 * @returns {string}
 */
function buildSystemPrompt(personaPrompt, query, maxSearches) {
  return [
    "You research ONE real, current, genuinely worthwhile find and write a short casual share about it for a team chat channel.",
    "",
    personaPrompt,
    "",
    "PROCESS:",
    `1. Use the web_search tool (up to ${maxSearches} searches) to find real candidates for: ${query}`,
    "2. Pick the single best item: something a coworker would actually click and get value from. Prefer recent, substantive sources over listicles and press releases.",
    "3. Write the share in the voice above: one or two short sentences on why it is worth a look, naming the item by its REAL name, with the URL at the end.",
    "",
    "HARD RULES:",
    "- The item's name and URL MUST come from your search results verbatim. Never invent, alter, or recall-from-memory a title or URL.",
    "- Never claim personal history or personal consumption of the item (no 'been listening on my commute', no recommendations from invented friends or relatives). You found it and think it is worth sharing; frame it exactly that way.",
    "- Never invent people, quotes, or events. Everything factual in the post must come from the search results.",
    "- No em dashes, no en dashes, no double hyphens as punctuation. No hashtags.",
    `- Keep the post under ${MAX_POST_CHARS} characters including the URL.`,
    "",
    'OUTPUT: after searching, respond with STRICT JSON only, no markdown fences, no commentary before or after:',
    '{"title":"<real title from results>","url":"<url from results>","post":"<final message text including the url>"}',
  ].join("\n");
}

/**
 * POST one Messages request, with transient-failure retry (429/5xx/network).
 *
 * @param {object} env
 * @param {object} body
 * @param {string} surface - AI Gateway dashboard tag
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
async function postMessages(env, body, surface, timeoutMs) {
  const url = env.AI_GATEWAY_ANTHROPIC_URL || API_URL;
  const headers = {
    "x-api-key": env.ANTHROPIC_API_KEY,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };
  if (env.AI_GATEWAY_ANTHROPIC_URL) {
    headers["cf-aig-metadata"] = JSON.stringify({
      bot: env.AI_GATEWAY_BOT || env.WORKER_NAME || "bot",
      surface,
    });
  }
  return withRetry(
    async () => {
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new Error(`[researchShare] fetch failed: ${err.message}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`[researchShare] API error ${res.status}: ${text.slice(0, 400)}`);
      }
      const data = await res.json();
      // The AI Gateway intermittently returns 200 with empty content
      // (reference-ai-gateway-empty-200-flake). Treat as a failure so the
      // caller skips this tick rather than posting nothing.
      if (!Array.isArray(data?.content) || data.content.length === 0) {
        throw new Error("[researchShare] empty 200 response");
      }
      return data;
    },
    {
      attempts: RETRY_ATTEMPTS,
      backoffMs: RETRY_BACKOFF_MS,
      isRetryable: isRetryableAnthropicError,
      onRetry: (err, attempt, delayMs) =>
        console.warn(`[researchShare] transient failure, retry ${attempt} in ${delayMs}ms: ${err.message}`),
    },
  );
}

/**
 * Research a real, link-backed watercooler share in a persona's voice.
 *
 * Throws when research fails, the model returns no usable JSON, or the URL is
 * not grounded in actual search results. Callers should catch, log, and skip
 * the post for that tick; a dropped ambient post is always better than a
 * fabricated one.
 *
 * @param {object} env - Worker env (needs ANTHROPIC_API_KEY)
 * @param {object} opts
 * @param {string} opts.query - what to research, e.g. "a notable recent birding story"
 * @param {string} opts.personaPrompt - who is sharing + voice rules
 * @param {string} [opts.model] - override model (default Haiku)
 * @param {number} [opts.maxSearches] - web_search max_uses (default 3)
 * @param {string} [opts.surface] - AI Gateway tag (default "watercooler")
 * @param {number} [opts.timeoutMs] - per-request timeout (default 90s)
 * @returns {Promise<{ post: string, title: string, url: string }>}
 */
export async function researchWatercoolerShare(env, opts = {}) {
  const { query, personaPrompt } = opts;
  if (!env?.ANTHROPIC_API_KEY) throw new Error("[researchShare] ANTHROPIC_API_KEY is not configured");
  if (!query) throw new Error("[researchShare] opts.query is required");
  if (!personaPrompt) throw new Error("[researchShare] opts.personaPrompt is required");

  const model = opts.model || DEFAULT_MODEL;
  const maxSearches = opts.maxSearches || DEFAULT_MAX_SEARCHES;
  const surface = opts.surface || "watercooler";
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  const baseBody = {
    model,
    max_tokens: MAX_TOKENS,
    thinking: { type: "disabled" },
    system: buildSystemPrompt(personaPrompt, query, maxSearches),
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }],
  };

  const messages = [{ role: "user", content: "Find and write today's share." }];
  let response = await postMessages(env, { ...baseBody, messages }, surface, timeoutMs);
  const allContent = [...response.content];
  const usageAcc = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const accumulateUsage = (usage) => {
    if (!usage) return;
    usageAcc.input_tokens += usage.input_tokens || 0;
    usageAcc.output_tokens += usage.output_tokens || 0;
    usageAcc.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
    usageAcc.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
  };
  accumulateUsage(response.usage);

  // Long searches can pause the turn; feed the partial content back so the
  // server-side tool loop continues where it left off.
  let continuations = 0;
  while (response.stop_reason === "pause_turn" && continuations < MAX_PAUSE_CONTINUATIONS) {
    continuations++;
    messages.push({ role: "assistant", content: response.content });
    response = await postMessages(env, { ...baseBody, messages }, surface, timeoutMs);
    allContent.push(...response.content);
    accumulateUsage(response.usage);
  }

  // Watercooler research was a fleet-wide blind spot in Maxwell's per-bot
  // counts (Sonnet/Haiku + web_search, four bots share this path). Report
  // before parsing so even a dropped ungrounded share still counts its spend.
  reportUsage(env, { usage: usageAcc, model, surface });

  const finalText = (response.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");
  const share = parseResearchJson(finalText);

  const resultUrls = collectSearchResultUrls(allContent);
  if (!verifySharedUrl(share.url, resultUrls)) {
    const recovered = recoverGroundedUrl(share.url, resultUrls);
    if (!recovered) {
      throw new Error(`[researchShare] url not grounded in search results, refusing to share: ${share.url}`);
    }
    console.warn(`[researchShare] recovered garbled url: ${share.url} -> ${recovered}`);
    share.post = share.post.split(share.url).join(recovered);
    share.url = recovered;
  }

  let post = scrubFleetDashes(share.post);
  if (!post.includes(share.url)) post = `${post} ${share.url}`.trim();
  if (post.length > MAX_POST_CHARS + 120) {
    throw new Error(`[researchShare] post too long (${post.length} chars), refusing`);
  }

  return { post, title: scrubFleetDashes(share.title), url: share.url };
}
