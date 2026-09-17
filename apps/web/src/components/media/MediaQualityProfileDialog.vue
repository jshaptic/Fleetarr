<script setup lang="ts">
import { computed, ref } from 'vue';
import BaseButton from '@/components/base/BaseButton.vue';
import BaseModal from '@/components/base/BaseModal.vue';
import BaseSelect from '@/components/base/BaseSelect.vue';
import type { SelectOption } from '@/components/base/select';
import BaseInstanceBadge from '@/components/base/BaseInstanceBadge.vue';
import IconWarning from '@/components/base/icons/IconWarning.vue';
import { useMediaStore } from '@/stores/media';
import { useQueueStore, type MediaProfileTarget, type MediaTarget } from '@/stores/queue';

/**
 * Set a quality profile by **name**.
 *
 * Profile ids are per-instance, so the name is the only thing that can be chosen once and
 * mean the same everywhere. An instance with no profile by that name is left out and said
 * so - never given a guessed id, and never quietly dropped.
 */
const props = defineProps<{ targets: readonly MediaTarget[] }>();
const emit = defineEmits<{ close: [] }>();

const media = useMediaStore();
const queue = useQueueStore();

const names = computed(() => {
  const all = new Set<string>();
  for (const target of props.targets) {
    for (const profile of media.columnFor(target.instanceId)?.qualityProfiles ?? []) {
      all.add(profile.name);
    }
  }
  return [...all].sort((left, right) => left.localeCompare(right));
});

const chosen = ref(names.value[0] ?? '');

const options = computed<SelectOption<string>[]>(() =>
  names.value.map((name) => ({ value: name, label: name })),
);

const resolution = computed(() =>
  props.targets.map((target) => {
    const column = media.columnFor(target.instanceId);
    const profile = (column?.qualityProfiles ?? []).find((entry) => entry.name === chosen.value);
    return {
      instanceId: target.instanceId,
      name: column?.name ?? `instance ${String(target.instanceId)}`,
      kind: column?.kind ?? 'radarr',
      items: target.mediaIds.length,
      mediaIds: target.mediaIds,
      profileId: profile?.id ?? null,
    };
  }),
);

const participating = computed(() => resolution.value.filter((row) => row.profileId !== null));
const excluded = computed(() => resolution.value.filter((row) => row.profileId === null));
const totalItems = computed(() => participating.value.reduce((sum, row) => sum + row.items, 0));

async function confirm(): Promise<void> {
  const targets: MediaProfileTarget[] = participating.value.map((row) => ({
    instanceId: row.instanceId,
    mediaIds: row.mediaIds,
    qualityProfileId: row.profileId ?? 0,
  }));

  await queue.setMediaQualityProfile(targets, chosen.value);
  emit('close');
}
</script>

<template>
  <BaseModal
    title="Set quality profile"
    :subtitle="`${String(totalItems)} item(s) on ${String(participating.length)} instance(s)`"
    @close="emit('close')"
  >
    <div class="space-y-4">
      <label class="block">
        <span class="mb-1 block text-xs text-muted">Profile</span>
        <BaseSelect v-model="chosen" :options="options" data-testid="profile-select" />
        <span class="mt-1 block text-[11px] text-faint">
          Chosen by name: the id behind it differs on every instance.
        </span>
      </label>

      <ul class="space-y-1">
        <li
          v-for="row in resolution"
          :key="row.instanceId"
          data-testid="profile-resolution"
          class="flex items-center justify-between gap-3 rounded border border-line bg-raised/60 px-2.5 py-1.5 text-xs"
        >
          <span class="flex items-center gap-2">
            <BaseInstanceBadge :name="row.name" :kind="row.kind" size="sm" />
            {{ row.name }}
            <span class="text-[10px] text-faint">{{ row.items }} item(s)</span>
          </span>
          <span v-if="row.profileId !== null" class="text-[11px] text-muted">
            {{ chosen }} (id {{ row.profileId }})
          </span>
          <span v-else class="text-[11px] text-drift">
            <IconWarning /> no profile called "{{ chosen }}"
          </span>
        </li>
      </ul>

      <p v-if="excluded.length > 0" class="text-[11px] text-drift" data-testid="profile-excluded">
        {{ excluded.length }} instance(s) have no profile by that name and are left out - an id is
        never invented for them.
      </p>
    </div>

    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">Cancel</BaseButton>
      <BaseButton
        variant="primary"
        :disabled="participating.length === 0"
        :loading="queue.busy"
        data-testid="profile-confirm"
        @click="confirm()"
      >
        Stage profile on {{ totalItems }} item(s)
      </BaseButton>
    </template>
  </BaseModal>
</template>
