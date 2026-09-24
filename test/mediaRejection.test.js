import { test } from "node:test";
import assert from "node:assert/strict";

import { isMediaRejection } from "../src/handlers/handleChatMessage.js";

// Regression guard for 2026-09-24: any failure on a turn carrying an image was
// blamed on the image, so unrelated outages reached users as "I could not open
// your attachment, re-post it" and never raised a fleet error.

test("isMediaRejection: claims a 4xx that actually names the offending block", () => {
  for (const msg of [
    "[anthropic] API error 400: messages.0.content.0.image: image exceeds 5 MB maximum",
    "[anthropic] API error 400: could not process document block",
    "[anthropic] API error 413: attachment too large",
  ]) {
    assert.equal(isMediaRejection(new Error(msg)), true, msg);
  }
});

test("isMediaRejection: disclaims server-side and transport failures", () => {
  for (const msg of [
    "[anthropic] API error 500: internal server error",
    "[anthropic] API error 529: overloaded_error",
    "[anthropic] fetch failed: network connection lost",
    "[anthropic] JSON parse failed: Unexpected end of JSON input",
  ]) {
    assert.equal(isMediaRejection(new Error(msg)), false, msg);
  }
});

test("isMediaRejection: disclaims a 4xx unrelated to the attachment", () => {
  // The cache-breakpoint 400 is the exact shape that was being misreported.
  const msg = "[anthropic] API error 400: cache_control ttl 1h cannot follow a 5m breakpoint";
  assert.equal(isMediaRejection(new Error(msg)), false);
});

test("isMediaRejection: survives a null or malformed error", () => {
  assert.equal(isMediaRejection(null), false);
  assert.equal(isMediaRejection(undefined), false);
  assert.equal(isMediaRejection({}), false);
});
