<script setup lang="ts">
import { computed, ref } from 'vue';
import BaseButton from '@/components/base/BaseButton.vue';
import BaseSelect from '@/components/base/BaseSelect.vue';
import BaseModal from '@/components/base/BaseModal.vue';
import BaseInstanceBadge from '@/components/base/BaseInstanceBadge.vue';
import IconClose from '@/components/base/icons/IconClose.vue';
import IconCreate from '@/components/base/icons/IconCreate.vue';
import IconWarning from '@/components/base/icons/IconWarning.vue';
import { useMediaStore } from '@/stores/media';
import { useQueueStore, type MediaTagTarget, type MediaTarget } from '@/stores/queue';

type Mode = 'add' | 'remove' | 'replace';

const props = defineProps<{ targets: readonly MediaTarget[] }>();
const emit = defineEmits<{ close: [] }>();

const media = useMediaStore();
const queue = useQueueStore();

const mode = ref<Mode>('add');
const entry = ref('');
const labels = ref<string[]>([]);

const MODES: ReadonlyArray<{ value: Mode; label: string; hint: string }> = [
  { value: 'add', label: 'add', hint: 'Leave the existing tags alone' },
  { value: 'remove', label: 'remove', hint: 'Take these off, leave the rest' },
  { value: 'replace', label: 'replace', hint: 'End up with exactly these and nothing else' },
];

/** Every label anywhere in range, so the datalist offers what actually exists. */
const known = computed(() => {
  const all = new Set<string>();
  for (const target of props.targets) {
    for (const tag of media.columnFor(target.instanceId)?.tags ?? []) all.add(tag.label);
  }
  return [...all].sort((left, right) => left.localeCompare(right));
});

/**
 * What each instance can do with the chosen labels.
 *
 * The load-bearing part of this dialog: the same label is a **different id** on every
 * instance, and may not exist at all. Adding one nobody has means creating it there first;
 * removing one nobody has is simply nothing to do, and that instance drops out.
 */
const resolution = computed(() =>
  props.targets.map((target) => {
    const column = media.columnFor(target.instanceId);
    const byLabel = new Map((column?.tags ?? []).map((tag) => [tag.label.toLowerCase(), tag.id]));

    const present = labels.value.filter((label) => byLabel.has(label.toLowerCase()));
    const missing = labels.value.filter((label) => !byLabel.has(label.toLowerCase()));

    return {
      instanceId: target.instanceId,
      name: column?.name ?? `instance ${String(target.instanceId)}`,
      kind: column?.kind ?? 'radarr',
      items: target.mediaIds.length,
      mediaIds: target.mediaIds,
      tagIds: present.map((label) => byLabel.get(label.toLowerCase()) ?? 0),
      present,
      missing,
    };
  }),
);

/** In replace mode, tags nobody named that are about to disappear. */
const losing = computed(() => {
  if (mode.value !== 'replace') return [];
  const keeping = new Set(labels.value.map((label) => label.toLowerCase()));
  const lost = new Set<string>();
  for (const row of media.selectedRows) {
    for (const facet of row.facets) {
      if (!facet.matched) continue;
      for (const tag of facet.tags) if (!keeping.has(tag.toLowerCase())) lost.add(tag);
    }
  }
  return [...lost].sort((left, right) => left.localeCompare(right));
});

const participating = computed(() =>
  resolution.value.filter((row) =>
    mode.value === 'remove' ? row.present.length > 0 : labels.value.length > 0 || mode.value === 'replace',
  ),
);

const valid = computed(
  () => participating.value.length > 0 && (labels.value.length > 0 || mode.value === 'replace'),
);

const totalItems = computed(() =>
  participating.value.reduce((sum, row) => sum + row.items, 0),
);

function addLabel(): void {
  const value = entry.value.trim();
  if (value.length === 0 || labels.value.includes(value)) {
    entry.value = '';
    return;
  }
  labels.value = [...labels.value, value];
  entry.value = '';
}

function removeLabel(label: string): void {
  labels.value = labels.value.filter((entryLabel) => entryLabel !== label);
}

async function confirm(): Promise<void> {
  const targets: MediaTagTarget[] = participating.value.map((row) => ({
    instanceId: row.instanceId,
    mediaIds: row.mediaIds,
    tagIds: row.tagIds,
    // Removing cannot create: a label an instance does not have is nothing to take away.
    missingLabels: mode.value === 'remove' ? [] : row.missing,
  }));

  await queue.applyMediaTags({ mode: mode.value, targets });
  emit('close');
}
</script>

<template>
  <BaseModal
    title="Tag media across the fleet"
    :subtitle="`${String(totalItems)} item(s) on ${String(participating.length)} instance(s)`"
    width="lg"
    @close="emit('close')"
  >
    <div class="space-y-4">
      <div
        class="flex h-9 w-fit items-center rounded-md border border-line bg-raised p-0.5"
        role="group"
        aria-label="Tag mode"
      >
        <button
          v-for="option in MODES"
          :key="option.value"
          type="button"
          class="h-full rounded px-2.5 text-[11px] font-medium transition-colors"
          :class="
            mode === option.value
              ? option.value === 'replace'
                ? 'bg-danger/20 text-danger'
                : 'bg-accent/15 text-accent'
              : 'text-faint hover:text-ink'
          "
          :aria-pressed="mode === option.value"
          :data-testid="`tag-mode-${option.value}`"
          :title="option.hint"
          @click="mode = option.value"
        >
          {{ option.label }}
        </button>
      </div>

      <div>
        <label class="mb-1 block text-xs text-muted" for="tag-label-input">Tags</label>
        <BaseSelect
          editable
          id="tag-label-input"
          v-model="entry"
          :options="known"
          class="w-full"
          data-testid="tag-label-input"
          placeholder="type a label and press Enter, or pick one that exists"
          browse-label="Labels that exist on the instances in range"
          empty-hint="No instance in range has that label - adding it creates it there"
          @enter="addLabel"
          @pick="addLabel"
        />
      </div>

      <div v-if="labels.length > 0" class="flex flex-wrap gap-1">
        <span
          v-for="label in labels"
          :key="label"
          data-testid="tag-chip"
          class="flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[11px] text-ink"
        >
          {{ label }}
          <button type="button" :aria-label="`Remove ${label}`" @click="removeLabel(label)">
            <IconClose size="xs" />
          </button>
        </span>
      </div>

      <div v-if="labels.length > 0">
        <p class="mb-1.5 text-xs text-muted">
          The same label is a different id on every instance - here is what each one will do
        </p>
        <ul class="space-y-1">
          <li
            v-for="row in resolution"
            :key="row.instanceId"
            data-testid="tag-resolution"
            class="flex items-center justify-between gap-3 rounded border border-line bg-raised/60 px-2.5 py-1.5 text-xs"
          >
            <span class="flex items-center gap-2">
              <BaseInstanceBadge :name="row.name" :kind="row.kind" size="sm" />
              {{ row.name }}
              <span class="text-[10px] text-faint">{{ row.items }} item(s)</span>
            </span>
            <span class="flex flex-wrap items-center justify-end gap-1.5 text-[11px]">
              <span v-if="row.present.length > 0" class="text-muted">
                {{ row.present.join(', ') }}
              </span>
              <span
                v-if="mode !== 'remove' && row.missing.length > 0"
                class="rounded border border-sync/40 bg-sync/10 px-1.5 py-0.5 text-sync"
                title="This label does not exist here yet - it is created first, and the tag edit waits on it"
              >
                <IconCreate size="xs" /> creating {{ row.missing.join(', ') }}
              </span>
              <span
                v-if="mode === 'remove' && row.present.length === 0"
                class="text-faint"
                title="Nothing to take away here"
              >
                does not exist here - nothing to remove
              </span>
            </span>
          </li>
        </ul>
      </div>

      <div
        v-if="mode === 'replace'"
        class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2.5 text-xs"
      >
        <p class="font-medium text-danger">
          <IconWarning /> Replace removes every tag you did not name
        </p>
        <p class="mt-1 leading-relaxed text-muted">
          <template v-if="losing.length > 0">
            {{ totalItems }} item(s) currently carry
            <span class="text-ink">{{ losing.join(', ') }}</span
            >. Those go.
          </template>
          <template v-else-if="labels.length === 0">
            With no labels named, this clears every tag off {{ totalItems }} item(s).
          </template>
          <template v-else>The selected items carry no other tags, so nothing else is lost.</template>
        </p>
      </div>
    </div>

    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">Cancel</BaseButton>
      <BaseButton
        :variant="mode === 'replace' ? 'danger' : 'primary'"
        :disabled="!valid"
        :loading="queue.busy"
        data-testid="tag-confirm"
        @click="confirm()"
      >
        Stage {{ mode }} on {{ totalItems }} item(s)
      </BaseButton>
    </template>
  </BaseModal>
</template>
