<script setup lang="ts" generic="T extends string">
import { computed, nextTick, onBeforeUnmount, ref, useAttrs, useId, watch } from 'vue';
import IconCheck from '@/components/base/icons/IconCheck.vue';
import IconDropdown from '@/components/base/icons/IconDropdown.vue';
import IconLoading from '@/components/base/icons/IconLoading.vue';
import IconSearch from '@/components/base/icons/IconSearch.vue';
import {
  filterOptions,
  highlightSegments,
  normalizeOptions,
  type SelectOption,
} from '@/components/base/select';
import { anchoredWidth, placeAnchored } from '@/lib/anchor';

/**
 * The one way to choose a value in this app.
 *
 * It used to be three: a native `<select>`, a `<datalist>`, and a picker hand-written
 * inside one dialog. The `<datalist>` filtered its options by what was already in the
 * field, so a pre-filled field offered an empty list, and the browser truncated a long
 * container path at whatever width it felt like. The native `<select>` had the subtler
 * problem: its popup is drawn by the operating system, so it was the one dropdown in a
 * dark-only app that could never match the theme, and no prop could make it search.
 *
 * So there is one list, drawn here, and the difference between the two jobs is a prop:
 *
 * - `editable` (paths, tag labels): what you type *is* the value. A path this fleet has
 *   never reported is an ordinary thing to want, and the preflight - never this list - is
 *   what says whether it exists. An unmatched query is never rejected, only unmatched.
 * - the default (an enumeration): only an option can become the value. The field is
 *   `readonly`, so typing filters without ever leaving a value nothing accepts behind.
 *
 * Search is free in both, and stays out of the way in both: the header appears only once
 * there are enough options for it to be worth reading.
 */

const props = withDefaults(
  defineProps<{
    options: readonly SelectOption<T>[];
    /** Free text is a valid value. Off means the list is the whole vocabulary. */
    editable?: boolean;
    placeholder?: string;
    disabled?: boolean;
    size?: 'sm' | 'md';
    /** Paths and other machine strings; off for prose like a tag label. */
    mono?: boolean;
    /** The options are still being fetched - said in the list, not guessed at. */
    loading?: boolean;
    /** What the caret button is called, for the tooltip and assistive tech. */
    browseLabel?: string;
    /** Said when the query matches nothing - the caller knows what typing on will do. */
    emptyHint?: string;
    /** A footnote under the rows: what this list cannot show. */
    note?: string;
    title?: string;
  }>(),
  {
    editable: false,
    placeholder: undefined,
    disabled: false,
    size: 'md',
    mono: false,
    loading: false,
    browseLabel: 'Browse the options',
    emptyHint: undefined,
    note: undefined,
    title: undefined,
  },
);

/**
 * `pick` is a choice from the list; `enter` is Enter on a field with no row highlighted.
 * A caller that treats the typed text as a submission (the tag dialog adds a chip) needs
 * to tell those apart from an ordinary keystroke, and neither is inferable from the model.
 */
const emit = defineEmits<{ pick: [value: T]; enter: [value: string] }>();

/**
 * No `default`: a generic model with one makes `vue-tsc` emit two unrelated `T`s, and the
 * component reads `''` for an unset value in the two places that care anyway.
 */
const model = defineModel<T>();

/** The current value as a string, which is all the field and the comparisons need. */
const current = computed<string>(() => model.value ?? '');

/**
 * Below this, the search header is noise: a two-option kind picker does not need to be
 * told it can be narrowed. An editable field always shows it, because there the header is
 * also where the count of what you are typing against lives.
 */
const SEARCH_THRESHOLD = 8;
/** Wide enough for a container path, so a list is never narrower than its contents. */
const PREFERRED_WIDTH = 384;

const listId = useId();
const open = ref(false);
/**
 * What has been typed since the list was opened, or null while it is showing everything.
 * The distinction is the whole reason this is not a `<datalist>`: opening a pre-filled
 * field has to show every option, not the one already in it.
 */
const query = ref<string | null>(null);
const highlight = ref(0);
const anchorRef = ref<HTMLElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const floating = ref<{ left: number; top: number; width: number } | null>(null);

const items = computed(() => normalizeOptions(props.options));
const needle = computed(() => query.value ?? '');
const matches = computed(() => filterOptions(items.value, needle.value));
const searchable = computed(() => props.editable || items.value.length > SEARCH_THRESHOLD);

/**
 * A field you cannot type into at all: a short fixed list, where there is nothing to
 * search for. It matters that this is the *only* `readonly` case - the attribute stops a
 * browser from firing `input` at all, so a searchable field carrying it would render a
 * search header over a box that silently ignored every key.
 */
const locked = computed(() => !props.editable && !searchable.value);

/** An enumeration shows its label; an editable field shows the raw value, which is the value. */
const shown = computed<string>(() => {
  if (props.editable) return current.value;
  return items.value.find((item) => item.value === current.value)?.label ?? current.value;
});

const emptyMessage = computed(
  () =>
    props.emptyHint ??
    (props.editable
      ? 'Nothing matches - what you type is used as it is'
      : 'Nothing matches that search'),
);

const SIZES = {
  sm: { field: 'px-2 py-1 pr-7 text-xs', caret: 'w-6', row: 'px-2 py-1 text-[11px]' },
  md: { field: 'px-3 py-2 pr-9 text-sm', caret: 'w-8', row: 'px-3 py-1.5 text-xs' },
} as const;

const attrs = useAttrs();
defineOptions({ inheritAttrs: false });

/**
 * Layout classes belong on the wrapper - callers pass `w-full` and `flex-1`, and on the
 * anchor of a teleported popup those are the only thing holding the shape. Everything else
 * (`data-testid`, `id`, `name`) is about the field, which is the node tests query and
 * assistive tech reads. Same split as `BaseCheckbox`.
 */
const inputAttrs = computed<Record<string, unknown>>(() => {
  const rest: Record<string, unknown> = { ...attrs };
  delete rest.class;
  delete rest.style;
  return rest;
});

function optionId(index: number): string {
  return `${listId}-option-${String(index)}`;
}

/**
 * Measured from the field, every time the list changes shape.
 *
 * The popup is teleported to the body, so it is no longer clipped by the dialog's scroll
 * container - and no longer positioned by it either, which is what this replaces.
 */
function place(): void {
  const anchor = anchorRef.value;
  if (anchor === null) return;

  const rect = anchor.getBoundingClientRect();
  const width = anchoredWidth(rect.width, PREFERRED_WIDTH);
  const height = listRef.value?.getBoundingClientRect().height ?? 0;
  const at = placeAnchored(
    { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
    { width, height },
  );

  floating.value = { ...at, width };
}

/**
 * Re-placed on scroll rather than closed.
 *
 * The hover cards close instead, because a card that followed a chip it no longer points
 * at would be lying about which chip it belongs to. A list belongs to a field the user is
 * still typing in, and one that vanished on a stray wheel nudge would be worse than one
 * that follows. Capturing, because a dialog is its own scroll container.
 */
function onViewportChange(): void {
  if (open.value) place();
}

function listen(active: boolean): void {
  const method = active ? window.addEventListener : window.removeEventListener;
  method('scroll', onViewportChange, true);
  method('resize', onViewportChange);
}

watch(open, (isOpen) => {
  listen(isOpen);
  if (isOpen) void nextTick(place);
  else floating.value = null;
});

onBeforeUnmount(() => listen(false));

/** Keep the highlighted row on screen; a fleet's folder list is longer than the popup. */
watch([highlight, matches], () => {
  void nextTick(() => {
    place();
    const row = listRef.value?.querySelector('[data-active="true"]');
    if (row instanceof HTMLElement && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  });
});

/** Opening lands on the current value when it is in the list, so the popup shows where you are. */
function show(): void {
  if (props.disabled) return;
  open.value = true;
  query.value = null;
  const at = matches.value.findIndex((item) => item.value === current.value);
  highlight.value = at === -1 ? 0 : at;
}

function toggle(): void {
  if (open.value) open.value = false;
  else show();
}

/** Clicking an open field is a caret move, not a request to drop the query. */
function onFieldMousedown(): void {
  if (!open.value) show();
}

/**
 * Typing narrows in both modes; only an editable field keeps what was typed as the value.
 * That is the whole difference between them - an enumeration searches exactly as freely,
 * it just cannot end up holding a value nothing in the list accepts.
 */
function onInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  query.value = value;
  open.value = true;
  highlight.value = 0;
  if (props.editable) model.value = value as T;
}

function pick(value: T): void {
  model.value = value;
  open.value = false;
  query.value = null;
  emit('pick', value);
}

/** Arrows walk the list, Enter takes the highlighted row, Escape closes only the list. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) {
    // Stopped, or the modal behind this closes on the keystroke that meant "close the list".
    event.stopPropagation();
    open.value = false;
    return;
  }
  if (event.key === 'Tab') {
    open.value = false;
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!open.value) {
      show();
      return;
    }
    const count = matches.value.length;
    if (count > 0) {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      highlight.value = (highlight.value + step + count) % count;
    }
    return;
  }
  if ((event.key === 'Home' || event.key === 'End') && open.value && matches.value.length > 0) {
    event.preventDefault();
    highlight.value = event.key === 'Home' ? 0 : matches.value.length - 1;
    return;
  }
  if (event.key === ' ' && locked.value && !open.value) {
    // The one key a locked field would otherwise swallow: Space opens a native select.
    event.preventDefault();
    show();
    return;
  }
  if (event.key === 'Enter') {
    const chosen = open.value ? matches.value[highlight.value] : undefined;
    event.preventDefault();
    if (chosen === undefined) {
      open.value = false;
      if (props.editable) emit('enter', current.value);
    } else {
      pick(chosen.value);
    }
  }
}

/**
 * Closing drops the query, which is what restores an enumeration's label: the field shows
 * `shown`, and with no query there is nothing left of what was typed at it.
 */
function close(): void {
  open.value = false;
  query.value = null;
}
</script>

<template>
  <div ref="anchorRef" class="relative" :class="attrs.class">
    <input
      v-bind="inputAttrs"
      :value="open && query !== null ? query : shown"
      type="text"
      role="combobox"
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="open && matches.length > 0 ? optionId(highlight) : undefined"
      :readonly="locked"
      :disabled="props.disabled"
      :placeholder="props.placeholder"
      :title="props.title ?? shown"
      class="w-full rounded-md border border-line bg-raised text-ink outline-none transition-colors focus:border-accent disabled:cursor-not-allowed disabled:opacity-40"
      :class="[
        SIZES[props.size].field,
        props.mono ? 'font-mono' : '',
        locked ? 'cursor-pointer' : '',
      ]"
      @input="onInput"
      @keydown="onKeydown"
      @mousedown="onFieldMousedown()"
      @blur="close()"
    />

    <button
      type="button"
      tabindex="-1"
      :disabled="props.disabled"
      class="absolute inset-y-0 right-0 flex items-center justify-center transition-colors disabled:opacity-40"
      :class="[SIZES[props.size].caret, open ? 'text-accent' : 'text-faint hover:text-ink']"
      :aria-expanded="open"
      :aria-label="props.browseLabel"
      :title="props.browseLabel"
      data-select-toggle
      @mousedown.prevent="toggle()"
    >
      <IconDropdown size="sm" />
    </button>

    <!--
      Teleported and positioned `fixed`, like the hover cards: a dialog's backdrop is its
      own scroll container, so an absolutely positioned list near the bottom of a tall form
      stretched that scroll region instead of floating over it. `z-50` puts it with the
      cards, above the modal it opens from by body order, and below the toasts.
    -->
    <Teleport to="body">
      <div
        v-if="open"
        :id="listId"
        ref="listRef"
        role="listbox"
        class="fixed z-50 overflow-hidden rounded-md border border-line-strong bg-surface shadow-xl"
        :style="{
          left: `${String(floating?.left ?? 0)}px`,
          top: `${String(floating?.top ?? 0)}px`,
          width: `${String(floating?.width ?? 0)}px`,
          visibility: floating === null ? 'hidden' : 'visible',
        }"
        data-select-list
      >
        <p
          v-if="searchable || props.loading"
          class="flex items-center gap-1.5 border-b border-line px-2.5 py-1 text-[10px] text-faint"
        >
          <IconLoading v-if="props.loading" size="xs" />
          <IconSearch v-else size="xs" />
          <span v-if="props.loading">reading folders…</span>
          <span v-else-if="needle.trim().length > 0">
            {{ matches.length }} of {{ items.length }} match "{{ needle.trim() }}"
          </span>
          <span v-else-if="props.editable">
            {{ items.length }} option(s) - type to narrow, any word, any order
          </span>
          <span v-else>{{ items.length }} option(s) - type to narrow</span>
        </p>

        <ul class="max-h-64 overflow-y-auto py-1">
          <li
            v-for="(item, index) in matches"
            :id="optionId(index)"
            :key="item.value"
            role="option"
            :aria-selected="item.value === current"
            :data-active="index === highlight"
            class="flex cursor-pointer items-start gap-2"
            :class="[
              SIZES[props.size].row,
              index === highlight ? 'bg-raised' : '',
              props.mono ? 'font-mono' : '',
            ]"
            @mouseenter="highlight = index"
            @mousedown.prevent="pick(item.value)"
          >
            <IconCheck
              size="xs"
              class="mt-0.5 shrink-0"
              :class="item.value === current ? 'text-accent' : 'invisible'"
            />
            <span class="min-w-0 flex-1 break-all">
              <span
                v-for="(segment, at) in highlightSegments(item.label, needle)"
                :key="at"
                :class="segment.match ? 'rounded-sm bg-accent/20 text-ink' : 'text-muted'"
              >{{ segment.text }}</span>
              <span v-if="item.hint !== null" class="ml-1.5 text-faint">{{ item.hint }}</span>
            </span>
          </li>

          <li v-if="matches.length === 0" class="px-3 py-1.5 text-[11px] text-faint">
            {{ emptyMessage }}
          </li>
        </ul>

        <p v-if="props.note !== undefined" class="border-t border-line px-2.5 py-1 text-[10px] text-faint">
          {{ props.note }}
        </p>
      </div>
    </Teleport>
  </div>
</template>
