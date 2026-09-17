<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { FsOp, FsPreflight, NewFsQueueItem } from '@fleetarr/shared';
import BaseButton from '@/components/base/BaseButton.vue';
import BaseModal from '@/components/base/BaseModal.vue';
import { resourcesApi } from '@/api/resources';
import { basename, joinPath, parentOf, rewritePathPrefix } from '@/lib/fs-tree';
import { formatBytes } from '@/lib/format';
import { type AlignTarget } from '@/lib/path-matrix';
import { usePathsStore } from '@/stores/paths';
import { useQueueStore } from '@/stores/queue';
import IconCheck from '@/components/base/icons/IconCheck.vue';
import IconError from '@/components/base/icons/IconError.vue';
import IconWarning from '@/components/base/icons/IconWarning.vue';
import BaseCheckbox from '@/components/base/BaseCheckbox.vue';
import BaseSelect from '@/components/base/BaseSelect.vue';

export type { AlignTarget };

/**
 * What this dialog still does to a folder that exists.
 *
 * Creating one left: it is `NewFoldersDialog` now, one box taking `mkdir -p` syntax for the
 * whole shape at once, rather than a per-row dialog that could only ever make one.
 */
export type DiskOperation = 'rename' | 'move' | 'delete';

/**
 * An instance whose root folder is this folder, or lives under it, and can therefore follow
 * a rename.
 *
 * This is what the separate "align" dialog used to be. Renaming a root folder on disk and
 * re-pointing the instances that root at it were two buttons asking the same first question
 * - the new name - and differing only in whether the *Arr half happened; a rename that
 * skipped it left the media missing, so it was never really an independent choice. One
 * dialog, with the *Arr half as instance checkboxes: the disk step is always staged first
 * and everything else hangs off it.
 *
 * A parent of root folders belongs here too. Renaming it on disk without rewriting the
 * nested registrations is how *Arr ends up with unavailable paths. An individual *media*
 * folder still gets no align chain - `media.moveRootFolder` only sets `rootFolderPath` and
 * `media.refresh` re-reads the stored path, so nothing in the operation set can make *Arr
 * adopt a renamed media folder. Those instances are named in the dangling warning instead.
 */

const props = withDefaults(
  defineProps<{
    operation: DiskOperation;
    target: string;
    /**
     * Instances with media at or under `target`. Optional so every existing call site
     * keeps working; when given, a relocation says out loud what it would leave behind.
     */
    trackedBy?: ReadonlyArray<{ instanceId: number; name: string; mediaCount: number }>;
    /** Instances rooting at or under `target` - the ones a rename can carry along. */
    alignTargets?: readonly AlignTarget[];
  }>(),
  { trackedBy: () => [], alignTargets: () => [] },
);
const emit = defineEmits<{ close: [] }>();

const fs = usePathsStore();
const queue = useQueueStore();

const parent = computed(() => parentOf(props.target) ?? props.target);

const name = ref(basename(props.target));
const destination = ref(props.operation === 'move' ? (parentOf(props.target) ?? '') : '');
const recursive = ref(false);
const force = ref(false);
const confirmation = ref('');

const preflight = ref<FsPreflight | null>(null);
const checking = ref(false);

/** Only a rename can be followed: a move crosses into a directory *Arr may not root at. */
const alignable = computed(() => props.operation === 'rename' && props.alignTargets.length > 0);
const selectedInstances = ref<number[]>([]);
const mediaIds = ref<Record<string, number[] | 'loading' | 'error'>>({});
const removeOld = ref(true);
const refreshAfter = ref(true);

function mediaKey(instanceId: number, path: string): string {
  return `${String(instanceId)}\n${path}`;
}

const TITLES: Record<DiskOperation, string> = {
  rename: 'Rename on disk',
  move: 'Move on disk',
  delete: 'Delete from disk',
};

const title = computed(() =>
  alignable.value ? 'Rename & align' : TITLES[props.operation],
);

/** The payload as staged - built here so the preview and the queue can never disagree. */
const item = computed<NewFsQueueItem | null>(() => {
  const trimmed = name.value.trim();

  switch (props.operation) {
    case 'rename':
      if (trimmed.length === 0 || trimmed === basename(props.target)) return null;
      return { op: 'fs.rename', payload: { from: props.target, to: joinPath(parent.value, trimmed) } };
    case 'move': {
      const to = destination.value.trim();
      if (to.length === 0 || !to.startsWith('/')) return null;
      return { op: 'fs.move', payload: { from: props.target, to: joinPath(to, trimmed) } };
    }
    case 'delete':
      return {
        op: 'fs.delete',
        payload: { path: props.target, recursive: recursive.value, force: force.value },
      };
  }
});

/**
 * Whether either delete option is worth asking about at all.
 *
 * The preflight already answers both questions, so the dialog reads its verdict rather than
 * offering every option every time: an empty folder nothing references used to render two
 * irreversible-sounding checkboxes that changed nothing.
 *
 * Both are stable under their own checkbox. Ticking `recursive` turns the `recursive_required`
 * blocker into the `recursive_delete` warning, and an empty directory reports `empty` either
 * way - so neither can flicker as the re-run preflight comes back.
 */
const needsRecursive = computed(
  () =>
    preflight.value?.checks.some(
      (check) => check.id === 'recursive_required' || check.id === 'recursive_delete',
    ) ?? false,
);

const needsForce = computed(
  () =>
    preflight.value?.checks.some(
      (check) => check.id === 'referenced_by_arr' && check.status !== 'ok',
    ) ?? false,
);

// A hidden option must not keep a `true` in the payload it no longer explains. Guarded so the
// write cannot re-trigger the watch that produced the verdict in the first place.
watch([needsRecursive, needsForce], ([recursiveNeeded, forceNeeded]) => {
  if (!recursiveNeeded && recursive.value) recursive.value = false;
  if (!forceNeeded && force.value) force.value = false;
});

const blockers = computed(() => preflight.value?.checks.filter((check) => check.status === 'blocker') ?? []);
const warnings = computed(() => preflight.value?.checks.filter((check) => check.status === 'warning') ?? []);
const passed = computed(() => preflight.value?.checks.filter((check) => check.status === 'ok') ?? []);

/** Deleting is the one operation that asks you to type the name back. */
const confirmed = computed(
  () => props.operation !== 'delete' || confirmation.value.trim() === basename(props.target),
);

// ------------------------------------------------------------------- the align half

const chosen = computed(() =>
  props.alignTargets.filter((entry) => selectedInstances.value.includes(entry.instanceId)),
);

/** The ids counted for one root folder, or none while the count is still running or failed. */
function idsFor(instanceId: number, path: string): readonly number[] {
  const ids = mediaIds.value[mediaKey(instanceId, path)];
  return Array.isArray(ids) ? ids : [];
}

function idsForTarget(entry: AlignTarget): readonly number[] {
  return entry.roots.flatMap((root) => [...idsFor(entry.instanceId, root.path)]);
}

function destinationPath(): string | null {
  return item.value?.op === 'fs.rename' ? item.value.payload.to : null;
}

/**
 * Staging while a count is in flight would realign the items it had got to and silently
 * leave the rest pointing at a path that no longer exists.
 */
const counting = computed(() =>
  props.alignTargets.some((entry) =>
    entry.roots.some((root) => mediaIds.value[mediaKey(entry.instanceId, root.path)] === 'loading'),
  ),
);

/** What the footer promises, counted the way the queue will actually build it. */
const stepCount = computed(
  () =>
    1 +
    chosen.value.reduce((sum, entry) => {
      return (
        sum +
        entry.roots.reduce((rootSum, root) => {
          const items = idsFor(entry.instanceId, root.path).length;
          return (
            rootSum +
            1 +
            (items > 0 ? 1 : 0) +
            (items > 0 && refreshAfter.value ? 1 : 0) +
            (removeOld.value && root.rootFolderId !== null ? 1 : 0)
          );
        }, 0)
      );
    }, 0),
);

async function loadMediaIds(): Promise<void> {
  for (const entry of props.alignTargets) {
    for (const root of entry.roots) {
      const key = mediaKey(entry.instanceId, root.path);
      if (mediaIds.value[key] !== undefined) continue;
      mediaIds.value = { ...mediaIds.value, [key]: 'loading' };
      try {
        const ids = await resourcesApi.allMediaIdsInRootFolder(entry.instanceId, root.path);
        mediaIds.value = { ...mediaIds.value, [key]: ids };
      } catch {
        mediaIds.value = { ...mediaIds.value, [key]: 'error' };
      }
    }
  }
}

function toggleInstance(instanceId: number): void {
  selectedInstances.value = selectedInstances.value.includes(instanceId)
    ? selectedInstances.value.filter((id) => id !== instanceId)
    : [...selectedInstances.value, instanceId];
}

const canStage = computed(
  () =>
    item.value !== null &&
    preflight.value?.ok === true &&
    confirmed.value &&
    !queue.busy &&
    !(alignable.value && counting.value),
);

async function check(): Promise<void> {
  const candidate = item.value;
  if (candidate === null) {
    preflight.value = null;
    return;
  }

  checking.value = true;
  try {
    preflight.value = await fs.preflight(candidate.op as FsOp, candidate.payload);
  } catch (error) {
    preflight.value = {
      op: candidate.op,
      ok: false,
      checks: [
        {
          id: 'request_failed',
          status: 'blocker',
          message: error instanceof Error ? error.message : 'Preflight failed',
        },
      ],
      measurement: null,
      freeSpace: null,
      referencedBy: [],
    };
  } finally {
    checking.value = false;
  }
}

async function stage(): Promise<void> {
  const candidate = item.value;
  if (candidate === null) return;

  // With instances selected the disk step is the head of a chain, not a lone operation:
  // `stageReconcile` owns the dependency wiring so a failed rename touches no instance.
  if (candidate.op === 'fs.rename' && chosen.value.length > 0) {
    await queue.stageReconcile({
      from: candidate.payload.from,
      to: candidate.payload.to,
      removeOldRootFolder: removeOld.value,
      refreshAfter: refreshAfter.value,
      targets: chosen.value.flatMap((entry) =>
        entry.roots.map((root) => ({
          instanceId: entry.instanceId,
          fromPath: root.path,
          toPath: rewritePathPrefix(root.path, candidate.payload.from, candidate.payload.to),
          mediaIds: idsFor(entry.instanceId, root.path),
          oldRootFolderId: root.rootFolderId,
        })),
      ),
    });
  } else {
    await queue.stageFsOperation(candidate, describeStaging());
  }
  emit('close');
}

function describeStaging(): string {
  switch (props.operation) {
    case 'rename':
      return `the rename of ${basename(props.target)}`;
    case 'move':
      return `the move of ${basename(props.target)}`;
    case 'delete':
      return `the deletion of ${basename(props.target)}`;
  }
}

onMounted(() => {
  void check();
  void fs.loadDirectories();
  if (alignable.value) {
    selectedInstances.value = props.alignTargets.map((entry) => entry.instanceId);
    void loadMediaIds();
  }
});

watch([name, destination, recursive, force], () => void check());
</script>

<template>
  <BaseModal
    :title="title"
    :subtitle="
      alignable
        ? `${props.target} - renamed on disk and followed in every selected instance, without copying a byte`
        : props.target
    "
    width="lg"
    @close="emit('close')"
  >
    <div class="space-y-4">
      <!--
        Relocating a tracked folder is a legitimate move, but doing it without re-pointing
        the instances leaves those paths dangling - so say so before anything is staged.
        A rename that *is* carrying its instances along says it in the chain preview
        instead, so this only speaks when nothing is following the folder.
      -->
      <section
        v-if="
          props.operation !== 'delete' &&
          chosen.length === 0 &&
          (trackedBy.length > 0 || alignable)
        "
        class="rounded-md border border-drift/40 bg-drift/5 px-3 py-2 text-[11px] leading-relaxed text-drift"
      >
        <p v-for="owner in trackedBy" :key="owner.instanceId">
          {{ owner.name }} has {{ owner.mediaCount }} item(s) at or under this folder.
        </p>
        <p class="mt-1 text-muted">
          <template v-if="alignable">
            No instance is selected below, so this changes the disk only - that media will
            show as missing until something points those instances at the new path.
          </template>
          <template v-else>
            This changes the disk only, and nothing here can make *Arr adopt a renamed media
            folder: re-map those instances afterwards, or that media will show as missing.
          </template>
        </p>
      </section>

      <!-- inputs -->
      <label v-if="props.operation === 'rename'" class="block">
        <span class="mb-1 block text-xs text-muted">New name (stays in {{ parent }})</span>
        <input
          v-model="name"
          type="text"
          data-testid="disk-operation-name"
          class="w-full rounded-md border border-line bg-raised px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent"
        />
      </label>

      <div v-else-if="props.operation === 'move'" class="space-y-3">
        <div>
          <p class="mb-1 block text-xs text-muted">Destination directory</p>
          <BaseSelect
            v-model="destination"
            editable
            mono
            :options="fs.knownDirectories"
            :loading="fs.directoriesLoading"
            :note="fs.directoryListNote"
            class="w-full"
            data-testid="disk-operation-destination"
            browse-label="Pick from the folders on disk"
            empty-hint="No folder on disk matches - type the path and the check below will judge it"
          />
        </div>
        <label class="block">
          <span class="mb-1 block text-xs text-muted">Folder name at the destination</span>
          <input
            v-model="name"
            type="text"
            class="w-full rounded-md border border-line bg-raised px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent"
          />
        </label>
      </div>

      <div v-else class="space-y-3">
        <p class="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-xs leading-relaxed text-danger">
          This deletes the folder and everything under it from disk. Fleetarr has no recycle
          bin - once the queue applies this step, the only way back is your backups.
        </p>
        <!--
          Each option appears only when the preflight says it is needed. An empty folder no
          instance references is the common case, and offering it two irreversible-sounding
          choices that change nothing made it read like the dangerous one.
        -->
        <label v-if="needsRecursive" class="flex items-start gap-2 text-xs text-muted">
          <BaseCheckbox v-model="recursive" data-testid="delete-recursive" tone="danger" class="mt-0.5" />
          <span>
            <span class="font-medium text-ink">Delete contents too</span>
            <span class="block text-[11px]">Required for a folder that is not empty.</span>
          </span>
        </label>
        <label v-if="needsForce" class="flex items-start gap-2 text-xs text-muted">
          <BaseCheckbox v-model="force" data-testid="delete-force" tone="danger" class="mt-0.5" />
          <span>
            <span class="font-medium text-ink">Delete even though an instance still tracks it</span>
            <span class="block text-[11px]">
              Leaves that instance pointing at a path that no longer exists.
            </span>
          </span>
        </label>
        <label class="block">
          <span class="mb-1 block text-xs text-muted">
            Type <span class="font-mono text-ink">{{ basename(props.target) }}</span> to confirm
          </span>
          <input
            v-model="confirmation"
            type="text"
            autocomplete="off"
            class="w-full rounded-md border border-line bg-raised px-3 py-2 font-mono text-sm text-ink outline-none focus:border-danger"
          />
        </label>
      </div>

      <!-- follow it in *Arr: the old align dialog, now the second half of the rename -->
      <div v-if="alignable" class="space-y-2" data-testid="align-targets">
        <p class="text-xs text-muted">
          Instances with a root folder at or under this path
        </p>
        <ul class="space-y-1">
          <li v-for="entry in props.alignTargets" :key="entry.instanceId">
            <label class="flex items-center justify-between gap-3 rounded border border-line bg-raised/60 px-2.5 py-1.5 text-xs">
              <span class="flex items-center gap-2">
                <BaseCheckbox
                  :model-value="selectedInstances.includes(entry.instanceId)"
                  @change="toggleInstance(entry.instanceId)"
                />
                {{ entry.name }}
                <span class="text-[10px] text-faint uppercase">{{ entry.kind }}</span>
              </span>
              <span class="text-[11px] text-muted">
                <template v-if="entry.roots.some((root) => mediaIds[mediaKey(entry.instanceId, root.path)] === 'loading')">
                  counting…
                </template>
                <template v-else-if="entry.roots.some((root) => mediaIds[mediaKey(entry.instanceId, root.path)] === 'error')">
                  <span class="text-danger">count failed</span>
                </template>
                <template v-else>
                  {{ idsForTarget(entry).length }} item(s) to realign
                  <span v-if="entry.roots.length > 1 || entry.roots[0]?.path !== props.target">
                    · {{ entry.roots.length }} root folder(s)
                  </span>
                </template>
              </span>
            </label>
            <ul
              v-if="entry.roots.length > 1 || entry.roots[0]?.path !== props.target"
              class="mt-1 space-y-0.5 pl-8 text-[11px] font-mono text-faint"
            >
              <li v-for="root in entry.roots" :key="root.path">{{ root.path }}</li>
            </ul>
          </li>
        </ul>

        <div class="space-y-2 rounded-md border border-line bg-raised/40 px-3 py-2.5 text-xs">
          <label class="flex items-start gap-2">
            <BaseCheckbox v-model="refreshAfter" class="mt-0.5" />
            <span>
              <span class="font-medium text-ink">Rescan afterwards</span>
              <span class="block text-[11px] text-muted">
                Sends RefreshMovie / RefreshSeries so the instance re-reads the new paths.
              </span>
            </span>
          </label>
          <label class="flex items-start gap-2">
            <BaseCheckbox v-model="removeOld" class="mt-0.5" />
            <span>
              <span class="font-medium text-ink">Remove the old root folder</span>
              <span class="block text-[11px] text-muted">
                Only runs if that instance's realignment succeeded.
              </span>
            </span>
          </label>
        </div>

        <!-- the exact chain, in words -->
        <div v-if="chosen.length > 0" class="rounded-lg border border-staged/40 bg-staged/5 px-3 py-2.5">
          <p class="mb-1.5 text-[11px] font-semibold text-staged">What will be staged</p>
          <ol class="space-y-1 text-[11px] text-muted">
            <li>
              <span class="font-mono text-ink">1.</span>
              rename <span class="font-mono">{{ props.target }}</span> to
              <span class="font-mono">{{ item?.op === 'fs.rename' ? item.payload.to : '' }}</span>
              on disk
            </li>
            <li v-for="(entry, index) in chosen" :key="entry.instanceId">
              <span class="font-mono text-ink">{{ index + 2 }}.</span>
              on {{ entry.name }}:
              <template v-for="(root, rootIndex) in entry.roots" :key="root.path">
                <span v-if="rootIndex > 0">; </span>
                add
                <span class="font-mono">{{
                  destinationPath() === null
                    ? root.path
                    : rewritePathPrefix(root.path, props.target, destinationPath() ?? props.target)
                }}</span>
                <template v-if="idsFor(entry.instanceId, root.path).length > 0"
                  >, point its media at it with
                  <span class="font-mono text-sync">moveFiles: false</span><span v-if="refreshAfter">, rescan</span></template>
                <span v-if="removeOld && root.rootFolderId !== null">, then drop the old root folder</span>
              </template>
            </li>
          </ol>
          <p class="mt-2 text-[11px] leading-relaxed text-muted">
            Every *Arr step waits for the disk step. If the rename fails, nothing after it runs -
            and because <span class="font-mono">moveFiles</span> is false, no instance will try to
            copy the media that just moved.
          </p>
        </div>
      </div>

      <!-- preflight -->
      <div class="rounded-lg border border-line bg-raised/40 px-3 py-2.5">
        <p class="mb-2 flex items-center gap-2 text-[11px] font-semibold text-muted">
          Preflight
          <span v-if="checking" class="text-faint">checking…</span>
          <span v-else-if="preflight?.ok" class="text-sync">all checks passed</span>
          <span v-else-if="preflight" class="text-danger">{{ blockers.length }} blocker(s)</span>
        </p>

        <ul v-if="preflight" class="space-y-1 text-[11px]">
          <li v-for="check in blockers" :key="check.id" class="flex gap-2 text-danger">
            <IconError class="mt-0.5" />
            <span>{{ check.message }}</span>
          </li>
          <li v-for="check in warnings" :key="check.id" class="flex gap-2 text-drift">
            <IconWarning class="mt-0.5" />
            <span>{{ check.message }}</span>
          </li>
          <li v-for="check in passed" :key="check.id" class="flex gap-2 text-muted">
            <IconCheck size="xs" class="mt-0.5 text-sync" />
            <span>{{ check.message }}</span>
          </li>
        </ul>

        <p v-if="preflight?.measurement" class="mt-2 text-[11px] text-muted">
          {{ formatBytes(preflight.measurement.sizeOnDisk) }} in
          {{ preflight.measurement.fileCount }} file(s)
          <span v-if="preflight.measurement.truncated">(at least - the walk hit its cap)</span>
        </p>
        <p v-if="preflight?.freeSpace !== null && preflight?.freeSpace !== undefined" class="text-[11px] text-faint">
          {{ formatBytes(preflight.freeSpace) }} free on that filesystem
        </p>
      </div>

      <p class="text-[11px] leading-relaxed text-muted">
        Nothing happens now: this is added to Pending Fleet Changes, and the preflight runs
        again immediately before it executes.
      </p>
    </div>

    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">Cancel</BaseButton>
      <BaseButton
        :variant="props.operation === 'delete' ? 'danger' : 'primary'"
        :disabled="!canStage"
        :loading="queue.busy"
        @click="stage()"
      >
        <template v-if="chosen.length > 0">Stage {{ stepCount }} step(s)</template>
        <template v-else>Stage {{ props.operation }}</template>
      </BaseButton>
    </template>
  </BaseModal>
</template>
