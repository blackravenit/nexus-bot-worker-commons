// =============================================================================
// lib/usageReport.js. Fleet-wide per-bot Anthropic usage attribution.
//
// Maxwell aggregates fleet Anthropic spend at USAGE_REPORT_URL
// (maxwell-worker /api/internal/usage-report). Until 2026-08-03 only the
// commons chat path and jacob's cron drafters reported, so most cron spend
// was invisible in maxwell-state.api_usage. This helper is the single shared
// reporter: commons callAnthropic/callAnthropicWithTools self-report through
// it by default, and per-bot raw-fetch funnels call it explicitly.
//
// Fire-and-forget by design (mirrors handleChatMessage): never await, never
// throw into the caller's path. A failed report must not break a job.
//
// 2026-09-16: a worker's SCHEDULED (cron) invocation cannot fetch another
// same-account *.workers.dev worker by public hostname; Cloudflare returns
// HTTP 404 "error code: 1042" and the .catch(() => {}) here swallowed it, so
// every cron's usage vanished silently (robert: 2 reported rows vs 1745 real
// triage reviews in 30 days). The public URL only ever worked from request
// (HTTP) invocations, which is why chat/voice rows existed. Fix: prefer a
// service binding (routes worker-to-worker regardless of invocation type)
// and fall back to the public URL only when no binding is configured.
// =============================================================================

const USAGE_REPORT_INTERNAL_URL = "https://maxwell.internal/api/internal/usage-report";

/**
 * Report one Anthropic call's token usage to Maxwell's intake endpoint.
 * No-ops silently when usage/model are missing or no destination is configured.
 *
 * Prefers a Cloudflare service binding to maxwell-worker (`env.MAXWELL_USAGE`,
 * falling back to `env.MAXWELL` if the worker already binds it for something
 * else) so the call works from cron/scheduled invocations, which cannot
 * subrequest a same-account workers.dev hostname (CF error 1042). Falls back
 * to `env.USAGE_REPORT_URL` when neither binding is present.
 *
 * @param {object} env - Worker env. Reads MAXWELL_USAGE / MAXWELL service
 *   bindings, USAGE_REPORT_URL (fallback) + NEXUS_INTERNAL_TOKEN, and
 *   AI_GATEWAY_BOT / WORKER_NAME for the default bot name.
 * @param {object} args
 * @param {object} args.usage - The usage block from the Anthropic response.
 * @param {string} args.model - The model id actually sent to Anthropic.
 * @param {string} [args.surface] - Call-site label (e.g. "email-poller").
 * @param {string} [args.bot] - Bot name override; defaults to env.AI_GATEWAY_BOT.
 * @param {string|null} [args.channelSlug] - Optional Nexus channel context.
 * @returns {Promise<void>|undefined} The in-flight report promise (for tests
 *   that want to await it); callers should treat this as fire-and-forget.
 */
export function reportUsage(env, { usage, model, surface, bot, channelSlug = null }) {
  if (!usage || !model) return;

  const usageBinding = env?.MAXWELL_USAGE || env?.MAXWELL;
  const destinationUrl = usageBinding ? USAGE_REPORT_INTERNAL_URL : env?.USAGE_REPORT_URL;
  if (!destinationUrl) return;

  const doFetch = usageBinding ? usageBinding.fetch.bind(usageBinding) : fetch;

  const botName =
    bot || env.AI_GATEWAY_BOT || String(env.WORKER_NAME || "bot").replace(/-worker$/, "");

  return doFetch(destinationUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": env.NEXUS_INTERNAL_TOKEN || "",
    },
    body: JSON.stringify({
      bot: botName,
      model,
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
      channel_slug: channelSlug,
      surface: surface || "cron",
      ts: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(5000),
  })
    .then((res) => {
      if (!res.ok && res.status !== 202) {
        console.warn(
          `[usageReport] intake rejected for bot ${botName} (surface ${surface || "cron"}): HTTP ${res.status}`
        );
      }
    })
    .catch((err) => {
      console.warn(
        `[usageReport] post failed for bot ${botName} (surface ${surface || "cron"}): ${err?.message || String(err)}`
      );
    });
}
