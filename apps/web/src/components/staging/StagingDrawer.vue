<script setup lang="ts">
import { computed, ref } from 'vue';
import BaseButton from '@/components/base/BaseButton.vue';
import BaseInstanceBadge from '@/components/base/BaseInstanceBadge.vue';
import BaseSelect from '@/components/base/BaseSelect.vue';
import type { SelectOption } from '@/components/base/select';
import ImpactSummary from '@/components/staging/ImpactSummary.vue';
import StagedOperationRow from '@/components/staging/StagedOperationRow.vue';
import { useQueueStore } from '@/stores/queue';
import { useUiStore } from '@/stores/ui';
import IconCaretDown from '@/components/base/icons/IconCaretDown.vue';
import IconCaretUp from '@/components/base/icons/IconCaretUp.vue';

type Grouping = 'instance' | 'sequence';
type OnError = 'pause' | 'continue' | 'abort';

const ON_ERROR_OPTIONS: readonly SelectOption<OnError>[] = [
  { value: 'pause', label: 'halt the queue' },
  { value: 'continue', label: 'keep going' },
  { value: 'abort', label: 'abort everything' },
];

const queue = useQueueStore();
const ui = useUiStore();

const grouping = ref<Grouping>('sequence');
const onError = ref<OnError>('pause');

const hasStaged = computed(() => queue.staged.length > 0);
const positions = computed(
  () => new Map(queue.executionOrder.map((item, index) => [item.id, index + 1])),
);

function applyAll(): void {
  void queue.start(onError.value);
}
</script>

<template>
  <section
    class="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-overlay/95 backdrop-blur"
    :class="ui.drawerOpen ? 'shadow-[0_-8px_30px_rgba(0,0,0,0.45)]' : ''"
  >
    <header class="flex flex-wrap items-center gap-3 px-4 py-2.5">
      <button
        type="button"
        class="flex items-center gap-2 text-muted transition-colors hover:text-ink"
        :aria-expanded="ui.drawerOpen"
        @click="ui.toggleDrawer()"
      >
        <!-- Solid: the `▼`/`▲` these replaced are solid, and a hairline chevron
             disappears against the drawer chrome at this size. -->
        <IconCaretDown v-if="ui.drawerOpen" size="sm" variant="solid" />
        <IconCaretUp v-else size="sm" variant="solid" />
        <span class="text-xs font-semibold tracking-wide uppercase">Pending fleet changes</span>
        <span
          class="rounded-full border px-2 py-0.5 font-mono text-[11px]"
          :class="
            hasStaged
              ? 'border-staged/50 bg-staged/10 text-staged'
              : 'border-line bg-raised text-faint'
          "
        >
          {{ queue.staged.length }}
        </span>
      </button>

      <div class="hidden min-w-0 flex-1 sm:block">
        <ImpactSummary />
      </div>

      <div class="ml-auto flex items-center gap-2">
        <label class="hidden items-center gap-1.5 text-[11px] text-muted md:flex">
          on failure
          <BaseSelect v-model="onError" :options="ON_ERROR_OPTIONS" size="sm" />
        </label>
        <BaseButton
          v-if="hasStaged"
          size="sm"
          variant="ghost"
          :disabled="queue.busy"
          @click="queue.discardAll()"
        >
          Discard all
        </BaseButton>
        <BaseButton
          size="sm"
          variant="primary"
          :disabled="!hasStaged || queue.busy || queue.isRunning"
          :loading="queue.busy"
          title="Execute every staged operation in order"
          @click="applyAll()"
        >
          Apply All
        </BaseButton>
      </div>
    </header>

    <div v-if="ui.drawerOpen" class="max-h-[45vh] overflow-y-auto border-t border-line px-4 py-3">
      <div class="mb-3 flex flex-wrap items-center gap-2 sm:hidden">
        <ImpactSummary />
      </div>

      <div class="mb-3 flex items-center gap-2">
        <div class="flex rounded-md border border-line p-0.5 text-[11px]">
          <button
            v-for="mode in (['sequence', 'instance'] as Grouping[])"
            :key="mode"
            type="button"
            class="rounded px-2 py-1 transition-colors"
            :class="grouping === mode ? 'bg-raised text-ink' : 'text-muted hover:text-ink'"
            @click="grouping = mode"
          >
            {{ mode === 'sequence' ? 'Execution order' : 'By instance' }}
          </button>
        </div>
        <span v-if="queue.finished.length > 0" class="ml-auto">
          <BaseButton size="sm" variant="ghost" @click="queue.clearFinished()">
            Clear {{ queue.finished.length }} finished
          </BaseButton>
        </span>
      </div>

      <p v-if="!hasStaged" class="py-6 text-center text-xs text-faint">
        Nothing staged. Changes you make in the fleet views land here first - nothing is sent to
        Radarr or Sonarr until you press Apply All.
      </p>

      <ul v-else-if="grouping === 'sequence'" class="space-y-1.5">
        <StagedOperationRow
          v-for="item in queue.executionOrder"
          :key="item.id"
          :item="item"
          :position="positions.get(item.id) ?? null"
          @remove="queue.removeItem(item.id)"
          @retry="queue.retryItem(item.id)"
          @up="queue.move(item.id, -1)"
          @down="queue.move(item.id, 1)"
        />
      </ul>

      <div v-else class="space-y-4">
        <div v-for="group in queue.groupedByInstance" :key="group.instanceId">
          <h3 class="mb-1.5 flex items-center gap-2 text-[11px] font-semibold text-muted">
            <BaseInstanceBadge :name="group.instance === null ? null : group.label" tone="muted" />
            {{ group.label }}
            <span class="text-faint">· {{ group.items.length }} operation(s)</span>
          </h3>
          <ul class="space-y-1.5">
            <StagedOperationRow
              v-for="item in group.items"
              :key="item.id"
              :item="item"
              :position="positions.get(item.id) ?? null"
              @remove="queue.removeItem(item.id)"
              @retry="queue.retryItem(item.id)"
              @up="queue.move(item.id, -1)"
              @down="queue.move(item.id, 1)"
            />
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>
