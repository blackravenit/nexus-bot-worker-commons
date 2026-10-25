// Tests for the inline ({ name, content_type, data_base64 }) attachment form.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAttachmentContentBlocks } from "../src/lib/attachments.js";

// 1x1 transparent PNG
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/**
 * Run fn with console.warn silenced and counted.
 * @param {() => Promise<void>} fn
 * @returns {Promise<number>} warn call count
 */
async function withQuietWarn(fn) {
  const original = console.warn;
  let count = 0;
  console.warn = () => { count += 1; };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return count;
}

test("inline png becomes a base64 image block with no Nexus credentials", async () => {
  const { blocks, warnings } = await buildAttachmentContentBlocks({}, [
    { name: "shot.png", content_type: "image/png", data_base64: TINY_PNG },
  ]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(blocks, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG } },
  ]);
});

test("unsupported inline type is skipped with a warn", async () => {
  let result;
  const warns = await withQuietWarn(async () => {
    result = await buildAttachmentContentBlocks({}, [
      { name: "a.pdf", content_type: "application/pdf", data_base64: TINY_PNG },
    ]);
  });
  assert.deepEqual(result.blocks, []);
  assert.equal(result.warnings.length, 1);
  assert.ok(warns >= 1);
});

test("inline image over 6 MB decoded is skipped", async () => {
  let result;
  await withQuietWarn(async () => {
    result = await buildAttachmentContentBlocks({}, [
      { name: "big.png", content_type: "image/png", data_base64: "A".repeat(8 * 1024 * 1024 + 4) },
    ]);
  });
  assert.deepEqual(result.blocks, []);
});

test("URL attachments still take the credentialed path", async () => {
  let result;
  await withQuietWarn(async () => {
    result = await buildAttachmentContentBlocks({}, [
      { id: "x", filename: "f.png", mime_type: "image/png", url: "/api/internal/attachments/x" },
      { name: "shot.png", content_type: "image/png", data_base64: TINY_PNG },
    ]);
  });
  assert.equal(result.blocks.length, 1);
  assert.ok(result.warnings.some((w) => w.includes("missing")));
});
