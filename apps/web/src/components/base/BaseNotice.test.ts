import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import BaseNotice from './BaseNotice.vue';
import IconCreate from './icons/IconCreate.vue';

/**
 * Three properties, and each one is a bug this component was written to make impossible.
 */
describe('BaseNotice', () => {
  /**
   * The bug: `<p class="flex gap-2">` whose prose contained an `<em>`. A flex container
   * wraps each *contiguous* run of text in its own anonymous item, and an element child
   * breaks that contiguity - so one sentence became four flex items laid out side by side
   * under `nowrap` and rendered as a squeezed two-by-two grid. Nothing in the type system
   * or the test suite could see it, because the web suite runs with `css: false`.
   */
  it('renders the prose as one element, whatever markup is inside it', () => {
    const wrapper = mount(BaseNotice, {
      props: { tone: 'danger' },
      slots: { default: 'moving <em>0</em> items now' },
    });

    const prose = wrapper.findAll('div > span').at(1);
    expect(prose?.text()).toBe('moving 0 items now');
    expect(prose?.find('em').exists()).toBe(true);
  });

  /**
   * The glyphs are three sizes on purpose - `icons.test.ts` pins the light triangle at
   * `h-4.5` and the dense circle at `h-3` so the pair does not read backwards. That makes
   * "put the icon first and the text after it" produce a different left margin per tone,
   * which is what a stack of these looked like before. The rail is the fix, so it has to
   * exist on the tone that draws nothing too.
   */
  it.each(['neutral', 'info', 'sync', 'warn', 'danger'] as const)(
    'reserves the same glyph rail for tone=%s',
    (tone) => {
      const rail = mount(BaseNotice, { props: { tone } }).find('span');

      expect(rail.classes()).toContain('w-4.5');
      expect(rail.classes()).toContain('shrink-0');
    },
  );

  it('draws no glyph for a neutral fact, and one for every severity', () => {
    expect(mount(BaseNotice).find('[data-icon]').exists()).toBe(false);

    for (const tone of ['info', 'sync', 'warn', 'danger'] as const) {
      expect(mount(BaseNotice, { props: { tone } }).find('[data-icon]').exists(), tone).toBe(true);
    }
  });

  /** An override may narrow the meaning; it must never restate the severity. */
  it('lets a caller swap the glyph while keeping the tone colour', () => {
    const wrapper = mount(BaseNotice, { props: { tone: 'sync', icon: IconCreate } });

    expect(wrapper.find('[data-icon]').attributes('data-icon')).toBe('create');
    expect(wrapper.classes()).toContain('text-sync');
  });

  it('draws its own box only as a panel', () => {
    expect(mount(BaseNotice, { props: { tone: 'warn' } }).classes()).not.toContain('border');
    expect(
      mount(BaseNotice, { props: { tone: 'warn', variant: 'panel' } }).classes(),
    ).toContain('border');
  });
});
