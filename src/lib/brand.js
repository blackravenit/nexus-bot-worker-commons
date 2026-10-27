// lib/brand.js, the single source of truth for Black Raven's visual identity.
//
// Every client-facing surface in the fleet (ticket mail, e-signature requests,
// newsletters, client reports, support portals, one-pagers) used to carry its
// own copy of these values, which is how the arcade green and the pixel display
// face survived in eleven places after the site had moved on. Import from here
// instead of redeclaring, so a palette change is one edit and not an archaeology
// expedition.
//
// Deliberately dependency free and side effect free: standalone workers pull it
// in via the "./lib/brand" subpath export and bundle nothing else from commons.
//
// Matches blackravenit.com as of the 2026 redesign. No em/en dashes anywhere
// (hard fleet rule).

/**
 * Core palette. Pure black canvas, colour used as emitted light rather than
 * large fills, body text neutral so the black survives.
 */
export const BRAND = {
  bg: "#000000",          // page and email canvas
  surface: "#0a0d0e",     // raised panel on the canvas
  panel: "#0a0d0e",       // alias: older templates call it panel
  border: "#1c2229",      // hairline rule
  line: "#1c2229",        // alias: older templates call it line
  accent: "#21b8cd",      // channel cyan, the single default accent
  accentDim: "#17828f",
  accentInk: "#001014",   // text on a solid accent fill
  white: "#edede8",       // body text, not pure white
  textDim: "#cfd2cc",
  muted: "#7a7d78",
  dim: "#4d504b",
  status: "#ffb020",      // attention, reused from the SOC channel
};

/**
 * Product channels. Each capability owns exactly one hue, so a long document
 * reads as a system rather than one accent repeated. Green is a live status
 * signal only and is never decorative.
 */
export const CHANNELS = {
  platform: "#21b8cd",
  agents: "#8b5cf6",
  soc: "#ffb020",
  build: "#ff5c7a",
  managed: "#cfd2cc",
  live: "#00ff41",
};

/** Rotation used when a document has several sections and no natural hue. */
export const CHANNEL_CYCLE = [CHANNELS.soc, CHANNELS.agents, CHANNELS.platform, CHANNELS.build];

// Type. Space Grotesk display over Space Mono body. The arcade pixel face is
// retired everywhere client facing; it survives only in the 404 arcade, which
// is a hidden game and the one place arcade type is the correct answer.
export const FONT_DISPLAY = "'Space Grotesk', 'Helvetica Neue', Arial, sans-serif";
export const FONT_MONO = "'Space Mono', 'Courier New', Courier, monospace";

/** Google Fonts href for surfaces that can load a webfont. */
export const FONT_LINK =
  "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700&family=Space+Mono:wght@400;700&display=swap";

// Hosted assets. Absolute because email clients have no page origin.
export const LOGO_URL = "https://blackravenit.com/assets/logos/Black_Raven_Logo_White.png";
export const NAMEPLATE_URL = "https://blackravenit.com/assets/social/newsletter-nameplate.png";
export const AURORA_URL = "https://blackravenit.com/assets/social/newsletter-aurora.png";

// Identity strings. The brand is Black Raven; the legal entity keeps its
// registered name and belongs in footers, contracts and legal copy only.
export const BRAND_NAME = "Black Raven";
export const LEGAL_NAME = "Black Raven IT, LLC";
export const SITE_URL = "https://blackravenit.com";
export const POSTAL_ADDRESS = "830 W IL Route 22, Suite 6, Lake Zurich, IL 60047";
export const LEGAL_FOOTER = `${LEGAL_NAME} · ${POSTAL_ADDRESS}`;
