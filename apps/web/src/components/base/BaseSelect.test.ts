import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import BaseSelect from './BaseSelect.vue';
import { filterOptions, highlightSegments, normalizeOptions } from './select';

const PATHS = [
  '/data/media',
  '/data/media/movies',
  '/data/media/movies/russian/4k',
  '/data/media/series',
  '/mnt/archive/4k-remux',
];

const KINDS = [
  { value: 'radarr', label: 'Radarr' },
  { value: 'sonarr', label: 'Sonarr' },
];

/**
 * The list is teleported to the body, so it is never inside the wrapper - the same way
 * `PathMatrixView.test.ts` has always had to reach it. These read it where it really is.
 */
function list(): HTMLElement | null {
  return document.body.querySelector('[data-select-list]');
}

function rows(): string[] {
  return [...document.body.querySelectorAll('[role="option"]')].map((row) => row.textContent?.trim() ?? '');
}

function mountBox(props: Record<string, unknown> = {}) {
  return mount(BaseSelect, {
    props: { options: PATHS, editable: true, ...props },
    attrs: { 'data-testid': 'field' },
  });
}

async function open(wrapper: ReturnType<typeof mountBox>) {
  await wrapper.find('[data-select-toggle]').trigger('mousedown');
  return wrapper;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the search', () => {
  /**
   * The `<datalist>` rule this replaced, stated as the assertion that killed it: a field
   * holding a path offered only the options that started with it, so the picker in a
   * pre-filled dialog was reliably empty.
   */
  it('shows every option when a pre-filled field is opened', async () => {
    await open(mountBox({ modelValue: '/data/media' }));

    expect(rows()).toHaveLength(PATHS.length);
  });

  it('AND-s the terms and ignores the order they are typed in', () => {
    const items = normalizeOptions(PATHS);

    expect(filterOptions(items, 'movies 4k').map((item) => item.value)).toEqual([
      '/data/media/movies/russian/4k',
    ]);
    expect(filterOptions(items, '4k movies').map((item) => item.value)).toEqual([
      '/data/media/movies/russian/4k',
    ]);
  });

  /** A hit that starts a path segment is the one meant; `4k-remux` is a coincidence. */
  it('puts a segment-start match above one in the middle of a name', () => {
    expect(filterOptions(normalizeOptions(PATHS), '4k').map((item) => item.value)).toEqual([
      '/data/media/movies/russian/4k',
      '/mnt/archive/4k-remux',
    ]);
  });

  it('marks every occurrence of a term, not just the first', () => {
    const segments = highlightSegments('/data/media/media-4k', 'media');

    expect(segments.filter((segment) => segment.match).map((segment) => segment.text)).toEqual([
      'media',
      'media',
    ]);
    expect(segments.map((segment) => segment.text).join('')).toBe('/data/media/media-4k');
  });

  it('keeps the label whole when nothing is being searched for', () => {
    expect(highlightSegments('/data/media', '')).toEqual([{ text: '/data/media', match: false }]);
  });

  it('narrows as the field is typed in, and says how many are left', async () => {
    const wrapper = mountBox();

    await wrapper.find('input').setValue('series');

    expect(rows()).toEqual(['/data/media/series']);
    expect(list()?.textContent).toContain('1 of 5');
  });

  /** A two-option enum does not need to be told it can be narrowed. */
  it('keeps the search header out of a short fixed list', async () => {
    await open(mountBox({ options: KINDS, editable: false, modelValue: 'radarr' }));

    expect(list()?.textContent).not.toContain('option(s)');
  });

  it('says so while the options are still being fetched', async () => {
    await open(mountBox({ loading: true }));

    expect(list()?.textContent).toContain('reading folders…');
  });
});

describe('editable: what you type is the value', () => {
  /**
   * Every editable field here holds a container path, and a path Fleetarr has not read is
   * an ordinary thing to type - the preflight is the authority, not this list.
   */
  it('keeps what was typed and explains the empty list', async () => {
    const wrapper = mountBox();

    await wrapper.find('input').setValue('/nowhere');

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['/nowhere']);
    expect(rows()).toEqual([]);
    expect(list()?.textContent).toContain('Nothing matches');
  });

  it('reports Enter on a free-typed value rather than picking a row', async () => {
    const wrapper = mountBox();

    await wrapper.find('input').setValue('/nowhere');
    await wrapper.find('input').trigger('keydown', { key: 'Enter' });

    expect(wrapper.emitted('enter')?.[0]).toEqual(['/nowhere']);
    expect(wrapper.emitted('pick')).toBeUndefined();
  });

  it('leaves the field writable', () => {
    expect(mountBox().find('input').attributes('readonly')).toBeUndefined();
  });
});

describe('not editable: only an option can win', () => {
  it('never lets a keystroke become the value', async () => {
    const wrapper = mountBox({ options: KINDS, editable: false, modelValue: 'radarr' });
    // Dispatched rather than typed - a locked field is driven by the caret and the arrows.

    await wrapper.find('input').setValue('son');

    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(rows()).toEqual(['Sonarr']);
  });

  it('shows the label of the current value, not its value', () => {
    const wrapper = mountBox({ options: KINDS, editable: false, modelValue: 'sonarr' });

    expect(wrapper.find('input').element.value).toBe('Sonarr');
  });

  it('puts the typed-at label back when the list closes', async () => {
    const wrapper = mountBox({ options: KINDS, editable: false, modelValue: 'sonarr' });

    await wrapper.find('input').setValue('rad');
    await wrapper.find('input').trigger('keydown', { key: 'Escape' });
    await wrapper.find('input').trigger('blur');

    expect(wrapper.find('input').element.value).toBe('Sonarr');
  });

  /**
   * `readonly` is why this distinction exists rather than being a detail: the attribute
   * stops a browser firing `input` at all, so a searchable field carrying it would show a
   * search header over a box that ignored every key - which no test using `setValue`
   * would ever catch, because `setValue` dispatches the event itself.
   */
  it('locks a short list, where there is nothing to search for', () => {
    const input = mountBox({ options: KINDS, editable: false, modelValue: 'radarr' }).find('input');

    expect(input.attributes('readonly')).toBeDefined();
    expect(input.element.disabled).toBe(false);
  });

  it('leaves a long list typeable, so its search header is not a lie', () => {
    const many = Array.from({ length: 12 }, (_, at) => `profile-${String(at)}`);
    const input = mountBox({ options: many, editable: false, modelValue: 'profile-0' }).find('input');

    expect(input.attributes('readonly')).toBeUndefined();
  });

  /** The one key a readonly field would otherwise swallow - a native select opens on it. */
  it('opens a locked field on Space', async () => {
    const wrapper = mountBox({ options: KINDS, editable: false, modelValue: 'radarr' });

    await wrapper.find('input').trigger('keydown', { key: ' ' });

    expect(list()).not.toBeNull();
  });

  it('emits nothing but an option value', async () => {
    const wrapper = await open(mountBox({ options: KINDS, editable: false, modelValue: 'radarr' }));

    await wrapper.find('input').trigger('keydown', { key: 'ArrowDown' });
    await wrapper.find('input').trigger('keydown', { key: 'Enter' });

    expect(wrapper.emitted('pick')?.[0]).toEqual(['sonarr']);
  });
});

describe('the keyboard', () => {
  it('walks the list and takes the highlighted row on Enter', async () => {
    const wrapper = await open(mountBox());

    await wrapper.find('input').trigger('keydown', { key: 'ArrowDown' });
    await wrapper.find('input').trigger('keydown', { key: 'Enter' });

    expect(wrapper.emitted('pick')?.[0]).toEqual(['/data/media/movies']);
    expect(list()).toBeNull();
  });

  it('opens on an arrow from a closed field', async () => {
    const wrapper = mountBox();

    await wrapper.find('input').trigger('keydown', { key: 'ArrowDown' });

    expect(list()).not.toBeNull();
  });

  /** Escape belongs to the list first; the modal behind it must not close on the same key. */
  it('closes only the list on Escape', async () => {
    const wrapper = await open(mountBox());

    await wrapper.find('input').trigger('keydown', { key: 'Escape' });

    expect(list()).toBeNull();
  });

  it('lands on the current value when the list opens', async () => {
    await open(mountBox({ modelValue: '/data/media/series' }));

    expect(document.body.querySelector('[data-active="true"]')?.textContent?.trim()).toBe(
      '/data/media/series',
    );
  });
});

describe('the wiring call sites depend on', () => {
  it('puts the test id on the input and the layout class on the wrapper', () => {
    const wrapper = mount(BaseSelect, {
      props: { modelValue: '', options: PATHS, editable: true },
      attrs: { 'data-testid': 'field', class: 'w-full' },
    });

    expect(wrapper.find('[data-testid="field"]').element.tagName).toBe('INPUT');
    expect(wrapper.classes()).toContain('w-full');
  });

  it('accepts a labelled option and shows its hint', async () => {
    await open(
      mountBox({ options: [{ value: '/data/4k', label: '/data/4k', hint: 'root folder here' }] }),
    );

    expect(rows()[0]).toContain('root folder here');
  });

  it('renders a note about what the list cannot show', async () => {
    await open(mountBox({ note: 'Folders inside a root folder are not listed' }));

    expect(list()?.textContent).toContain('Folders inside a root folder are not listed');
  });

  it('never opens while disabled', async () => {
    const wrapper = mountBox({ disabled: true });

    await wrapper.find('input').trigger('mousedown');

    expect(list()).toBeNull();
  });

  /** Teleported: the list must not be inside the dialog whose scroll container clipped it. */
  it('renders the list on the body, not inside its own wrapper', async () => {
    const wrapper = await open(mountBox());

    expect(list()).not.toBeNull();
    expect(wrapper.element.querySelector('[data-select-list]')).toBeNull();
  });

  it('takes the list away with it when it unmounts', async () => {
    const wrapper = await open(mountBox());
    wrapper.unmount();

    expect(list()).toBeNull();
  });
});

/**
 * The reason this component exists is that four dialogs each grew their own picker, and a
 * fifth kind - the native `<select>` - drew its popup in the operating system's colours.
 * Nothing stops the next one being written by hand except this.
 */
describe('the rule that keeps one picker', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcRoot = join(here, '..', '..');
  // This file and the component both have to name the things they forbid.
  const allowed = [join(here, 'BaseSelect.vue')];

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  }

  function offenders(pattern: RegExp): string[] {
    return walk(srcRoot)
      .filter((file) => file.endsWith('.vue') && !allowed.includes(file))
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => relative(srcRoot, file));
  }

  it('has no <datalist> anywhere', () => {
    expect(offenders(/<datalist[\s>]/)).toEqual([]);
  });

  it('has no native <select> anywhere', () => {
    expect(offenders(/<select[\s>]/)).toEqual([]);
  });

  it('names role="combobox" only here', () => {
    expect(offenders(/role="combobox"/)).toEqual([]);
  });
});
