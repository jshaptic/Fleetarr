/**
 * Where a floating thing goes relative to the control that opened it.
 *
 * Extracted from the owner hover card, which worked this out first: below the anchor,
 * flipped above when there is no room below, clamped to the viewport so nothing ever opens
 * half off-screen. It is a function of four numbers and needs no DOM, so it is here rather
 * than copied into every popover - and it can be tested without mounting anything.
 *
 * Both the card and the picker measure *after* mount rather than guessing: a card's height
 * depends on how many facts it has, and a list's on how many rows survived the filter.
 */

export interface AnchorRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
}

export interface FloatingSize {
  readonly width: number;
  readonly height: number;
}

export interface Placement {
  readonly left: number;
  readonly top: number;
}

export interface PlacementOptions {
  /** Space between the anchor and the floating element. */
  readonly gap?: number;
  /** Closest the floating element may come to a viewport edge. */
  readonly margin?: number;
  /** Viewport, injectable so a test does not need a window. */
  readonly viewport?: { readonly width: number; readonly height: number };
}

export const ANCHOR_GAP = 6;
export const ANCHOR_MARGIN = 8;

export function placeAnchored(
  anchor: AnchorRect,
  size: FloatingSize,
  options: PlacementOptions = {},
): Placement {
  const gap = options.gap ?? ANCHOR_GAP;
  const margin = options.margin ?? ANCHOR_MARGIN;
  const viewport = options.viewport ?? { width: window.innerWidth, height: window.innerHeight };

  const below = anchor.bottom + gap;
  /**
   * Flipping needs room on the other side too. Without the second test a tall element in a
   * short viewport flips into a worse position than the one it was trying to escape.
   */
  const flip = below + size.height > viewport.height - margin && anchor.top - size.height - gap > margin;

  return {
    left: Math.max(margin, Math.min(anchor.left, viewport.width - size.width - margin)),
    top: flip ? anchor.top - size.height - gap : below,
  };
}

/**
 * How wide a list under a field should be.
 *
 * Not simply the field's width: the narrowest of these fields is an inline cell in a table
 * of instances, and a container path does not fit in it. So the list may grow past its
 * anchor up to `preferred`, and is clamped to the viewport rather than to the dialog - it
 * is teleported to the body and belongs to the screen, not to the form.
 */
export function anchoredWidth(
  anchorWidth: number,
  preferred: number,
  options: { readonly margin?: number; readonly viewport?: { readonly width: number } } = {},
): number {
  const margin = options.margin ?? ANCHOR_MARGIN;
  const viewportWidth = options.viewport?.width ?? window.innerWidth;
  return Math.min(Math.max(anchorWidth, preferred), viewportWidth - margin * 2);
}
