<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { MEDIA_FILTER_FIELDS, parseMediaFilter } from '@fleetarr/shared';
import IconClose from '@/components/base/icons/IconClose.vue';
import IconHelp from '@/components/base/icons/IconHelp.vue';
import IconWarning from '@/components/base/icons/IconWarning.vue';
import { useMediaStore } from '@/stores/media';

/**
 * The media filter.
 *
 * A sibling of the folder filter rather than a reuse of it: there is no include/exclude
 * toggle here because negation is `NOT` inside the language, and the two help cards teach
 * different grammars. What is copied deliberately is the *shape* - parse on every keystroke,
 * apply on Enter or blur, and say nothing under the box except the reason it cannot be
 * applied. A half-typed `(tags:4k OR` must never become a fleet-wide request.
 *
 * One thing this box does that the folder one does not: a space means AND here. A list of
 * constraints conjoins where a list of patterns disjoins, and the help card says so.
 */
const media = useMediaStore();

const draft = ref(media.filter);
const showHelp = ref(false);

// Kept in step with the store, so anything that resets the filter does not leave a stale
// draft sitting in the box.
watch(
  () => media.filter,
  (value) => {
    if (value !== draft.value.trim()) draft.value = value;
  },
);

const parsed = computed(() => parseMediaFilter(draft.value));

/** Field names and what they take, straight off the registry so the card cannot drift. */
const fields = computed(() =>
  [...MEDIA_FILTER_FIELDS].map((field) => ({
    name: field.name,
    describe: field.describe,
    values: field.vocabulary === undefined ? [] : media.vocabulary[field.vocabulary].slice(0, 8),
  })),
);

const EXAMPLES: ReadonlyArray<[string, string]> = [
  ['matrix', 'the title, or the sort title, contains it'],
  ['dune year<2000', 'a space means AND - both have to hold'],
  ['tags:{4k,hdr}', 'either tag; braces expand exactly like mkdir -p'],
  ['tags:4k monitored:false', 'both, on the *same* instance'],
  ['all(monitored:false)', 'unmonitored on every instance that has it'],
  ['instances>1', 'every title the fleet holds more than once'],
  ['instance:radarr-4k NOT any(instance:radarr-hd)', 'on 4K, absent from HD'],
  ['list:"Trakt watchlist"', 'from that list - Radarr only, so Sonarr rows are undecided'],
  ['collection:*Matrix*', 'in a TMDB collection; a series has none, so those are a plain no'],
  ['size>20GB hasFile:true', '1024-based, like the sizes on screen'],
  ['root:/data/media/4k', 'one root folder; root:4k matches any with that segment'],
  ['added>-30d', 'added in the last 30 days'],
  ['status:released hasFile:false monitored:true', 'monitored, released, still missing'],
  ['tags:none', 'a known absence; quote it for a tag actually called "none"'],
];

function apply(): void {
  if (parsed.value.error !== null) return;
  void media.setFilter(draft.value.trim());
}

function clear(): void {
  draft.value = '';
  void media.setFilter('');
}

/** A value chip appends the term without applying it - completion, not a decision. */
function appendTerm(field: string, value: string): void {
  const quoted = /\s/.test(value) ? `"${value}"` : value;
  draft.value = `${draft.value.trim()} ${field}:${quoted}`.trim();
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="flex items-center gap-1.5">
      <div class="relative max-w-3xl flex-1">
        <input
          v-model="draft"
          type="text"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          data-testid="media-filter-input"
          placeholder="Filter titles: matrix, or tags:4k year<2000 NOT list:&quot;Trakt watchlist&quot;…"
          class="h-9 w-full rounded-md border bg-raised px-3 pr-16 font-mono text-sm text-ink outline-none focus:border-accent"
          :class="parsed.error === null ? 'border-line' : 'border-danger/60'"
          @keydown.enter.prevent="apply"
          @keydown.esc="clear"
          @change="apply"
        />
        <div class="absolute top-0 right-1.5 flex h-9 items-center gap-1">
          <button
            v-if="draft.length > 0"
            type="button"
            class="px-1 text-xs text-faint transition-colors hover:text-ink"
            title="Clear the filter (Esc)"
            data-testid="media-filter-clear"
            aria-label="Clear the filter"
            @click="clear"
          >
            <IconClose size="sm" />
          </button>
          <button
            type="button"
            class="px-1 text-xs transition-colors"
            :class="showHelp ? 'text-accent' : 'text-faint hover:text-ink'"
            title="Filter syntax"
            :aria-expanded="showHelp"
            aria-label="Filter syntax help"
            data-testid="media-filter-help-toggle"
            @click="showHelp = !showHelp"
          >
            <IconHelp size="sm" />
          </button>
        </div>
      </div>
    </div>

    <!-- Nothing under the box but the reason it cannot be applied. -->
    <p v-if="parsed.error !== null" class="text-[11px] text-danger" data-testid="media-filter-error">
      <IconWarning /> {{ parsed.error }} - the filter is not applied
    </p>

    <!-- A likely typo does not block: the filter applied, it just may not be what was meant. -->
    <p
      v-else-if="parsed.hints.length > 0"
      class="text-[11px] text-drift"
      data-testid="media-filter-hint"
    >
      <IconWarning /> {{ parsed.hints.join(' · ') }}
    </p>

    <div
      v-if="showHelp"
      class="rounded-md border border-line bg-raised/60 p-2 text-[11px] leading-relaxed text-muted"
      data-testid="media-filter-help"
    >
      <dl class="grid gap-x-3 gap-y-1 sm:grid-cols-[18rem_1fr]">
        <template v-for="[expression, meaning] in EXAMPLES" :key="expression">
          <dt class="font-mono text-ink">{{ expression }}</dt>
          <dd>{{ meaning }}</dd>
        </template>
      </dl>

      <p class="mt-1.5 text-faint">
        A space means <span class="text-ink">AND</span> here - the folder filter's space means
        <em>or</em>. <span class="font-mono text-ink">AND</span>,
        <span class="font-mono text-ink">OR</span> and <span class="font-mono text-ink">NOT</span>
        are uppercase, so a lowercase "and" is part of a title. Titles we could not judge -
        <span class="font-mono">list:</span> cannot be answered on Sonarr - are counted above the
        table, neither hidden nor rejected.
      </p>

      <div class="mt-2 border-t border-line pt-2">
        <p class="mb-1 text-faint">Fields, and what your fleet actually has:</p>
        <dl class="grid gap-x-3 gap-y-1 sm:grid-cols-[10rem_1fr]">
          <template v-for="field in fields" :key="field.name">
            <dt class="font-mono text-ink">{{ field.name }}</dt>
            <dd>
              {{ field.describe }}
              <span v-if="field.values.length > 0" class="ml-1 inline-flex flex-wrap gap-1">
                <button
                  v-for="value in field.values"
                  :key="value"
                  type="button"
                  data-testid="media-filter-value"
                  class="rounded border border-line px-1 font-mono text-[10px] text-faint transition-colors hover:border-accent hover:text-accent"
                  :title="`Add ${field.name}:${value} to the filter`"
                  @click="appendTerm(field.name, value)"
                >
                  {{ value }}
                </button>
              </span>
            </dd>
          </template>
        </dl>
      </div>

      <p class="mt-1.5 text-faint">
        Changing the filter clears the current selection - the rows it described are gone.
      </p>
    </div>
  </div>
</template>
