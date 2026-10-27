# Fleet Relay Design (PROPOSAL, not built)

Status: awaiting Brian's approval. Nothing in this document is implemented
except the two hand-rolled relays that already exist (`message_dexter` in
robert-worker, `message_jacob` + `notify_brian` in wren-worker).

Goal: let the bots hand work to each other like a team, without a relay ever
becoming a way to launder authority into a system that writes money, security
posture, or infrastructure.

## The actual risk, stated plainly

A relay is not "one bot calling another bot's API". It is one bot posting a
message that a second bot then acts on under ITS OWN credentials and ITS OWN
tool set. That is the whole exposure in one sentence:

> Wren has no CRM write access. Wren asked Jacob. A CRM record was written.

That already happened on 2026-08-09 and it was the desired outcome, because a
prospect row is cheap and reversible. The same shape pointed at Maxwell reads:
Wren has no Xero access, Wren asks Maxwell, an invoice is raised. Pointed at
Robert: any bot can ask for an endpoint to be isolated. Neither is acceptable
on a bot's say-so, and neither is prevented by anything in the current code.

Today the ONLY thing standing between those two sentences is that the grant
rows do not exist yet. That is not a control, it is an accident of rollout.

## Design: three gates, each one independently sufficient to stop a bad relay

### Gate 1: routing allowlist (who may be spoken to at all)

A single directed map in commons, next to `FLEET_CAPABILITY_MAP.md`, is the
only source of truth for legal relay edges. Not a mesh, not derived from
grants, not inferable by a model at runtime.

Per Brian (2026-08-09) the graph is near-complete rather than curated, with two
bots write-only and one bot out entirely:

    const OPEN = ["wren", "courtney", "dexter", "jacob", "kate", "moxie"];

    FLEET_RELAY_ROUTES = {
      // Send to anyone but each other. Nothing may relay INTO either of them.
      maxwell:  [...OPEN, "robert"].filter(b => b !== "robert"),  // 6
      robert:   [...OPEN, "maxwell"].filter(b => b !== "maxwell"), // 6
      // Everyone else: anyone except self, maxwell, robert.
      wren:     OPEN.filter(b => b !== "wren"),     // 5
      courtney: OPEN.filter(b => b !== "courtney"), // 5
      dexter:   OPEN.filter(b => b !== "dexter"),   // 5
      jacob:    OPEN.filter(b => b !== "jacob"),    // 5
      kate:     OPEN.filter(b => b !== "kate"),     // 5
      moxie:    OPEN.filter(b => b !== "moxie"),    // 5
      flynn:    [],                                  // out of the fleet relay
    }

42 directed edges. Flynn is excluded on both sides: he is a mentor persona in
#flynn-lab, not fleet staff.

**Maxwell and Robert never appear on the right-hand side, including each
other's.** They can ORIGINATE a relay; nothing can relay INTO them. Maxwell is
the only bot with Xero write. Robert holds S1 isolate/remediate and Stellar
Cyber case close. Per Brian (2026-08-09): if the gate on financial data is not
airtight, do not allow the conversation at all. Same reasoning extends to
Robert's security writes. Excluding the maxwell<->robert pair also removes the
only possible two-node relay loop.

Anything not on this map is refused in code with a message that names the
human path: "I cannot hand this to Maxwell. Ask him directly in #maxwell-finance."

### Gate 1b: #watercooler is not a relay surface

The `watercooler` channel is personal and social. It has its own ambient
pipeline (`commons/src/lib/watercooler.js`, per-bot `jobs/watercooler*.js`) and
its own provenance handling (it is in the UI's `PROVENANCE_HIDDEN_CHANNELS`).
Per Brian (2026-08-09) fleet relay must stay out of it, in both directions:

1. `watercooler` is never a legal relay TARGET. Relays land in the target bot's
   home channel, never there.
2. A turn whose `ctx.channel_slug` is `watercooler` may not ORIGINATE a relay.
   The relay tool is not offered in that channel and refuses if called anyway.
   Social chatter must not be able to dispatch work.

Without rule 2, forty-two edges plus nine ambient watercooler crons is a fleet
that assigns itself work while making small talk.

### Gate 2: authority downgrade (what a bot-originated request may trigger)

The Nexus callback already carries the author: `user_id` is `bot_wren` for a
relay and a real UUID for a human. Commons stamps `ctx.requester_is_bot` from
it, and the receiving bot's tool loop enforces a per-bot ALLOWLIST of tools
reachable by a bot-originated request. Default deny. Unlisted tool = refused,
with the refusal telling the requester to have a human ask.

    RELAY_TOOL_POLICY = {
      jacob:    ["crm_add_prospect", "crm_update_prospect", "crm_find_contact", ...reads],
      courtney: ["desk_create_ticket", ...kb + desk reads],
      dexter:   [...reads only],
      kate:     [...reads only],
      wren:     ["calendar_create_event", "calendar_create_teams_meeting", ...calendar reads],
      moxie:    [...reads only],
      // maxwell, robert: no policy entry. They are unreachable by Gate 1.
    }

Wren's entry was reads-only until 2026-08-16, when Brian widened it after a
Jacob relay ("get a call with this new contact on Brian's calendar") had nowhere
to land. The line is at ADDING: another bot may put something on the calendar,
and may read enough of it to pick a slot. It may not move, cancel, or RSVP to a
meeting that already exists, and her mailbox stays human-only. `RELAY_INPUT_SCRUB`
strips `override_conflict` from a relayed booking, so the cross-calendar
double-booking guard cannot be waived by a request no human phrased.

With the near-complete graph every open bot is now a RECEIVER, so this policy
must exist for all six of them, not just the four that had inbound edges under
the curated map. Writing these six allowlists is the real work of this project;
the ~42 `bot_channel_permissions` rows are trivial by comparison.

Note what this buys beyond Gate 1: even on a legal edge, Wren cannot talk
Jacob into sending cold outbound or editing an agreement. She can add and
update a prospect. That is the entire surface.

Recommended hardening (small nexus-app change): add an explicit
`author_is_bot` boolean to the mention callback payload instead of having every
bot infer it from a `bot_` id prefix. Inferring works today; an explicit flag
means a future id scheme change cannot silently re-authorize every relay.

### Gate 3: human provenance and hop limit (who may start one, and how far it goes)

1. **A relay may only originate inside a HUMAN turn.** No cron job, no poller,
   no webhook may relay. This is what keeps the fleet from talking to itself
   at 3am on your token budget.
2. **Hop limit 1.** A bot-originated request may not itself originate a relay.
   Wren -> Jacob is legal. Jacob -> Dexter as a downstream consequence is
   refused. No chains, no telephone game, no diffusion of responsibility.
3. **The requesting human is carried in the envelope** and rendered in the
   post: "requested by Brian Yelm". A relay that cannot name its human is
   refused. This is the audit trail when someone asks why a record changed.

Nexus already enforces a fourth backstop underneath all of this: a bot-to-bot
mention budget of 8 per channel per 10 minutes, fail-closed on a count error
(`message-insert.js`). It stays.

## Truthfulness rules (the part that is prose, not code)

`FLEET_CAPABILITY_MAP.md` rule 3 currently says there is no bot-to-bot handoff.
It gets rewritten, and the replacement is narrower than people will expect:

- A relay POSTS A REQUEST. It does not complete work. A bot may say "I asked
  Jacob to add him, in #jacob-sales" and may NEVER say "it is added" until it
  has read the reply.
- Before reporting on a handoff, READ the target channel. The requester holds
  the grant, so it can (this is already Wren's `read_channel_history` pattern).
- Never promise to notify a human you cannot reach from where you are standing.
  That needs `notify_brian` or its per-bot equivalent, called in the same turn.
  This is the exact failure from 2026-08-09.

## Implementation shape

One shared module, `src/lib/fleetRelay.js` in commons, exporting
`buildFleetRelayTools({ selfBot, homeSlug, nexusKeyEnvVar })` and returning the
tool defs plus handlers. Every bot wires one line in its registry. The two
hand-rolled relays are deleted and re-pointed at the shared primitive so the
routing, the gates, and the loop guard exist in exactly one place.

**One parameterized tool, not one tool per target.** A single
`message_bot({ target, message })` whose `target` enum is generated from
`FLEET_RELAY_ROUTES[selfBot]`. Six named relay tools per bot would add 42 tool
definitions across the fleet, bloat every system prompt, and drift.
`notify_brian` stays separate: it is a human-notification path, not a relay.

Per-bot Nexus work: a `bot_channel_permissions` grant per legal edge, 42 rows
versus 72 for a full mesh.

## Open question for Brian

Gate 1 excludes Maxwell and Robert as targets entirely. Gate 2 would let us
allow a NARROW read-only edge into them later (for example, Courtney asking
Maxwell "is this client's invoice paid?" with zero write tools reachable). That
is strictly safer than the Jacob edge we already run, but it is still a bot
touching the money bot, so it stays off until explicitly asked for.
