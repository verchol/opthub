/**
 * The hub's mark: "less for more".
 *
 * Two arrows, deliberately unequal. The left one falls — what the work costs —
 * and is drawn short and quiet. The right one rises taller and carries the
 * accent: what you got for it. The asymmetry is the argument: a small give for
 * a larger get. Reversed (tall fall, short rise) it would say the opposite, so
 * the proportions are not decorative.
 *
 * A first attempt used descending bars crossed by a diagonal. At 16px the
 * diagonal ate the bars and the whole thing just read "up", which is the half
 * of the idea that needs no help.
 */
const geometry = (down, up) => `
  <path d="M7.2 5.2 v6.6" stroke="${down}" stroke-width="2.6" stroke-linecap="round" fill="none"/>
  <path d="M3.2 10.8 L7.2 15.4 L11.2 10.8 Z" fill="${down}"/>
  <path d="M16.8 20.8 v-9.6" stroke="${up}" stroke-width="2.6" stroke-linecap="round" fill="none"/>
  <path d="M12.4 11.6 L16.8 5.4 L21.2 11.6 Z" fill="${up}"/>`

/** Inline in the page: takes its colours from the theme. */
export const ICON_SVG = (size = 22) =>
  `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 24 24" role="img"
     aria-label="Less for more: cost falling, value rising">
    ${geometry('currentColor', 'var(--ac)')}
  </svg>`

/** Browser tab: a favicon cannot inherit, so the colours are pinned. */
export const FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${geometry('#8B9C9E', '#0E6E65')}</svg>`)
