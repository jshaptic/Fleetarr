import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The bar never talks to the API itself, but the store it drives does.
vi.mock('@/api/media', () => ({ mediaApi: { list: vi.fn(), ids: vi.fn() } }));

const MediaFilterBar = (await import('./MediaFilterBar.vue')).default;
const { useMediaStore } = await import('@/stores/media');

/**
 * Typing, without the blur that applies it: `setValue` fires `change` in this environment,
 * and half an expression must never become a fleet-wide request.
 */
async function type(wrapper: ReturnType<typeof mount>, value: string) {
  const input = wrapper.find('[data-testid="media-filter-input"]');
  (input.element as HTMLInputElement).value = value;
  await input.trigger('input');
  return input;
}

function mountBar() {
  setActivePinia(createPinia());
  const store = useMediaStore();
  const setFilter = vi.spyOn(store, 'setFilter').mockResolvedValue();
  const wrapper = mount(MediaFilterBar);
  return { wrapper, store, setFilter };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('MediaFilterBar', () => {
  it('says nothing while an expression is half typed, and asks for nothing', async () => {
    const { wrapper, setFilter } = mountBar();

    await type(wrapper, '(tags:4k OR');

    expect(setFilter).not.toHaveBeenCalled();
    // silent until it is applied: the only thing worth saying mid-keystroke is a failure
    expect(wrapper.find('[data-testid="media-filter-error"]').exists()).toBe(true);
  });

  it('applies on Enter and on blur, and not before', async () => {
    const { wrapper, setFilter } = mountBar();

    const input = await type(wrapper, 'tags:kids');
    expect(setFilter).not.toHaveBeenCalled();

    await input.trigger('keydown.enter');
    expect(setFilter).toHaveBeenCalledWith('tags:kids');

    await type(wrapper, 'year<2000');
    await input.trigger('change');
    expect(setFilter).toHaveBeenLastCalledWith('year<2000');
  });

  it('refuses to send an expression it cannot read, and explains why', async () => {
    const { wrapper, setFilter } = mountBar();

    const input = await type(wrapper, 'year:nineteen');
    await input.trigger('keydown.enter');

    expect(setFilter).not.toHaveBeenCalled();
    const error = wrapper.find('[data-testid="media-filter-error"]').text();
    expect(error).toContain('takes a number');
    expect(error).toContain('the filter is not applied');
  });

  it('escape clears both the box and the store', async () => {
    const { wrapper, setFilter } = mountBar();

    const input = await type(wrapper, 'tags:kids');
    await input.trigger('keydown.esc');

    expect(setFilter).toHaveBeenCalledWith('');
    expect((input.element as HTMLInputElement).value).toBe('');
  });

  it('a likely typo is a hint, not a block - the filter still applies', async () => {
    const { wrapper, setFilter } = mountBar();

    const input = await type(wrapper, 'tgs:4k');
    expect(wrapper.find('[data-testid="media-filter-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="media-filter-hint"]').text()).toContain('did you mean');

    await input.trigger('keydown.enter');
    expect(setFilter).toHaveBeenCalledWith('tgs:4k');
  });

  it('the help card teaches the two things nobody can guess', async () => {
    const { wrapper } = mountBar();
    await wrapper.find('[data-testid="media-filter-help-toggle"]').trigger('click');

    const help = wrapper.find('[data-testid="media-filter-help"]').text();
    expect(help).toContain('tags:{4k,hdr}');
    expect(help).toContain('all(monitored:false)');
    // a space means AND here, unlike the folder box - and the keywords are uppercase
    expect(help).toContain('A space means');
    expect(help).toContain('are uppercase');
  });

  it('a value chip completes a term without applying it', async () => {
    const { wrapper, store, setFilter } = mountBar();
    store.vocabulary = {
      instances: [],
      tags: ['4k-remux'],
      lists: [],
      qualityProfiles: [],
      genres: [],
      certifications: [],
    collections: [],
      rootFolders: [],
    };
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-testid="media-filter-help-toggle"]').trigger('click');

    await wrapper.find('[data-testid="media-filter-value"]').trigger('click');

    const input = wrapper.find('[data-testid="media-filter-input"]');
    expect((input.element as HTMLInputElement).value).toBe('tags:4k-remux');
    expect(setFilter).not.toHaveBeenCalled();
  });
});
