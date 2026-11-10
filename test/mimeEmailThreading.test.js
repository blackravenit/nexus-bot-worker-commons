import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMimeMessage } from "../src/lib/mimeEmail.js";

const base = { from: "a@b.com", to: "c@d.com", subject: "Hi", htmlBody: "<p>x</p>" };

/** Strips the random ids so two builds can be compared byte for byte. */
function normalize(m) {
  return m.mime.replaceAll(m.messageId, "<MID>").replace(/====(alt|mix)_[0-9a-f]+====/g, "====B====");
}

test("no threading fields: no threading headers, output unchanged in shape", () => {
  const out = buildMimeMessage(base);
  assert.doesNotMatch(out.mime, /In-Reply-To|References|Thread-Index|Thread-Topic/);
  assert.equal(normalize(buildMimeMessage(base)), normalize(out));
});

test("threading headers are emitted right after Message-ID", () => {
  const out = buildMimeMessage({
    ...base,
    inReplyTo: "<a@x>",
    references: "<z@x> <a@x>",
    threadIndex: "AQHabc==",
    threadTopic: "Quote",
  });
  const lines = out.mime.split("\r\n");
  const at = lines.findIndex((l) => l.startsWith("Message-ID:"));
  assert.deepEqual(lines.slice(at + 1, at + 6), [
    "In-Reply-To: <a@x>",
    "References: <z@x> <a@x>",
    "Thread-Index: AQHabc==",
    "Thread-Topic: Quote",
    "MIME-Version: 1.0",
  ]);
});

test("CR or LF in a threading value is dropped with a warning naming the field", () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const out = buildMimeMessage({
      ...base,
      inReplyTo: "<a@x>\r\nBcc: evil@x.com",
      references: "<r@x>\nX-Evil: 1",
      threadIndex: "AQ==",
    });
    assert.doesNotMatch(out.mime, /evil/i);
    assert.doesNotMatch(out.mime, /In-Reply-To|References:/);
    assert.match(out.mime, /Thread-Index: AQ==/);
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /inReplyTo/);
  assert.match(warnings[1], /references/);
});

test("threadTopic is Q-encoded like Subject when non-ASCII", () => {
  const out = buildMimeMessage({ ...base, threadTopic: "Café" });
  assert.match(out.mime, /Thread-Topic: =\?UTF-8\?Q\?Caf=C3=A9\?=/);
});
