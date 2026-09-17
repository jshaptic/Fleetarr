<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { FsPreflight, PathNode } from '@fleetarr/shared';
import BaseButton from '@/components/base/BaseButton.vue';
import BaseCheckbox from '@/components/base/BaseCheckbox.vue';
import BaseModal from '@/components/base/BaseModal.vue';
import IconError from '@/components/base/icons/IconError.vue';
import IconWarning from '@/components/base/icons/IconWarning.vue';
import { formatBytes } from '@/lib/format';
import { unknownColumns } from '@/lib/path-matrix';
import { usePathsStore } from '@/stores/paths';
import { useQueueStore } from '@/stores/queue';

/**
 * Delete several folders from disk in one batch.
 *
 * Every folder is preflighted on its own and says so on its own row: a selection is not a
 * single verdict, and a folder that cannot be deleted must be named rather than quietly
 * dropped from a count. Those rows are excluded from what is staged, so the batch that lands
 * in the queue is exactly the batch this dialog described.
 *
 * One `fs.delete` per folder rather than one op over a list, because that is what lets a
 * folder that has changed by the time the run reaches it fail alone.
 */
const props = defineProps<{ targets: readonly PathNode[] }>();
const emit = defineEmits<{ close: []; staged: [paths: string[]] }>();

const paths = usePathsStore();
const queue = useQueueStore();

const recursive = ref(false);
const force = ref(false);
const typed = ref('');

const results = ref<Record<string, FsPreflight | 'error'>>({});
const checking = ref(false);

const unknown = computed(() => unknownColumns(paths.columns));

async function check(): Promise<void> {
  checking.value = true;
  try {
    const answers = await Promise.all(
      props.targets.map(async (node) => {
        try {
          return [
            node.path,
            await paths.preflight('fs.delete', {
              path: node.path,
              recursive: recursive.value,
              force: force.value,
            }),
          ] as const;
        } catch {
          return [node.path, 'error' as const] as const;
        }
      }),
    );
    results.value = Object.fromEntries(answers);
  } finally {
    checking.value = false;
  }
}

interface Row {
  readonly node: PathNode;
  readonly preflight: FsPreflight | 'error' | undefined;
  readonly blocker: string | null;
  readonly warning: string | null;
  readonly size: number | null;
  readonly files: number | null;
}

const rows = computed<Row[]>(() =>
  props.targets.map((node) => {
    const preflight = results.value[node.path];
    if (preflight === undefined || preflight === 'error') {
      return {
        node,
        preflight,
        blocker: preflight === 'error' ? 'Could not be checked' : null,
        warning: null,
        size: null,
        files: null,
      };
    }
    return {
      node,
      preflight,
      blocker: preflight.checks.find((check) => check.status === 'blocker')?.message ?? null,
      warning: preflight.checks.find((check) => check.status === 'warning')?.message ?? null,
      size: preflight.measurement?.sizeOnDisk ?? null,
      files: preflight.measurement?.fileCount ?? null,
    };
  }),
);

const stageable = computed(() => rows.value.filter((row) => row.blocker === null));
const blocked = computed(() => rows.value.filter((row) => row.blocker !== null));

/**
 * Each option appears only when some folder in the selection actually needs it - the same
 * rule the single-folder dialog follows, applied across the batch.
 */
const needsRecursive = computed(() =>
  rows.value.some(
    (row) =>
      row.preflight !== undefined &&
      row.preflight !== 'error' &&
      row.preflight.checks.some(
        (check) => check.id === 'recursive_required' || check.id === 'recursive_delete',
      ),
  ),
);

const needsForce = computed(() =>
  rows.value.some(
    (row) =>
      row.preflight !== undefined &&
      row.preflight !== 'error' &&
      row.preflight.checks.some(
        (check) => check.id === 'referenced_by_arr' && check.status !== 'ok',
      ),
  ),
);

const totalSize = computed(() =>
  stageable.value.reduce((sum, row) => sum + (row.size ?? 0), 0),
);
const totalFiles = computed(() =>
  stageable.value.reduce((sum, row) => sum + (row.files ?? 0), 0),
);
const truncated = computed(() =>
  stageable.value.some(
    (row) =>
      row.preflight !== undefined &&
      row.preflight !== 'error' &&
      row.preflight.measurement?.truncated === true,
  ),
);

/** Typed back rather than clicked: the count is what the batch is, so it is what to confirm. */
const confirmed = computed(() => typed.value.trim() === String(stageable.value.length));

const valid = computed(
  () => stageable.value.length > 0 && confirmed.value && !checking.value && !queue.busy,
);

async function confirm(): Promise<void> {
  await queue.stageFsOperations(
    stageable.value.map((row) => ({
      op: 'fs.delete' as const,
      payload: { path: row.node.path, recursive: recursive.value, force: force.value },
    })),
    `the deletion of ${String(stageable.value.length)} folder(s) from disk`,
  );
  // Those folders are spoken for now: leaving them ticked invites staging them twice.
  emit('staged', stageable.value.map((row) => row.node.path));
  emit('close');
}

onMounted(() => void check());

// A hidden option must not leave a `true` in the payload it no longer explains.
watch([needsRecursive, needsForce], ([recursiveNeeded, forceNeeded]) => {
  if (!recursiveNeeded && recursive.value) recursive.value = false;
  if (!forceNeeded && force.value) force.value = false;
});

watch([recursive, force], () => void check());
</script>

<template>
  <BaseModal
    title="Delete folders from disk"
    :subtitle="`${String(props.targets.length)} folder(s) selected`"
    width="lg"
    @close="emit('close')"
  >
    <div class="space-y-4">
      <p class="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-xs leading-relaxed text-danger">
        This deletes each folder and everything under it from disk. Fleetarr has no recycle bin -
        once the queue applies these steps, the only way back is your backups.
      </p>

      <p v-if="unknown.length > 0" class="text-[11px] text-danger" data-testid="bulk-delete-unknown">
        {{ unknown.length }} instance(s) did not answer
        ({{ unknown.map((column) => column.name).join(', ') }}), so Fleetarr cannot tell whether
        they still hold media in these folders. Unknown, deliberately not "nobody" - which is why
        they need forcing below.
      </p>

      <!-- what will go -->
      <div class="rounded-lg border border-line">
        <p class="border-b border-line px-3 py-1.5 text-[11px] font-semibold text-muted">
          <span v-if="checking">Checking {{ props.targets.length }} folder(s)…</span>
          <span v-else>{{ stageable.length }} folder(s) will be deleted</span>
        </p>
        <ul class="max-h-56 divide-y divide-line overflow-y-auto">
          <li
            v-for="row in stageable"
            :key="row.node.path"
            class="flex items-start justify-between gap-3 px-3 py-1.5 text-[11px]"
            data-testid="delete-victim"
          >
            <span class="min-w-0">
              <span class="block truncate font-mono text-ink">{{ row.node.path }}</span>
              <span v-if="row.warning" class="flex gap-1.5 text-drift">
                <IconWarning size="xs" class="mt-0.5" />{{ row.warning }}
              </span>
            </span>
            <span class="shrink-0 text-muted">
              <template v-if="row.size !== null">
                {{ formatBytes(row.size) }} · {{ row.files }} file(s)
              </template>
              <template v-else-if="!checking">empty</template>
            </span>
          </li>
        </ul>
      </div>

      <!-- and what will not -->
      <div
        v-if="blocked.length > 0"
        class="rounded-lg border border-danger/40 bg-danger/5"
        data-testid="delete-blocked"
      >
        <p class="border-b border-danger/30 px-3 py-1.5 text-[11px] font-semibold text-danger">
          {{ blocked.length }} folder(s) cannot be deleted and are not part of this batch
        </p>
        <ul class="max-h-40 divide-y divide-danger/20 overflow-y-auto">
          <li v-for="row in blocked" :key="row.node.path" class="px-3 py-1.5 text-[11px]">
            <span class="block truncate font-mono text-ink">{{ row.node.path }}</span>
            <span class="flex gap-1.5 text-danger">
              <IconError size="xs" class="mt-0.5" />{{ row.blocker }}
            </span>
          </li>
        </ul>
      </div>

      <label v-if="needsRecursive" class="flex items-start gap-2 text-xs text-muted">
        <BaseCheckbox v-model="recursive" data-testid="bulk-delete-recursive" tone="danger" class="mt-0.5" />
        <span>
          <span class="font-medium text-ink">Delete contents too</span>
          <span class="block text-[11px]">Required for the folders that are not empty.</span>
        </span>
      </label>

      <label v-if="needsForce" class="flex items-start gap-2 text-xs text-muted">
        <BaseCheckbox v-model="force" data-testid="bulk-delete-force" tone="danger" class="mt-0.5" />
        <span>
          <span class="font-medium text-ink">Delete even though an instance still tracks them</span>
          <span class="block text-[11px]">
            Leaves those instances pointing at paths that no longer exist.
          </span>
        </span>
      </label>

      <p v-if="stageable.length > 0" class="text-[11px] text-muted" data-testid="delete-total">
        {{ stageable.length }} folder(s) · {{ totalFiles }} file(s) ·
        <template v-if="truncated">at least </template>{{ formatBytes(totalSize) }}
      </p>

      <label class="block">
        <span class="mb-1 block text-xs text-muted">
          Type <span class="font-mono text-ink">{{ stageable.length }}</span> to confirm how many
          folders go
        </span>
        <input
          v-model="typed"
          type="text"
          autocomplete="off"
          data-testid="bulk-delete-confirm"
          class="w-full rounded-md border border-line bg-raised px-3 py-2 font-mono text-sm text-ink outline-none focus:border-danger"
        />
      </label>

      <p class="text-[11px] leading-relaxed text-muted">
        Nothing happens now: these land in Pending Fleet Changes as one operation per folder, and
        each preflight runs again immediately before its own step executes.
      </p>
    </div>

    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">Cancel</BaseButton>
      <BaseButton
        variant="danger"
        data-testid="bulk-delete-stage"
        :disabled="!valid"
        :loading="queue.busy"
        @click="confirm()"
      >
        Stage {{ stageable.length }} deletion(s)
      </BaseButton>
    </template>
  </BaseModal>
</template>
