<script setup lang="ts">
import { computed, ref } from 'vue';
import BaseButton from '@/components/base/BaseButton.vue';
import BaseModal from '@/components/base/BaseModal.vue';
import { useInstancesStore } from '@/stores/instances';
import { useMatrixStore } from '@/stores/matrix';
import { useQueueStore, type TagTarget } from '@/stores/queue';
import IconWarning from '@/components/base/icons/IconWarning.vue';
import BaseCheckbox from '@/components/base/BaseCheckbox.vue';

const props = defineProps<{ targets: readonly TagTarget[] }>();
const emit = defineEmits<{ close: [] }>();

const instances = useInstancesStore();
const matrix = useMatrixStore();
const queue = useQueueStore();

const detach = ref(true);

const labels = computed(() => [...new Set(props.targets.map((target) => target.label))]);

const attachedCounts = computed(() =>
  props.targets.map((target) => {
    const row = matrix.tagRows.find((entry) => entry.label === target.label);
    const cell = row?.cells.find((entry) => entry.instanceId === target.instanceId);
    return {
      instanceId: target.instanceId,
      label: target.label,
      mediaCount: cell?.mediaCount ?? 0,
      otherUses: cell?.otherUses ?? 0,
      collectionCount: cell?.collectionCount ?? 0,
      collectionsKnown: cell?.collectionsKnown ?? false,
    };
  }),
);

const totalAttached = computed(() =>
  attachedCounts.value.reduce((sum, entry) => sum + entry.mediaCount, 0),
);

const totalCollections = computed(() =>
  attachedCounts.value.reduce((sum, entry) => sum + entry.collectionCount, 0),
);

/** An instance that never reported its collections cannot be said to have none. */
const collectionsUnknown = computed(() =>
  attachedCounts.value.some((entry) => !entry.collectionsKnown),
);

function nameOf(instanceId: number): string {
  return instances.byId.get(instanceId)?.name ?? `instance ${String(instanceId)}`;
}

async function confirm(): Promise<void> {
  await queue.deleteTagAcross(props.targets, detach.value, detach.value);
  emit('close');
}
</script>

<template>
  <BaseModal
    title="Delete tags across the fleet"
    :subtitle="`${props.targets.length} operation(s) on ${labels.length} distinct label(s)`"
    @close="emit('close')"
  >
    <div class="space-y-4">
      <ul class="max-h-56 space-y-1 overflow-y-auto">
        <li
          v-for="entry in attachedCounts"
          :key="`${entry.instanceId}-${entry.label}`"
          class="flex items-center justify-between rounded border border-line bg-raised/60 px-2.5 py-1.5 text-xs"
        >
          <span class="font-mono text-danger line-through">{{ entry.label }}</span>
          <span class="text-[11px] text-muted">
            {{ nameOf(entry.instanceId) }} · {{ entry.mediaCount }} media
            <span v-if="entry.otherUses > 0">· {{ entry.otherUses }} other use(s)</span>
            <span v-if="!entry.collectionsKnown">· collections unknown</span>
            <span v-else-if="entry.collectionCount > 0">
              · {{ entry.collectionCount }} collection(s)
            </span>
          </span>
        </li>
      </ul>

      <label class="flex items-start gap-2 text-xs text-muted">
        <BaseCheckbox v-model="detach" class="mt-0.5" />
        <span>
          Remove the tag from media and Radarr collections first (one extra call per instance).
          <span class="block text-[11px] text-faint">
            *Arr detaches tags implicitly on delete - doing it explicitly records exactly how many
            items and collections were touched in the audit trail.
          </span>
        </span>
      </label>

      <!--
        Stated separately from the media warning: a tag carried only by collections used to
        read as "unused" here, which is how one got deleted out from under a curated fleet.
      -->
      <p
        v-if="totalCollections > 0 || collectionsUnknown"
        class="rounded-md border border-drift/40 bg-drift/5 px-3 py-2 text-[11px] leading-relaxed text-drift"
      >
        <IconWarning />
        <template v-if="collectionsUnknown">
          At least one instance did not report its collections, so this may be carried by more
          than is listed.
        </template>
        <template v-else>
          {{ totalCollections }} Radarr collection(s) carry these tags. A collection's tag drives
          which lists and profiles apply to everything it adds.
        </template>
      </p>

      <p
        v-if="totalAttached > 0"
        class="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-[11px] leading-relaxed text-danger"
      >
        <IconWarning /> These tags are attached to {{ totalAttached }} media item(s) across the fleet. Deleting
        them removes the tag from those items - any filter, quality profile or list rule that keys
        on the tag stops matching.
      </p>
    </div>

    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">Cancel</BaseButton>
      <BaseButton variant="danger" :loading="queue.busy" @click="confirm()">
        Stage {{ props.targets.length }} deletion(s)
      </BaseButton>
    </template>
  </BaseModal>
</template>
