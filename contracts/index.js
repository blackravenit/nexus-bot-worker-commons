// =============================================================================
// contracts/index.js, barrel for the versioned Nexus <-> bot wire contract.
//
// Import surface for all three repos:
//   - maxwell-worker (Vitest):     import { ..., fixtures } from "nexus-bot-worker-commons/contracts"
//   - commons (node:test):         import { ... } from "../contracts/index.js"
//   - nexus-app/sim (node, ESM):   import { ... } from "../../nexus-bot-worker-commons/contracts/index.js"
//
// Sign fixtures at test time with signCallback from
// "nexus-bot-worker-commons/lib/callbackSign", never commit a pre-signed body.
// =============================================================================

export {
  CONTRACT_VERSION,
  VALIDATORS,
  validateChatMessage,
  validateButtonClick,
  validateModalSubmit,
  validateModalDefinition,
} from "./nexus-callbacks.js";

import { chatMessageFixture } from "./fixtures/chat-message.js";
import { buttonClickFixture } from "./fixtures/button-click.js";
import { modalSubmitFixture } from "./fixtures/modal-submit.js";
import { modalDefinitionFixture } from "./fixtures/modal-definition.js";

export { chatMessageFixture, buttonClickFixture, modalSubmitFixture, modalDefinitionFixture };

/** Valid fixtures keyed by callback type, for table-driven tests. */
export const fixtures = {
  "chat-message": chatMessageFixture,
  "button-click": buttonClickFixture,
  "modal-submit": modalSubmitFixture,
};
