// =============================================================================
// nexus-bot-worker-commons barrel re-export
//
// Public API. Per-bot workers import from this entry point:
//
//   import {
//     handleChatMessage,
//     postToNexus,
//     attachButtons,
//     postApprovalCard,
//     processButtonClick,
//     verifyNexusSignature,
//     parseCommand,
//     loadHistory,
//     appendHistory,
//     rememberFact,
//     forgetFact,
//     listFacts,
//     buildFactsBlock,
//     callAnthropic,
//     callAnthropicWithTools,
//     makeShouldRespond,
//   } from "nexus-bot-worker-commons";
//
// All implementations live under src/lib and src/handlers.
// =============================================================================

export { handleChatMessage, runLlmPipeline, buildFoundationHandlers } from "./handlers/handleChatMessage.js";
export { LlmRoomBase } from "./durable/LlmRoom.js";
export { ReminderDOBase, scheduleReminderAlarm, bootstrapReminderAlarm } from "./durable/ReminderDOBase.js";
export { handleCommandList, FOUNDATION_COMMAND_META } from "./handlers/handleCommandList.js";
export { callAnthropic, callAnthropicWithTools } from "./lib/anthropic.js";
export { withRetry, isRetryableAnthropicError } from "./lib/retry.js";
export { researchWatercoolerShare, collectSearchResultUrls, verifySharedUrl, parseResearchJson, recoverGroundedUrl, groundUrlsInText } from "./lib/researchShare.js";
export { judgeContent, judgeContentWithRedraft, parseJudgeVerdict, buildRetryFeedback, FLEET_RUBRICS, JUDGE_PASS_THRESHOLD, SURFACE_PASS_THRESHOLDS, resolvePassThreshold } from "./lib/contentJudge.js";
export { buildActionBreadcrumb, summarizeToolCall, isReadonlyToolName, looksLikeUnbackedClaim } from "./lib/actionTrace.js";
export { verifyNexusSignature, signCallback, timingSafeEqual } from "./lib/callbackSign.js";
export { verifyTwilioSignature } from "./lib/twilioSig.js";
export { buildVoicePersona, handleVoicePersona } from "./lib/voicePersona.js";
export { parseCommand } from "./lib/commandParser.js";
export { loadHistory, appendHistory } from "./lib/history.js";
export { rememberFact, forgetFact, listFacts, buildFactsBlock } from "./lib/memory.js";
export { resolveEntity, getEntityContext, persistTurnPair, assertFact, getEntityFacts, persistEmailExchange } from "./lib/memoryService.js";
export { buildContactRecall, renderContactRecallLines } from "./lib/memoryRecall.js";
export { rankRecallCandidates, selectRankedRecall, DEFAULT_RECALL_WEIGHTS } from "./lib/memoryRanking.js";
export { buildMemoryRecallBlock } from "./lib/memoryRecallBlock.js";
export { resolveContextBudget, estimateTokens, DEFAULT_CONTEXT_BUDGET } from "./lib/contextBudget.js";
export { buildHistoryFoldBlock } from "./lib/historyFold.js";
export { migrateLegacyFacts, rememberNote, listSharedFacts } from "./lib/memoryNotes.js";
export { stripQuotedReply } from "./lib/emailQuote.js";
export { senderTrust } from "./lib/mailTrust.js";
export { isAutomaticReply } from "./lib/mailSafety.js";
export { renderEmailHeader, renderEmailForPrompt } from "./lib/emailHeader.js";
export { isAddressedDirectly } from "./lib/addressedTo.js";
export { stageExternalReply, handleExternalReplyGate, handleExternalReplyModal, replySubject } from "./lib/externalReplyGate.js";
export { parseGraphResponse } from "./lib/graphJson.js";
export { looksLikeIncomingPayment } from "./lib/incomingPayment.js";
export { memoryHmacHex, buildMemoryAuthHeaders } from "./lib/memoryAuth.js";
export { getAdminNexusUserIds, isFleetAdmin, getPrimaryAdminNexusUserId } from "./lib/fleetAdmins.js";
export { postToNexus, uploadBotAttachment, attachImagesFromUrls, attachButtons, attachSelectMenus, disableMessageButtons, markButtonClicked, settleMessageComponents, settleHitlCard, attachModals, editNexusMessage, fetchChannelMessages, fetchThreadMessages, sendNexusHeartbeat, sendTyping, pingBotPresence } from "./lib/nexus.js";
export { withProvenance, getProvenanceContext } from "./lib/provenanceContext.js";
export {
  buildFleetRelayTools,
  applyRelayToolPolicy,
  fleetRelayPolicyFor,
  isRelayEdgeAllowed,
  relayEdgeCount,
  relayModeSystemNote,
  mirrorRelayReply,
  FLEET_RELAY_ROUTES,
  RELAY_TOOL_POLICY,
  RELAY_INPUT_SCRUB,
  RELAY_FORBIDDEN_TARGETS,
  RELAY_EXCLUDED_CHANNELS,
} from "./lib/fleetRelay.js";
export {
  isFleetViewSource,
  deliverFleetViewReply,
  shouldMirrorToHomeChannel,
  FLEETVIEW_SOURCE,
} from "./lib/fleetviewDelivery.js";
export { applyVoicePronunciation } from "./lib/ttsPronunciation.js";
export { crmReadTools, crmReadHandlers } from "./lib/crmCodes.js";
export {
  kbProfileReadTools, kbProfileReadHandlers,
  kbProfileWriteTools, kbProfileWriteHandlers,
} from "./lib/kbClientProfiles.js";
export {
  scrubFleetDashes,
  detectEmDashLeak,
  detectBareCapsHeader,
  detectFreelanceEmoji,
  inspectOutboundText,
} from "./lib/sanitize.js";
export { reportFleetError } from "./lib/fleetError.js";
export { reportUsage } from "./lib/usageReport.js";
export { createLogger } from "./lib/logger.js";
export { notifyEmailDown, BOT_HOME_CHANNELS } from "./lib/emailBackup.js";
export { postApprovalCard, processButtonClick } from "./lib/hitl.js";
export { postHitlCard, renderHitlCard } from "./lib/hitlCard.js";
export { runSelfReviewLoop, handleSelfReviewLoopClick, recommendationFingerprint } from "./lib/selfReviewLoop.js";
export { handleHitlSettled } from "./handlers/handleHitlSettled.js";
export {
  linkButton,
  linkButtons,
  linkButtonId,
  attachLinkButtons,
  xeroBankAccountUrl,
  xeroBillUrl,
  xeroInvoiceUrl,
  s1ThreatUrl,
  scCaseUrl,
  ninjaDeviceUrl,
  ninjaTicketUrl,
  crmRecordUrl,
  dattoDeviceUrl,
  boxFileUrl,
  cdwProductUrl,
} from "./lib/appLinks.js";
export {
  BUTTON_LABELS,
  buttonId,
  parseButtonId,
  makeButton,
  isCanonicalLabel,
} from "./lib/buttonId.js";
export {
  parseInteractionPayload,
  isLegacyFieldsPayload,
} from "./lib/interactionPayload.js";
export {
  routeApprovalChannel,
  getApprovalChannelRegistry,
} from "./lib/channelRouter.js";
export { makeShouldRespond } from "./lib/triggers.js";
export { shouldChimeIn } from "./lib/watercooler.js";
export {
  safeEmbedTitle,
  bangReport,
  bangAlert,
  buildReport,
  chunkBangReport,
  previewOf,
  BANG_REPORT_RULES,
} from "./lib/embedCard.js";
export {
  AI_DISCLOSURE_COPY,
  renderAiBadge,
  renderSyntheticMediaLabel,
} from "./lib/aiDisclosure.js";
export { buildReportPrompt } from "./lib/reportPrompt.js";
export {
  BRAND,
  CHANNELS,
  CHANNEL_CYCLE,
  FONT_DISPLAY,
  FONT_MONO,
  FONT_LINK,
  LOGO_URL,
  NAMEPLATE_URL,
  AURORA_URL,
  BRAND_NAME,
  LEGAL_NAME,
  SITE_URL,
  POSTAL_ADDRESS,
  LEGAL_FOOTER,
} from "./lib/brand.js";
export {
  fmtDate,
  fmtTime,
  fmtDateTime,
  fmtRelative,
  nexusTimestamp,
  phoenixToday,
  todayIso,
  phoenixWeekdayIndex,
  fmtCurrency,
  fmtNumber,
  fmtPercent,
  fmtBytes,
  truncate,
  pluralize,
  pluralizeBare,
  fmtList,
  fmtKv,
  fmtTable,
  fmtFixedTable,
  joinOxford,
  stripMarkdown,
  mention,
  mentionMany,
  channelLink,
  codeSpan,
  linkLabel,
  PALETTE,
} from "./lib/format.js";
export { buildAttachmentContentBlocks } from "./lib/attachments.js";
export { buildEmailAttachmentBlocks, emailAttachmentBlocksByToken } from "./lib/emailAttachments.js";
export {
  postHmacSigned,
  makeJoinCommand,
  makeLeaveCommand,
} from "./lib/voiceJoin.js";
export { createBangCommandTool } from "./lib/voiceBangCommand.js";
export { buildMimeMessage, sendMimeEmail } from "./lib/mimeEmail.js";
