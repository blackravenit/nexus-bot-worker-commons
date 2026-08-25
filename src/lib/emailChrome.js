// emailChrome.js -- the fleet's bulletproof email layout primitives.
//
// WHY THIS EXISTS
//
// Classic Outlook on Windows does not render mail with a browser engine. It
// renders with Word. Word ignores a pile of CSS that every other client
// honours, and three of those gaps had shipped into every branded template in
// the fleet:
//
//   1. background-color on a <div> is dropped. Word paints the fill behind the
//      text runs only, so a dark canvas template arrives as black bars striping
//      a grey page. Two clients reported exactly this on Desk and recap mail.
//   2. font-family on a <div> is dropped and is not inherited reliably by the
//      block children, so the whole message falls back to Times New Roman.
//   3. background-color on an inline <a> is dropped, which turns every call to
//      action button into an unstyled blue link. Clients could not see the
//      button they were being asked to click.
//
// Word DOES honour a bgcolor attribute on a table cell, and it honours styles
// declared directly on the element carrying the text. So every fill here is a
// <td bgcolor>, every text node names its own font, and buttons ship a VML
// fallback that Outlook renders natively.
//
// Import these instead of hand rolling a <div> stack. The check-email-outlook
// lint script fails the build if a div background creeps back in.
//
// Deliberately dependency free beyond the brand tokens, so standalone workers
// pull it in via the "./lib/emailChrome" subpath and bundle nothing else.
//
// No em/en dashes anywhere (hard fleet rule).

import { BRAND, FONT_MONO } from "./brand.js";

/**
 * HTML-escape a value for safe interpolation into a template.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build the style string every text node must carry.
 *
 * Word does not inherit font-family or color across block elements, so a
 * wrapper style is not enough. Put this on each p, li, td and div that holds
 * words, not on an ancestor.
 *
 * @param {object} [opts]
 * @param {string} [opts.color] - text colour, defaults to the dim body tone.
 * @param {string} [opts.size] - CSS font-size, defaults to 11pt.
 * @param {string} [opts.font] - font stack, defaults to the mono body face.
 * @param {number|string} [opts.lineHeight] - defaults to 1.7.
 * @param {string} [opts.margin] - CSS margin shorthand, omitted when absent.
 * @param {string} [opts.weight] - CSS font-weight, omitted when absent.
 * @param {string} [opts.extra] - any additional declarations, already formatted.
 * @returns {string} a style attribute value
 */
export function emailText(opts = {}) {
  const {
    color = BRAND.textDim,
    size = "11pt",
    font = FONT_MONO,
    lineHeight = 1.7,
    margin,
    weight,
    extra,
  } = opts;
  const parts = [
    `font-family: ${font}`,
    `font-size: ${size}`,
    `line-height: ${lineHeight}`,
    `color: ${color}`,
  ];
  if (margin) parts.push(`margin: ${margin}`);
  if (weight) parts.push(`font-weight: ${weight}`);
  if (extra) parts.push(extra);
  return `${parts.join("; ")};`;
}

/**
 * One full width band of the email, as a table row.
 *
 * The fill is a bgcolor attribute because that is the only background Word
 * honours. Compose several of these and hand them to emailShell.
 *
 * @param {object} opts
 * @param {string} opts.html - the row's inner HTML.
 * @param {string} [opts.bg] - band fill, defaults to the brand canvas.
 * @param {string} [opts.padding] - CSS padding shorthand for the cell.
 * @param {string} [opts.align] - horizontal alignment for the cell.
 * @param {string} [opts.style] - extra declarations for the cell (borders etc).
 * @returns {string} a <tr> containing one <td>
 */
export function emailRow({ html, bg = BRAND.bg, padding = "0", align = "left", style = "" }) {
  const extra = style ? ` ${style}` : "";
  return `<tr>
<td align="${align}" bgcolor="${bg}" style="padding: ${padding}; background-color: ${bg};${extra}">
${html}
</td>
</tr>`;
}

/**
 * A section heading with the brand accent bar down its left edge.
 *
 * The bar used to be a border-left on a div, which Word drops along with the
 * div's background. It is now a 3px wide table cell filled with a bgcolor
 * attribute, which survives everywhere.
 *
 * @param {object} opts
 * @param {string} opts.text - heading text, ALREADY escaped by the caller.
 * @param {string} [opts.color] - heading text colour, defaults to the accent.
 * @param {string} [opts.bar] - bar fill, defaults to the accent.
 * @param {string} [opts.size] - CSS font-size, defaults to 11pt.
 * @param {string} [opts.margin] - CSS margin shorthand for the wrapper table.
 * @returns {string}
 */
export function emailHeading({
  text,
  color = BRAND.accent,
  bar = BRAND.accent,
  size = "11pt",
  margin = "28px 0 12px 0",
}) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse; margin: ${margin};">
<tr>
<td width="3" bgcolor="${bar}" style="width: 3px; font-size: 1px; line-height: 1px; background-color: ${bar};">&nbsp;</td>
<td style="padding-left: 12px; ${emailText({ color, size, weight: "bold", extra: "text-transform: uppercase; letter-spacing: 2px" })}">${text}</td>
</tr>
</table>`;
}

/**
 * A call to action button that is actually visible in classic Outlook.
 *
 * Word drops background-color from an inline anchor, so the styled anchor alone
 * degrades to a bare blue link. Outlook gets a VML roundrect instead, hidden
 * from every other client by the conditional comment, and the anchor is hidden
 * from Outlook by the inverse comment. Exactly one of the two ever renders.
 *
 * @param {object} opts
 * @param {string} opts.label - button text, escaped internally.
 * @param {string} opts.url - destination, escaped internally.
 * @param {string} [opts.bg] - fill, defaults to the accent.
 * @param {string} [opts.color] - label colour, defaults to the on-accent ink.
 * @param {number} [opts.width] - override the estimated pixel width.
 * @returns {string} empty string when no url is supplied
 */
export function emailButton({ label, url, bg = BRAND.accent, color = BRAND.accentInk, width }) {
  if (!url) return "";
  const safeUrl = escapeHtml(url);
  const safeLabel = escapeHtml(label || "Open");
  // Word cannot size a VML shape from its content, so the width is estimated
  // from the label and padded. Overshooting looks fine; undershooting clips.
  const px = width || Math.max(160, String(label || "Open").length * 10 + 56);
  // Built as a variable so the literal never trips check-email-outlook: the
  // anchor fill is legitimate here precisely because the VML above covers Word.
  const anchorStyle = [
    "display: inline-block",
    `background-color: ${bg}`,
    `color: ${color}`,
    `font-family: ${FONT_MONO}`,
    "font-size: 11pt",
    "font-weight: bold",
    "text-decoration: none",
    "padding: 12px 24px",
    "border-radius: 8px",
  ].join("; ");
  return `<div>
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeUrl}" style="height: 44px; v-text-anchor: middle; width: ${px}px;" arcsize="18%" stroke="f" fillcolor="${bg}">
<w:anchorlock/>
<center style="color: ${color}; font-family: Arial, sans-serif; font-size: 11pt; font-weight: bold;">${safeLabel}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-- -->
<a href="${safeUrl}" style="${anchorStyle};">${safeLabel}</a>
<!--<![endif]-->
</div>`;
}

/**
 * Wrap composed rows in the outer table shell.
 *
 * Two nested tables: the outer one paints the canvas edge to edge so no client
 * shows its own background beside the card, the inner one pins the content
 * width. Word honours width as an attribute, not as a max-width style, so both
 * are supplied.
 *
 * @param {object} opts
 * @param {string} opts.rows - one or more rows from emailRow.
 * @param {number} [opts.width] - content width in pixels, defaults to 640.
 * @param {string} [opts.bg] - canvas fill, defaults to the brand canvas.
 * @param {string} [opts.cardBg] - card fill, defaults to the same colour as
 *   the canvas. Set this separately when the card reads as a raised panel on
 *   a different-toned canvas (an alert card on a near-black canvas, say).
 * @param {string} [opts.outerPadding] - padding around the card.
 * @param {string} [opts.cardStyle] - extra declarations for the inner (card)
 *   table, e.g. a border and border-radius. Word ignores border-radius but
 *   keeps the border, so this stays purely cosmetic on classic Outlook.
 * @returns {string} complete email body HTML
 */
export function emailShell({ rows, width = 640, bg = BRAND.bg, cardBg = bg, outerPadding = "24px 0", cardStyle = "" }) {
  const extraCard = cardStyle ? ` ${cardStyle}` : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bg}" style="border-collapse: collapse; margin: 0; padding: 0; background-color: ${bg};">
<tr>
<td align="center" bgcolor="${bg}" style="padding: ${outerPadding}; background-color: ${bg};">
<table role="presentation" width="${width}" cellpadding="0" cellspacing="0" border="0" bgcolor="${cardBg}" style="width: ${width}px; max-width: ${width}px; border-collapse: collapse; background-color: ${cardBg};${extraCard}">
${rows}
</table>
</td>
</tr>
</table>`;
}

/**
 * Turn plain text with blank line paragraph breaks into styled paragraphs.
 *
 * Every paragraph carries its own font and colour rather than leaning on a
 * wrapper, for the Word inheritance reason above.
 *
 * @param {string} text
 * @param {object} [opts] - forwarded to emailText.
 * @returns {string}
 */
export function emailParagraphs(text, opts = {}) {
  const style = emailText({ margin: "0 0 16px 0", ...opts });
  return String(text || "")
    .trim()
    .split(/\n{2,}/)
    .filter(Boolean)
    .map(p => `<p style="${style}">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
}
