import { describe, expect, it } from 'vitest';
import { anchoredWidth, placeAnchored } from './anchor';

/**
 * The rule two popovers share, tested where it is a function of four numbers rather than
 * through a mounted component - happy-dom reports every rect as zero, so measured through
 * a component this logic would be asserting nothing at all.
 */
const VIEWPORT = { width: 1200, height: 800 };
const SIZE = { width: 300, height: 200 };

describe('placeAnchored', () => {
  it('sits below the anchor, one gap down', () => {
    const at = placeAnchored({ top: 100, bottom: 130, left: 40, width: 200 }, SIZE, {
      viewport: VIEWPORT,
    });

    expect(at).toEqual({ left: 40, top: 136 });
  });

  it('flips above when there is no room below', () => {
    const at = placeAnchored({ top: 700, bottom: 730, left: 40, width: 200 }, SIZE, {
      viewport: VIEWPORT,
    });

    expect(at.top).toBe(494); // 700 - 200 - 6
  });

  /**
   * Both sides are tested before flipping. Without the second test a tall element in a
   * short viewport flips into a position worse than the one it was escaping.
   */
  it('stays below when neither side has room', () => {
    const at = placeAnchored({ top: 300, bottom: 330, left: 40, width: 200 }, { width: 300, height: 600 }, {
      viewport: VIEWPORT,
    });

    expect(at.top).toBe(336);
  });

  it('clamps to the viewport rather than opening half off-screen', () => {
    const at = placeAnchored({ top: 100, bottom: 130, left: 1150, width: 40 }, SIZE, {
      viewport: VIEWPORT,
    });

    expect(at.left).toBe(892); // 1200 - 300 - 8
  });

  it('never goes past the left edge either', () => {
    const at = placeAnchored({ top: 100, bottom: 130, left: -50, width: 200 }, SIZE, {
      viewport: VIEWPORT,
    });

    expect(at.left).toBe(8);
  });
});

describe('anchoredWidth', () => {
  /** The narrowest of these fields is a cell in a table of instances; a path does not fit. */
  it('grows a narrow field up to the preferred width', () => {
    expect(anchoredWidth(180, 384, { viewport: { width: 1200 } })).toBe(384);
  });

  it('keeps a wide field its own width', () => {
    expect(anchoredWidth(600, 384, { viewport: { width: 1200 } })).toBe(600);
  });

  it('never grows past the viewport', () => {
    expect(anchoredWidth(180, 384, { viewport: { width: 320 } })).toBe(304);
  });
});
