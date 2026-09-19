<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { FsPreflight, PathNode } from '@fleetarr/shared';
import BaseButton from '@/components/base/BaseButton.vue';
import BaseCheckbox from '@/components/base/BaseCheckbox.vue';
import BaseModal from '@/components/base/BaseModal.vue';
import IconError from '@/components/base/icons/IconError.vue';
import IconWarning from '@/components/base/icons/IconWarning.vue';
import {
  assumeResolved,
  disableListTargets,
  needsForce as forceStillNeeded,
  needsImportListBridge,
  needsRootFolderBridge,
  unassignTargets,
} from '@/lib/delete-bridge';
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
const props = defineProps<{
  targets: readonly PathNode[];
  /**
   * Selected folders a target's recursive delete will take along.
   *
   * Passed in rather than derived: `targets` has already had them removed, so the dialog
   * cannot see them, and it must still say they are going.
   */
  absorbed?: readonly PathNode[];
}>();
const emit = defineEmits<{ close: []; staged: [paths: string[]] }>();

const paths = usePathsStore();
const queue = useQueueStore();

const recursive = ref(false);
const force = ref(false);
/**
 * Batch-wide, like the two above: one answer for the selection, applied per folder.
 *
 * Unassigning starts **on** for the same reason it does in the single-folder dialog - a root
 * folder aimed at a deleted path helps nobody - and a folder in the batch with no root
 * folder of its own simply contributes no unassign. Disabling a list stays opt-in.
 *
 * Neither reaches an `fs.delete` payload; they only pick targets out of each folder's own
 * preflight, so a `true` that outlives its offer selects nothing and needs no reset.
 */
const bridgeRoots = ref(true);
const bridgeLists = ref(false);
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
            await paths.preflight(
              'fs.delete',
              { path: node.path, recursive: recursive.value, force: force.value },
              assumeResolved(bridgeRoots.value, bridgeLists.value),
            ),
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

/**
 * Every message at one severity, joined.
 *
 * The *Arr side is four checks rather than one, so a folder can be refused for two
 * unrelated reasons at once - and a row that names only the first would send someone to
 * fix a root folder when the media underneath was the real answer.
 */
function messagesOf(preflight: FsPreflight, status: 'blocker' | 'warning'): string | null {
  const messages = preflight.checks
    .filter((check) => check.status === status)
    .map((check) => check.message);
  return messages.length === 0 ? null : messages.join(' | ');
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
      // Every reason, not the first: the *Arr side is four checks now, so a folder that
      // both roots an instance and holds its media would otherwise confess to only one.
      blocker: messagesOf(preflight, 'blocker'),
      warning: messagesOf(preflight, 'warning'),
      size: preflight.measurement?.sizeOnDisk ?? null,
      files: preflight.measurement?.fileCount ?? null,
    };
  }),
);

const preflights = computed(() =>
  rows.value
    .map((row) => row.preflight)
    .filter((preflight): preflight is FsPreflight => preflight !== undefined && preflight !== 'error'),
);

const stageable = computed(() => rows.value.filter((row) => row.blocker === null));

/** Folders a parent's recursive delete will take along, named rather than silently dropped. */
const absorbed = computed(() =>
  props.targets.filter((node) =>
    props.targets.some((other) => other !== node && node.path.startsWith(`${other.path}/`)),
  ),
);
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

/**
 * The *Arr questions, asked once for the batch.
 *
 * A bridge box offers to clear what a staged operation can; `force` is what is left when
 * nothing can. Each is answered per folder when the batch is staged - a folder with no root
 * folder of its own contributes no unassign - so one checkbox never acts on a folder the
 * preflight did not raise it for.
 */
const canUnassign = computed(() => preflights.value.some(needsRootFolderBridge));
const canDisableLists = computed(() => preflights.value.some(needsImportListBridge));
const needsForce = computed(() => preflights.value.some(forceStillNeeded));

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
  await queue.stageFolderDeletions(
    stageable.value.map((row) => {
      const preflight = row.preflight === undefined || row.preflight === 'error' ? null : row.preflight;
      return {
        path: row.node.path,
        recursive: recursive.value,
        force: force.value,
        unassign: bridgeRoots.value
          ? unassignTargets(preflight).map((target) => ({
              instanceId: target.instanceId,
              rootFolderId: target.rootFolderId,
              path: target.path,
            }))
          : [],
        disableLists: bridgeLists.value
          ? disableListTargets(preflight).map((target) => ({
              instanceId: target.instanceId,
              importListId: target.importListId,
            }))
          : [],
      };
    }),
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

watch([recursive, force, bridgeRoots, bridgeLists], () => void check());
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

      <!--
        The offers come before the override: each stages the *Arr change in front of its
        folder's delete, so the guard is satisfied rather than overruled, and ticking one
        can take the force box away entirely.
      -->
      <label v-if="canUnassign" class="flex items-start gap-2 text-xs text-muted">
        <BaseCheckbox v-model="bridgeRoots" data-testid="bulk-delete-unassign" class="mt-0.5" />
        <span>
          <span class="font-medium text-ink">Also unassign the root folders first</span>
          <span class="block text-[11px]">
            Each folder's own root folder registrations are removed from their instances
            before it is deleted. Folders that have none are unaffected.
          </span>
        </span>
      </label>

      <label v-if="canDisableLists" class="flex items-start gap-2 text-xs text-muted">
        <BaseCheckbox v-model="bridgeLists" data-testid="bulk-delete-disable-lists" class="mt-0.5" />
        <span>
          <span class="font-medium text-ink">Also disable the import lists that fill them</span>
          <span class="block text-[11px]">
            Otherwise the next sync recreates the folder each list is aimed at.
          </span>
        </span>
      </label>

      <label v-if="needsForce" class="flex items-start gap-2 text-xs text-muted">
        <BaseCheckbox v-model="force" data-testid="bulk-delete-force" tone="danger" class="mt-0.5" />
        <span>
          <span class="font-medium text-ink">Delete anyway</span>
          <span class="block text-[11px]">
            For what nothing staged here can fix - tracked media, or an instance that did not
            answer. Leaves those instances pointing at paths that no longer exist.
          </span>
        </span>
      </label>

      <!--
        A selected folder inside another selected folder is dropped, because the parent's
        recursive delete takes it along - but dropping it silently would leave the batch
        describing fewer folders than it removes.
      -->
      <p v-if="absorbed.length > 0" class="text-[11px] text-drift" data-testid="delete-absorbed">
        {{ absorbed.length }} selected folder(s) sit inside another selection and are not listed
        separately - they go with its recursive delete:
        {{ absorbed.map((node) => node.path).join(', ') }}
      </p>

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
