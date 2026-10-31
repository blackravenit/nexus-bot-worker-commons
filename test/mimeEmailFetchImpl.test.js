import { test } from "node:test";
import assert from "node:assert/strict";
import { sendMimeEmail } from "../src/lib/mimeEmail.js";

test("sendMimeEmail routes both calls through opts.fetchImpl when given", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return url.endsWith("/send")
      ? new Response(null, { status: 202 })
      : new Response(JSON.stringify({ id: "draft1" }), { status: 201 });
  };
  const out = await sendMimeEmail("tok", "a@b.com", "Subject: x\r\n\r\nbody", { fetchImpl });
  assert.equal(out.messageId, "draft1");
  assert.equal(urls.length, 2);
});
