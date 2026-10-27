# nexus-bot-worker-commons: SPEC.md

## Why this exists

Tonight (2026-05-11) Robert became the first Nexus chat surface. Porting robert-bot (full SOC tool surface) to robert-worker exposed five template-level bugs that every subsequent Nexus bot port (Dexter, Maxwell, eventually Courtney/Jacob/Moxie/Wren) will hit again unless we extract the patterns.

This library captures those patterns as a single import.
### The bugs this prevents

1. **Tool handler signature drift.** anthropic.js invokes handlers as handler(input, env, ctx). Tonight tools/sentinelone.js defined them as (env, args). Result: env.S1_BASE_URL was undefined, new URL of undefined threw Invalid URL string on every call. The library enforces (input, env, ctx) in SPEC + reference docs; the in-lib tool-use loop calls handlers exactly that way so any per-bot tool module that breaks the convention fails its own tests instead of the shared loop.

2. **Tool loop in ctx.waitUntil.** Nexus dispatches the mention callback with AbortSignal.timeout(8000). The LLM tool-use loop routinely takes 30+ seconds. When Nexus aborts, the CF Workers runtime cancels the entire request context, killing every in-flight await. Robert silently never responded for the entire night until the LLM pipeline moved into ctx.waitUntil with an immediate 202 return. The shared handleChatMessage hardcodes this pattern.

3. **HMAC verification convention.** Nexus signs callbacks with HMAC-SHA256 over the literal string TIMESTAMP.RAW_BODY using the per-bot key. Header X-Nexus-Signature carries sha256=HEX; X-Nexus-Timestamp carries unix seconds; 300s replay window; constant-time compare. Every per-bot reimplementation is one bug away from leaking auth or rejecting valid traffic. lib/callbackSign owns this.

4. **bang-cmd dispatch must run before ambient gate.** Tonight an agent went down the rabbit hole of trying to make leading-bang verbs work in #robert-soc (where Robert has ambient_listen=1) without an @mention prefix. The fix is ordering: parse bang-cmd from the stripped body first; if it matches a known verb dispatch immediately and return. Only fall through to the shouldRespond ambient gate when no bang-cmd matched. The shared handler enforces this ordering.

5. **Duplicated Nexus REST plumbing.** postToNexus, attachButtons, postApprovalCard, processButtonClick, and the HITL D1 round-trip are byte-for-byte identical across robert-worker today and will be in every future per-bot worker. One copy here.

In addition the library captures three pieces of bot infrastructure that are already identical fleet-wide: D1 chat history loader/appender, D1 user-facts memory store, and the Anthropic Messages API tool-use loop with cache_control breakpoints.

## Hard rules (inherited from MEMORY.md)

- ES modules only (this is a CF Workers consumer)
- No em dashes or en dashes anywhere (code, docs, comments)
- No global-scope I/O. Module load must not call fetch, construct Response, set timers, or touch crypto.randomValues. CF Workers reject deploy with error 10021 if module-load IO occurs. Wrap everything in functions called per request.
- Tool handler signature is (input, env, ctx). Always.
- Bot identity convention: bot_<name> (underscore) is the Nexus X-API-Key Worker identity. bot-<name> (hyphen) is the legacy EC2 Discord identity. This library is for the underscore variant only.

## File tree

```
nexus-bot-worker-commons/
  package.json                            type:module, no runtime deps
  .gitignore
  README.md                               10-line consume-this-in-a-new-bot-worker
  SPEC.md                                 this file
  src/
    index.js                              barrel re-export
    handlers/
      handleChatMessage.js                config-driven chat callback entry
    lib/
      anthropic.js                        callAnthropic + callAnthropicWithTools (tool-use loop)
      callbackSign.js                     verifyNexusSignature + timingSafeEqual
      commandParser.js                    parseCommand
      history.js                          loadHistory + appendHistory (D1)
      memory.js                           rememberFact / forgetFact / listFacts / buildFactsBlock
      nexus.js                            postToNexus + attachButtons + sendNexusHeartbeat
      hitl.js                             postApprovalCard + processButtonClick
      triggers.js                         makeShouldRespond factory
  migrations/
    001_chat_history.sql
    002_memory_facts.sql
    003_hitl_pending.sql
```

## API contract: handleChatMessage

The headline function. Per-bot src/index.js shrinks to a route wrapper around it.

### Signature

```javascript
import { handleChatMessage } from "nexus-bot-worker-commons";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/internal/chat-message" && request.method === "POST") {
      return handleChatMessage(request, env, ctx, robertConfig);
    }
    // ... other routes (health, version, button-click, etc.)
  }
};
```

### config object

```
{
  // Required
  botName: string,                   // robert, dexter, maxwell, etc.
                                     // Nexus identity is bot_ + botName.
  persona: {
    systemPrompt: string,            // Full system prompt text.
    displayName: string              // Robert Raven, Dexter Raven, etc.
  },
  tools: {
    definitions: Array<object>,      // Anthropic tool definition objects.
    handlers: {
      // Tool name -> async (input, env, ctx) => string | object
      [name: string]: async (input, env, ctx) => any
    }
  },
  commands: {
    // bang-verb -> async (cmdCtx) => void
    // cmdCtx = { verb, args, reply, user_id, display_name, channel_slug, env }
    // Foundation commands (remember/forget/facts/clear/status) are auto-merged;
    // bot-specific commands override foundation by passing the same verb.
    [verb: string]: async (cmdCtx) => void
  },
  nexusKeyEnvVar: string,            // e.g. ROBERT_NEXUS_KEY
                                     // env[this] holds the HMAC verify secret
                                     // AND the X-API-Key for outbound posts.

  // Optional
  triggers: {
    ambient?: (body, replyTo, lastMsgId) => boolean
                                     // Defaults to a closure that never
                                     // matches. Use makeShouldRespond(botName,
                                     // [aliases]) to wire ambient matching.
  },
  dbBinding: string,                 // default DB
  cacheBinding: string,              // default CACHE
  workerBaseUrlEnvVar: string,       // default WORKER_BASE_URL
                                     // used to construct HITL callback_url
  callbackSecretEnvVar: string,      // default BOTNAME_UPPER + _CALLBACK_SECRET
                                     // used when generating HITL buttons
  actionRegex: RegExp,               // default action XML block regex
  historyMaxTurns: number,           // default 30
  approvalSlug: string,              // default soc-approvals -- override per bot
}
```

### Pipeline (in order)

1. **Read raw body** as text.
2. **Verify HMAC** via verifyNexusSignature(env[nexusKeyEnvVar], rawBody, request.headers). Reject 401 if invalid OR timestamp outside 300s window.
3. **Parse JSON** from raw body. Reject 400 if invalid.
4. **Validate payload shape:** require user_id, body, channel_slug. Reject 400 otherwise.
5. **Strip @mention tokens** to produce userText. Reject 400 if userText is empty.
6. **bang-cmd dispatch (runs BEFORE the ambient gate).**
   Build the foundation cmdCtx and the merged handler map (foundation overrides nothing, bot-specific overrides via config.commands). If userText matches a known verb, dispatch and return 200 immediately. Foundation verbs:
   - remember / forget / facts / clear / status
   These need env + user context so they are built per-request inside the handler.
7. **Ambient gate.** If trigger_type is ambient and config.triggers.ambient is supplied, call it. If it returns false, return 200 with { skipped: true }.
8. **Deferred LLM pipeline.** Return 202 { success: true, queued: true } immediately and run the rest under ctx.waitUntil:
   a. Load history (loadHistory).
   b. Build factsBlock (buildFactsBlock) and append to system prompt.
   c. Call callAnthropicWithTools with config.tools.definitions, config.tools.handlers, and ctx = { user_id, display_name, channel_slug }.
   d. Extract action block via config.actionRegex. If matched and parses, call postApprovalCard and strip the block from visibleResponse.
   e. appendHistory user + assistant turns.
   f. postToNexus(env, channel_slug, visibleResponse) if non-empty.
   Every step inside waitUntil is wrapped in try/catch with console error logging. It has no caller to surface failures to.

### FleetView dispatch

FleetView (fleet.blackravenit.com) posts to the same route with the same per-bot HMAC secret, so the persona, tools, memory, and HITL path are identical. Three optional payload fields select the alternate delivery:

- `source: "fleetview"` (absent or "nexus" keeps the normal channel delivery)
- `reply_webhook` absolute FleetView callback URL
- `thread_id` correlation id echoed back on the reply

In FleetView mode, step 8f is replaced by `deliverFleetViewReply` (lib/fleetviewDelivery.js): the answer is POSTed to `reply_webhook`, signed with `FLEETVIEW_DELIVERY_SECRET` in the same `"<unix-seconds>.<rawBody>"` form so the receiver verifies it with verifyNexusSignature. Answers over 1200 chars, and any turn that staged a HITL card, are also posted to the bot's home channel. If the webhook cannot be reached the answer goes to the home channel regardless, so a finished turn is never lost.

Channel-scoped side effects are suppressed in FleetView mode: no typing frames and no auto-listen KV flag, since `channel_slug` there is the bot's home channel rather than a conversation anyone is watching. `!commands` buffer their ctx.reply output and ship it back on the same webhook. HITL approval cards still go only to the bot's `<bot>-hitl` channel.

Requires `FLEETVIEW_DELIVERY_SECRET` on the bot worker.

### Return values

- 200 { success: true }                      on bang-cmd dispatch
- 200 { success: true, skipped: true }       on ambient miss
- 202 { success: true, queued: true }        on LLM pipeline handoff
- 400                                        bad payload / body parse
- 401                                        HMAC verify failed or timestamp outside window

## API contract: other exports

### lib/anthropic.js

```
callAnthropic(env, systemPrompt, messages, options?) -> Promise<string>
callAnthropicWithTools(env, systemPrompt, messages, tools, handlers, ctx?, options?) -> Promise<string>
```

- handlers[name] is invoked as handler(input, env, ctx). Always.
- Cache breakpoints (ephemeral): system prompt, last tool definition, last message last content block.
- Model resolution: env.CLAUDE_MODEL or claude-opus-4-7.
- Tool loop max 10 iterations; tool errors return tool_result with is_error: true.
- Serialized non-string tool results are JSON.stringified and truncated to 20000 chars.

### lib/callbackSign.js

```
verifyNexusSignature(secret, rawBody, headers, options?) -> Promise<boolean>
timingSafeEqual(a, b) -> boolean
```

- options.replayWindowSec default 300.
- Signing input is the literal string TIMESTAMP + . + RAW_BODY.
- timingSafeEqual is byte-length-equal XOR-accumulator constant time.

### lib/commandParser.js

```
parseCommand(body, knownVerbs?) -> { verb, args } | null
```

- knownVerbs is a Set or Array. When provided, parseCommand returns null unless the verb is in the set.
- When omitted, ANY leading bang-word is parsed and the caller dispatches.

### lib/history.js

```
loadHistory(env, historyKey, options?) -> Promise<Array<{role, content}>>
appendHistory(env, historyKey, role, content, options?) -> Promise<void>
```

- options.dbBinding default DB.
- options.maxTurns default 30.
- history_key format: nexus: + user_id.
- loadHistory returns chronological order (reversed from SELECT).
- Errors are caught and logged; loadHistory returns []; appendHistory swallows.

### lib/memory.js

```
rememberFact(env, userId, text, options?) -> Promise<number|null>
forgetFact(env, userId, text, options?) -> Promise<number>
listFacts(env, userId, options?) -> Promise<Array<{id, text, created_at}>>
buildFactsBlock(env, userId, options?) -> Promise<string>
```

- forgetFact matches by case-insensitive substring (SQL LIKE).
- buildFactsBlock wraps facts in a clearly labeled block ready to concatenate to a system prompt. Empty string when there are no facts.

### lib/nexus.js

```
postToNexus(env, slug, content, options?) -> Promise<object|null>
attachButtons(env, messageId, buttons, options?) -> Promise<Array|null>
sendNexusHeartbeat(env, meta?, options?) -> Promise<void>
```

- options.nexusKeyEnvVar required.
- Content is truncated to 8000 chars defensively.
- attachButtons stamps each button with options.callbackSecret (or env[options.callbackSecretEnvVar]) so Nexus can HMAC-sign the dispatch.
- Returns null on failure. Never throws to caller.

### lib/hitl.js

```
postApprovalCard(env, params, options?) -> Promise<string>
processButtonClick(env, payload, options?) -> Promise<{handled, action, pending}>
```

- params supports two call shapes:
  - Chat HITL: { action, channelSlug, requesterUserId, summary }
  - Legacy cron: { incidentId, operation, description, risk, actionParams, reversible }
- options.approvalSlug required.
- Button IDs: hitl-approve:<msgId> and hitl-deny:<msgId>.
- D1 hitl_pending row inserted on post, updated on resolution.
- processButtonClick returns handled: false for non-hitl button IDs so the caller per-bot legacy button code can fall through.

### lib/triggers.js

```
makeShouldRespond(botName, aliases) -> (body, replyTo, lastMsgId) => boolean
```

- Per-bot factory.
- Match patterns:
  - body contains an @-alias (case-insensitive, word-boundary)
  - body contains botName + colon at start or after whitespace
  - body starts with botName + space (case-insensitive)
  - replyTo === lastMsgId (when both non-null)

## robert-worker migration plan

### Files DELETED in robert-worker after consuming this library

- src/handlers/chatMessage.js              -> import { handleChatMessage } from nexus-bot-worker-commons
- src/lib/anthropic.js                     -> re-export from lib
- src/lib/history.js                       -> re-export from lib
- src/lib/memory.js                        -> re-export from lib
- src/lib/nexus.js                         -> re-export from lib
- src/lib/hitl.js                          -> re-export from lib
- src/lib/commandParser.js                 -> re-export from lib (with bot-specific knownVerbs Set)
- src/lib/triggers.js                      -> replaced by makeShouldRespond(robert, [rob, bob])
- HMAC verify code in src/handlers/buttonClick.js -> import { verifyNexusSignature } from nexus-bot-worker-commons

That is roughly 800 lines collapsing to a single import line plus the per-bot config object.

### Files KEPT in robert-worker

- src/index.js                             routing entry, now slimmer
- src/personas/robert.js                   SOC system prompt + skills imports
- src/tools/registry.js                    aggregator
- src/tools/sentinelone.js                 SOC tools (after signature fix)
- src/tools/stellar.js, engines.js, commands.js, help.js
- src/jobs/*.js                            cron job logic (out of scope for this library)
- src/handlers/buttonClick.js              uses verifyNexusSignature from lib but the cron-side button dispatch + S1 mitigation hook stays bot-specific
- wrangler.toml                            unchanged bindings; D1 + KV survive
- migrations/                              applied identical SQL; library ships the same SQL so future bots reuse it

### Robert per-bot src/index.js after the migration (sketch)

```javascript
import { handleChatMessage, makeShouldRespond } from "nexus-bot-worker-commons";
import { handleButtonClick } from "./handlers/buttonClick.js";
import { runScheduled } from "./jobs/router.js";
import { ROBERT_SYSTEM_PROMPT } from "./personas/robert.js";
import { allTools, allHandlers, commandHandlers } from "./tools/registry.js";

const robertConfig = {
  botName: "robert",
  persona: { systemPrompt: ROBERT_SYSTEM_PROMPT, displayName: "Robert Raven" },
  tools: { definitions: allTools, handlers: allHandlers },
  commands: commandHandlers,
  nexusKeyEnvVar: "ROBERT_NEXUS_KEY",
  triggers: { ambient: makeShouldRespond("robert", ["rob", "bob"]) },
  approvalSlug: "soc-approvals",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/internal/chat-message") {
      return handleChatMessage(request, env, ctx, robertConfig);
    }
    if (request.method === "POST" && url.pathname === "/api/internal/button-click") {
      return handleButtonClick(request, env, ctx);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), { headers: { "content-type": "application/json" } });
    }
    if (request.method === "GET" && url.pathname === "/version") {
      return new Response(JSON.stringify({ worker: env.WORKER_NAME, commit: env.COMMIT, enabled: env.ROBERT_WORKER_ENABLED === "true" }), { headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  },
  async scheduled(event, env, ctx) {
    if (env.ROBERT_WORKER_ENABLED !== "true") return;
    ctx.waitUntil(runScheduled(event, env, ctx));
  }
};
```

That is roughly 30 lines that replaces the current 200+ lines of bespoke wiring across handlers/, lib/, and src/index.js.

## Wiring approach (no npm publish)

This is local-only. Each bot worker consumes via the npm file: protocol pointing at the sibling checkout.

### Install per bot

```powershell
cd C:\Users\tragi\bots\<bot>-worker
npm install file:../nexus-bot-worker-commons
```

That writes `nexus-bot-worker-commons: file:../nexus-bot-worker-commons` to the per-bot package.json. npm hard-links the source so edits to the library are picked up on next bundle without reinstall (wrangler watches node_modules transitively).

### Wrangler bundling

Workers bundler (esbuild) handles the file: dep transparently. Nothing extra in wrangler.toml.

### CI

Each bot deploy script needs to npm install before wrangler deploy. The shared lib repo lives next to the consumers on the laptop; no GitHub Actions wiring is needed for local-only consumption. If we ever promote to a private npm registry we add publishConfig.registry to package.json and bump versions; until then file: is fine.

### Migration sequencing

1. Land this empty scaffold + SPEC.md (this commit).
2. Implementation agent fills in src/lib + src/handlers per SPEC.
3. Tests pass against an in-process Worker harness (node --test against the exported pure functions; handleChatMessage gets an integration test with a stubbed env).
4. Robert is the first consumer:
   - cd robert-worker
   - npm install file:../nexus-bot-worker-commons
   - Refactor src/index.js per the sketch above
   - Delete the now-duplicated lib/ + handlers/chatMessage.js files
   - Fix tools/sentinelone.js handler signatures to (input, env, ctx)
   - npx wrangler deploy
   - Smoke test in #robert-soc with @robert plus bang-cmds
5. Repeat for dexter, maxwell, courtney, jacob, moxie, wren, each port becomes a config object plus tool/persona files.

## Acceptance criteria

The implementation agent is done when ALL of these hold:

- [ ] src/lib/anthropic.js implements callAnthropic + callAnthropicWithTools matching the reference behavior in robert-worker/src/lib/anthropic.js (handler called as (input, env, ctx), cache breakpoints in three places, 10-iteration cap, is_error flag on tool failures, 20000-char serialization cap).
- [ ] src/lib/callbackSign.js implements verifyNexusSignature + timingSafeEqual with the 300s replay window default. Constant-time compare.
- [ ] src/lib/commandParser.js parses leading-bang verbs. Honors knownVerbs when supplied.
- [ ] src/lib/history.js loads + appends to chat_history with options.dbBinding override. Errors logged and swallowed.
- [ ] src/lib/memory.js implements rememberFact, forgetFact, listFacts, buildFactsBlock matching robert-worker/src/lib/memory.js semantics.
- [ ] src/lib/nexus.js implements postToNexus, attachButtons, sendNexusHeartbeat. Returns null on failure. Stamps callback_secret onto buttons.
- [ ] src/lib/hitl.js implements both call shapes of postApprovalCard and processButtonClick. options.approvalSlug required.
- [ ] src/lib/triggers.js exports makeShouldRespond factory. Patterns documented above.
- [ ] src/handlers/handleChatMessage.js orchestrates the full pipeline in the exact order documented in Pipeline (in order) above. bang-cmd dispatch runs BEFORE the ambient gate. LLM loop runs inside ctx.waitUntil with the inbound response 202 returned immediately.
- [ ] No module-load IO anywhere. grep for fetch, new Response, setTimeout, crypto.subtle, crypto.randomValues at top level returns nothing outside function bodies.
- [ ] No em dashes or en dashes anywhere in the repo (code, comments, SPEC, README).
- [ ] All tool handler call sites use (input, env, ctx) ordering.
- [ ] node --test test/ passes (unit tests for parseCommand, timingSafeEqual, verifyNexusSignature with crafted bodies, makeShouldRespond pattern matrix).
- [ ] robert-worker successfully npm install file:../nexus-bot-worker-commons and deploys with the slim src/index.js sketch above replacing the current handlers/ + lib/ files. Smoke test in #robert-soc: @robert with a SOC question returns a response, a bang-cmd dispatches before the ambient gate, an action block triggers a HITL card in #soc-approvals.

## Risks

- **Robert tools/sentinelone.js handler signatures still on the old (env, args) order.** Library cannot save the consumer if their per-bot handlers do not match the contract. Mitigation: SPEC documents the convention; robert migration step explicitly includes fix sentinelone.js handler signatures before deploy; test harness exercises a sample tool handler through the loop so a signature drift surfaces as a failing test in the per-bot repo.
- **CF Workers global-scope IO.** A library that constructs Response at module load would brick every consumer. Mitigation: SPEC hard rule; implementation agent runs a wrangler dev smoke after each module lands to catch error 10021 early.
- **File: dep cache.** npm install file:.. sometimes copies rather than symlinks on Windows; library edits do not propagate until reinstall. Mitigation: document npm install file:../nexus-bot-worker-commons --force in README for refresh.
- **Migration scope creep.** Robert cron jobs and per-bot button-click HITL flow are bot-specific and NOT in this library. Implementation agent must not pull them in.

## Open questions

- Should the library ship a handleButtonClick for the cron-side incidentId flow too, or keep that bot-specific? Today only Robert has it; tabling.
- Should parseCommand be the place that hard-codes foundation verbs (remember/forget/facts/clear/status), or should each bot pass them in? Spec answer: each bot passes its full verbs in via knownVerbs; handleChatMessage internally adds the foundation verbs to that set. This keeps parseCommand pure.
- Should the library expose a handleHealth / handleVersion so per-bot src/index.js is even slimmer? Probably yes in a future v0.2; not in v0.1 to keep the surface focused.

