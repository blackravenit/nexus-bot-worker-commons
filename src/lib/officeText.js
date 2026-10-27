// =============================================================================
// lib/officeText.js, Zero-dependency Word/Excel text extraction for Workers.
//
// Anthropic's Messages API has no native reader for .docx / .xlsx, so we crack
// the OOXML container ourselves and hand Claude the text as a plain `text`
// block. .docx and .xlsx are ZIP archives of XML parts; we read the ZIP central
// directory by hand and inflate each part with the runtime's built-in
// DecompressionStream("deflate-raw"). No npm deps, keeps commons'
// "Workers globals only" contract.
//
// What we extract:
//   .docx  -> word/document.xml, paragraph- and break-aware, tags stripped.
//   .xlsx  -> every xl/worksheets/sheet*.xml, shared strings resolved, emitted
//             as tab-separated rows under each sheet name.
//
// Fidelity caveat (by design): this recovers TEXT and CELL VALUES, not visual
// layout, embedded charts, or images. Good enough for "read this doc / pull the
// numbers"; not a pixel-faithful render. The caller surfaces that distinction.
// =============================================================================

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CDH_SIG = 0x02014b50; // Central Directory file Header
const MAX_TEXT_CHARS = 200_000; // hard cap on extracted text fed to the model

const OFFICE_MIME = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
]);

/**
 * True if the mime type is a supported Office Open XML container we can read.
 * @param {string} mime
 * @returns {boolean}
 */
export function isOfficeMime(mime) {
  return OFFICE_MIME.has(String(mime || "").toLowerCase());
}

/**
 * Inflate a raw DEFLATE byte range (ZIP method 8) via DecompressionStream.
 * Exported so other readers (e.g. email attachment ZIP/DMARC handling in
 * emailAttachments.js) can reuse the same inflate path.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Locate the End Of Central Directory record, scanning backwards to tolerate a
 * trailing ZIP comment (up to the 64 KB spec maximum).
 * @param {DataView} view
 * @returns {number} byte offset of the EOCD, or -1 if not found
 */
function findEocd(view) {
  const len = view.byteLength;
  const minOff = Math.max(0, len - 22 - 0xffff);
  for (let i = len - 22; i >= minOff; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Parse a ZIP archive's central directory into a map of entry name -> raw
 * (still-compressed) bytes plus compression method. We read the central
 * directory rather than streaming local headers so we always have accurate
 * sizes even when entries were written with data descriptors.
 *
 * @param {ArrayBuffer} buf
 * @returns {Map<string, { method: number, raw: Uint8Array }>}
 */
export function readZipEntries(buf) {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error("not a ZIP archive (no EOCD)");

  const entryCount = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder("utf-8");
  const entries = new Map();

  let off = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (off + 46 > buf.byteLength || view.getUint32(off, true) !== CDH_SIG) break;
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = decoder.decode(bytes.subarray(off + 46, off + 46 + nameLen));

    // Jump to the local header to find where the data actually starts (its
    // name/extra lengths can differ from the central directory's).
    const localNameLen = view.getUint16(localOff + 26, true);
    const localExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    entries.set(name, { method, raw: bytes.subarray(dataStart, dataStart + compSize) });

    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Read one named ZIP entry and return its decoded UTF-8 text, or "" if absent.
 * @param {Map<string, { method: number, raw: Uint8Array }>} entries
 * @param {string} name
 * @returns {Promise<string>}
 */
async function readEntryText(entries, name) {
  const e = entries.get(name);
  if (!e) return "";
  const out = e.method === 0 ? e.raw : await inflateRaw(e.raw);
  return new TextDecoder("utf-8").decode(out);
}

/**
 * Decode the five predefined XML entities. (Office parts use these plus numeric
 * char refs; numeric refs are rare in extracted body text and left as-is.)
 * @param {string} s
 * @returns {string}
 */
function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&"); // last, so we don't double-decode
}

/**
 * Extract readable text from a .docx, paragraph- and line-break-aware.
 * @param {Map<string, { method: number, raw: Uint8Array }>} entries
 * @returns {Promise<string>}
 */
async function extractDocx(entries) {
  let xml = await readEntryText(entries, "word/document.xml");
  if (!xml) return "";
  // Turn structural elements into whitespace BEFORE stripping tags.
  xml = xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n");
  const text = decodeXmlEntities(xml.replace(/<[^>]+>/g, ""));
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Parse a shared-strings part into an ordered array. Each <si> may hold one or
 * more <t> runs which concatenate into a single logical string.
 * @param {string} xml
 * @returns {string[]}
 */
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const runs = m[1].match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || [];
    const joined = runs.map((r) => r.replace(/<[^>]+>/g, "")).join("");
    out.push(decodeXmlEntities(joined));
  }
  return out;
}

/**
 * Convert a cell reference's column letters (e.g. "AB" in "AB12") to a 0-based
 * column index so sparse rows reconstruct in the right order.
 * @param {string} ref
 * @returns {number}
 */
function columnIndex(ref) {
  const letters = (ref.match(/^([A-Z]+)/) || [, ""])[1];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Render one worksheet's XML into tab-separated rows, resolving shared strings.
 * @param {string} xml
 * @param {string[]} shared
 * @returns {string}
 */
function renderSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const cells = [];
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cm;
    while ((cm = cellRe.exec(rm[1])) !== null) {
      const attrs = cm[1] || cm[3] || "";
      const inner = cm[2] || "";
      const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [, ""])[1];
      const type = (attrs.match(/t="([^"]+)"/) || [, ""])[1];
      let value = "";
      if (type === "s") {
        const idx = Number((inner.match(/<v>([\s\S]*?)<\/v>/) || [, ""])[1]);
        value = shared[idx] ?? "";
      } else if (type === "inlineStr") {
        const t = inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
        value = t ? decodeXmlEntities(t[1].replace(/<[^>]+>/g, "")) : "";
      } else {
        const v = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = v ? decodeXmlEntities(v[1]) : "";
      }
      const col = ref ? columnIndex(ref) : cells.length;
      cells[col] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = "";
    rows.push(cells.join("\t"));
  }
  return rows.join("\n").trim();
}

/**
 * Extract every worksheet from a .xlsx as labeled, tab-separated text. Sheet
 * names come from workbook.xml in document order, which matches the natural
 * sort of the sheetN.xml parts closely enough for a readable dump.
 * @param {Map<string, { method: number, raw: Uint8Array }>} entries
 * @returns {Promise<string>}
 */
async function extractXlsx(entries) {
  const shared = parseSharedStrings(await readEntryText(entries, "xl/sharedStrings.xml"));
  const workbookXml = await readEntryText(entries, "xl/workbook.xml");
  const sheetNames = (workbookXml.match(/<sheet\b[^>]*name="([^"]*)"[^>]*\/>/g) || []).map(
    (s) => decodeXmlEntities((s.match(/name="([^"]*)"/) || [, ""])[1])
  );

  const sheetFiles = [...entries.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => {
      const na = Number(a.match(/sheet(\d+)\.xml$/)[1]);
      const nb = Number(b.match(/sheet(\d+)\.xml$/)[1]);
      return na - nb;
    });

  const out = [];
  for (let i = 0; i < sheetFiles.length; i++) {
    const xml = await readEntryText(entries, sheetFiles[i]);
    const label = sheetNames[i] || `Sheet${i + 1}`;
    const body = renderSheet(xml, shared);
    if (body) out.push(`### ${label}\n${body}`);
  }
  return out.join("\n\n");
}

/**
 * Extract plain text from a Word or Excel OOXML buffer.
 *
 * @param {ArrayBuffer} buf - the raw .docx/.xlsx bytes
 * @param {string} mime - the file's mime type (decides the extractor)
 * @returns {Promise<string>} extracted text (truncated to MAX_TEXT_CHARS), or ""
 */
export async function extractOfficeText(buf, mime) {
  const entries = readZipEntries(buf);
  const lower = String(mime || "").toLowerCase();
  let text = "";
  if (lower.endsWith("wordprocessingml.document")) {
    text = await extractDocx(entries);
  } else if (lower.endsWith("spreadsheetml.sheet")) {
    text = await extractXlsx(entries);
  }
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS) + "\n\n[...truncated: document exceeds extraction cap...]";
  }
  return text;
}
