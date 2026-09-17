<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { FsPreflight, PathImportList } from '@fleetarr/shared';
import BaseButton from '@/components/base/BaseButton.vue';
import BaseCheckbox from '@/components/base/BaseCheckbox.vue';
import BaseModal from '@/components/base/BaseModal.vue';
import IconCreate from '@/components/base/icons/IconCreate.vue';
import IconError from '@/components/base/icons/IconError.vue';
import IconWarning from '@/components/base/icons/IconWarning.vue';
import { formatBytes } from '@/lib/format';
import { rootFolderOwners } from '@/lib/path-matrix';
import { useMatrixStore } from '@/stores/matrix';
import { usePathsStore } from '@/stores/paths';
import { useQueueStore, type RemapTarget } from '@/stores/queue';
import { useUiStore } from '@/stores/ui';

/**
 * Switch a root folder to another folder, taking its media with it.
 *
 * The three steps already existed as `remap`; what this adds is the two halves that made it
 * unusable for the job its name promised. First, the destination is checked against the disk
 * rather than assumed: a folder that is not there is created as the head of the chain, because
 * *Arr refuses to register a root folder at a path that does not exist, and a folder that *is*
 * there must not get an `fs.mkdir` at all - the preflight treats an existing target as a
 * blocker, which would pause the run before anything else ran.
 *
 * Second, `moveFiles` is no longer a choice. `media.moveRootFolder` only rewrites
 * `rootFolderPath`; with no prior disk move, leaving it off re-points every item at a path its
 * files are not at and *Arr reports the whole library missing. The one legitimate "off" is when
 * the bytes have already moved, which is what rename & align stages.
 */
const props = defineProps<{ fromPath: string }>();
const emit = defineEmits<{ close: [] }>();

const matrix = useMatrixStore();
const paths = usePathsStore();
const queue = useQueueStore();
const ui = useUiStore();

const toPath = ref('');
const removeOld = ref(true);
const refreshAfter = ref(false);
const acknowledgeNotEmpty = ref(false);
const included = ref<number[]>([]);
const counts = ref<Record<number, number | 'loading' | 'error'>>({});

/** Set once the fleet snapshot is in: only it knows every instance's root folder paths. */
const fleetReady = ref(false);

/** The `fs.mkdir` verdict for the destination. Null until a path has been judged. */
const mkdirCheck = ref<FsPreflight | null>(null);
const checking = ref(false);

const sourceNode = computed(() => paths.nodeAt(props.fromPath));

/**
 * The instances rooting at this exact folder.
 *
 * Read from the row the dialog was opened from, not from the fleet matrix: `/paths` kicks off
 * `matrix.load()` without awaiting it, and seeding this from a store that had not answered yet
 * left the dialog with no candidates and a permanently disabled button.
 */
const candidates = computed(() =>
  (sourceNode.value === null ? [] : rootFolderOwners(sourceNode.value)).map((owner) => ({
    instanceId: owner.instanceId,
    name: owner.name,
    kind: owner.kind,
    oldRootFolderId: owner.rootFolderId,
    /** Whether this instance already roots at the destination - a second create would 400. */
    hasDestination:
      matrix.columns
        .find((column) => column.instance.id === owner.instanceId)
        ?.rootFolders.some((folder) => folder.path === destination.value) ?? false,
    importLists: owner.importLists,
  })),
);

const destination = computed(() => toPath.value.trim().replace(/\/+$/, ''));

const destinationNode = computed(() =>
  destination.value.length === 0 ? null : paths.nodeAt(destination.value),
);

/**
 * Whether an `fs.mkdir` belongs at the head of the chain.
 *
 * The preflight is the authority, never `nodeAt`: the client only knows the levels the user
 * has expanded, and its own store says so. `destination_free` answers exactly this question -
 * `ok` means the folder is not there and can be made, a blocker means it already is.
 */
const mkdirPath = computed<string | null>(() => {
  const check = mkdirCheck.value?.checks.find((entry) => entry.id === 'destination_free');
  return check?.status === 'ok' ? destination.value : null;
});

const mkdirBlockers = computed(
  () =>
    mkdirCheck.value?.checks.filter(
      (check) => check.status === 'blocker' && check.id !== 'destination_free',
    ) ?? [],
);

/** Set when the destination exists but is not a directory we may root at. */
const destinationUnusable = computed(() => {
  const node = destinationNode.value;
  if (node === null || !node.exists) return null;
  if (node.kind === 'symlink') return 'That path is a symlink - Fleetarr never follows or mutates one.';
  if (node.kind !== 'directory') return 'That path is a file, not a folder.';
  return null;
});

/**
 * Read from the destination's own level rather than from its `childCount`.
 *
 * A node only carries a child count when its *parent* level happened to be fetched and probed,
 * and `null` there means "not evaluated", never "empty". The level's own rollup is exact even
 * when its node list is a subset, so fetching the one level answers the question outright -
 * and until it has been fetched the honest answer is that we do not know.
 */
const destinationEmptiness = computed<'empty' | 'occupied' | 'unknown'>(() => {
  if (mkdirPath.value !== null) return 'empty';
  const level = paths.levels[destination.value];
  if (level === undefined) return 'unknown';
  return level.rollup.entries === 0 ? 'empty' : 'occupied';
});

const crossDevice = computed(
  () =>
    sourceNode.value?.deviceId !== null &&
    destinationNode.value?.deviceId !== null &&
    destinationNode.value !== null &&
    sourceNode.value !== null &&
    sourceNode.value.deviceId !== destinationNode.value.deviceId,
);

const sourceSize = computed(() => paths.measurements[props.fromPath]?.sizeOnDisk ?? null);

const destinationFree = computed(
  () => destinationNode.value?.freeSpace ?? mkdirCheck.value?.freeSpace ?? null,
);

const tooLittleSpace = computed(
  () =>
    crossDevice.value &&
    sourceSize.value !== null &&
    destinationFree.value !== null &&
    destinationFree.value < sourceSize.value,
);

/** Lists still aimed at the folder being left - they will quietly refill it. */
const strandedLists = computed<PathImportList[]>(() =>
  candidates.value
    .filter((candidate) => included.value.includes(candidate.instanceId))
    .flatMap((candidate) => [...candidate.importLists]),
);

const chosen = computed(() =>
  candidates.value.filter((candidate) => included.value.includes(candidate.instanceId)),
);

const totalMedia = computed(() =>
  chosen.value.reduce((sum, candidate) => {
    const count = counts.value[candidate.instanceId];
    return sum + (typeof count === 'number' ? count : 0);
  }, 0),
);

const counting = computed(() =>
  candidates.value.some((candidate) => counts.value[candidate.instanceId] === 'loading'),
);

/**
 * No `totalMedia > 0` requirement: a configured but still empty root folder is precisely the
 * one worth re-pointing, and it switches with a create and a delete.
 */
const valid = computed(
  () =>
    destination.value.startsWith('/') &&
    destination.value !== props.fromPath &&
    chosen.value.length > 0 &&
    destinationUnusable.value === null &&
    mkdirBlockers.value.length === 0 &&
    !checking.value &&
    !counting.value &&
    fleetReady.value &&
    (destinationEmptiness.value !== 'occupied' || acknowledgeNotEmpty.value),
);

const stepCount = computed(
  () =>
    (mkdirPath.value === null ? 0 : 1) +
    chosen.value.reduce((sum, candidate) => {
      const items = typeof counts.value[candidate.instanceId] === 'number'
        ? (counts.value[candidate.instanceId] as number)
        : 0;
      return (
        sum +
        (candidate.hasDestination ? 0 : 1) +
        (items > 0 ? 1 : 0) +
        (items > 0 && refreshAfter.value ? 1 : 0) +
        (removeOld.value && candidate.oldRootFolderId !== null ? 1 : 0)
      );
    }, 0),
);

async function judgeDestination(): Promise<void> {
  if (!destination.value.startsWith('/')) {
    mkdirCheck.value = null;
    return;
  }

  checking.value = true;
  try {
    mkdirCheck.value = await paths.preflight('fs.mkdir', {
      path: destination.value,
      recursive: true,
    });
    // Only a level the browser already holds can answer "is it empty"; fetch it so the
    // question is answered from the disk rather than from whatever happened to be expanded.
    if (mkdirPath.value === null) await paths.fetchLevels([destination.value]);
  } catch {
    mkdirCheck.value = null;
  } finally {
    checking.value = false;
  }
}

async function loadCounts(): Promise<void> {
  for (const candidate of candidates.value) {
    if (counts.value[candidate.instanceId] !== undefined) continue;
    counts.value = { ...counts.value, [candidate.instanceId]: 'loading' };
    try {
      const ids = await matrix.mediaIdsInRootFolder(candidate.instanceId, props.fromPath);
      counts.value = { ...counts.value, [candidate.instanceId]: ids.length };
    } catch {
      counts.value = { ...counts.value, [candidate.instanceId]: 'error' };
    }
  }
}

function toggle(instanceId: number): void {
  included.value = included.value.includes(instanceId)
    ? included.value.filter((id) => id !== instanceId)
    : [...included.value, instanceId];
}

async function confirm(): Promise<void> {
  const targets: RemapTarget[] = [];

  for (const candidate of chosen.value) {
    const mediaIds = await matrix.mediaIdsInRootFolder(candidate.instanceId, props.fromPath);
    targets.push({
      instanceId: candidate.instanceId,
      mediaIds,
      needsRootFolder: !candidate.hasDestination,
      removeRootFolderId: removeOld.value ? candidate.oldRootFolderId : null,
    });
  }

  if (targets.length === 0) {
    ui.notify('info', 'No instance selected - nothing to switch');
    return;
  }

  await queue.remapRootFolder({
    targets,
    fromPath: props.fromPath,
    toPath: destination.value,
    // Always: without it the media is re-pointed at a path its files are not at.
    moveFiles: true,
    mkdirPath: mkdirPath.value,
    refreshAfter: refreshAfter.value,
  });
  emit('close');
}

onMounted(async () => {
  included.value = candidates.value.map((candidate) => candidate.instanceId);
  void loadCounts();

  // `hasDestination` is the one thing only the fleet snapshot knows, and creating a root
  // folder an instance already has is a 400 that pauses the run.
  if (matrix.lastLoadedAt === null) await matrix.load();
  fleetReady.value = true;
  // Candidates may only now have resolved, so re-seed rather than leaving the list empty.
  if (included.value.length === 0) {
    included.value = candidates.value.map((candidate) => candidate.instanceId);
    void loadCounts();
  }
});

watch(destination, () => void judgeDestination());

/**
 * Only measure when the answer would change something.
 *
 * A recursive walk over a root folder is the most expensive thing this dialog could do, and
 * the size only matters for the cross-filesystem warning - a same-device move is a rename and
 * needs no space at all.
 */
watch(crossDevice, (crosses) => {
  if (crosses && paths.measurements[props.fromPath] === undefined) {
    void paths.measure(props.fromPath);
  }
});
</script>

<template>
  <BaseModal
    title="Switch root folder"
    :subtitle="`${props.fromPath} - *Arr moves the media to the new folder and roots there instead`"
    width="lg"
    @close="emit('close')"
  >
    <div class="space-y-4">
      <label class="block">
        <span class="mb-1 block text-xs text-muted">Destination folder</span>
        <input
          v-model="toPath"
          type="text"
          list="known-paths"
          data-testid="switch-destination"
          placeholder="/data/media/movies-4k"
          class="w-full rounded-md border border-line bg-raised px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent"
        />
        <datalist id="known-paths">
          <option v-for="path in paths.knownDirectories" :key="path" :value="path" />
        </datalist>
      </label>

      <!-- what the disk says about that path -->
      <div
        v-if="destination.length > 0"
        class="space-y-1 rounded-md border border-line bg-raised/40 px-3 py-2 text-[11px]"
        data-testid="destination-verdict"
      >
        <p v-if="checking" class="text-faint">checking the destination…</p>
        <template v-else>
          <p v-if="destinationUnusable" class="flex gap-2 text-danger">
            <IconError class="mt-0.5" /> {{ destinationUnusable }}
          </p>
          <p v-for="check in mkdirBlockers" :key="check.id" class="flex gap-2 text-danger">
            <IconError class="mt-0.5" /> {{ check.message }}
          </p>
          <p v-if="mkdirPath !== null" class="flex gap-2 text-sync" data-testid="will-mkdir">
            <IconCreate size="xs" class="mt-0.5" />
            Not on disk yet - it will be created first, before any instance is told about it.
          </p>
          <p v-else-if="destinationEmptiness === 'empty'" class="text-muted">
            The folder is there and empty.
          </p>
          <p v-else-if="destinationEmptiness === 'unknown'" class="text-muted">
            The folder is there. Fleetarr has not counted its contents, so it cannot say whether
            it is empty - deliberately not "it is".
          </p>
          <p v-else class="flex gap-2 text-drift" data-testid="destination-occupied">
            <IconWarning class="mt-0.5" />
            The folder already has something in it. *Arr will move this library in alongside
            whatever is there.
          </p>
          <p v-if="crossDevice" class="flex gap-2 text-drift">
            <IconWarning class="mt-0.5" />
            That is a different filesystem, so *Arr copies rather than renames<template v-if="sourceSize !== null">
              - {{ formatBytes(sourceSize) }} to move</template><template v-if="destinationFree !== null">, {{ formatBytes(destinationFree) }} free there</template>.
          </p>
          <p v-if="tooLittleSpace" class="flex gap-2 text-danger">
            <IconWarning class="mt-0.5" /> There is less free space there than this folder holds.
          </p>
        </template>
      </div>

      <label
        v-if="destinationEmptiness === 'occupied' && destinationUnusable === null"
        class="flex items-start gap-2 text-xs"
      >
        <BaseCheckbox v-model="acknowledgeNotEmpty" data-testid="acknowledge-not-empty" tone="danger" class="mt-0.5" />
        <span>
          <span class="font-medium text-ink">Move into it anyway</span>
          <span class="block text-[11px] text-muted">
            Merging two libraries into one folder is a legitimate thing to want, and an accident
            worth one click.
          </span>
        </span>
      </label>

      <div>
        <p class="mb-1.5 text-xs text-muted">
          Instances rooting at {{ props.fromPath }}
          <span v-if="!fleetReady" class="text-faint">· reading the fleet…</span>
        </p>
        <ul class="space-y-1">
          <li v-for="candidate in candidates" :key="candidate.instanceId">
            <label
              class="flex items-center justify-between gap-3 rounded border border-line bg-raised/60 px-2.5 py-1.5 text-xs"
            >
              <span class="flex items-center gap-2">
                <BaseCheckbox
                  :model-value="included.includes(candidate.instanceId)"
                  @change="toggle(candidate.instanceId)"
                />
                {{ candidate.name }}
                <span class="text-[10px] text-faint uppercase">{{ candidate.kind }}</span>
              </span>
              <span class="flex items-center gap-2 text-[11px]">
                <span
                  v-if="destination.length > 0 && !candidate.hasDestination"
                  class="rounded border border-sync/40 bg-sync/10 px-1.5 py-0.5 text-sync"
                  title="The destination root folder will be registered here first"
                >
                  <IconCreate size="xs" /> root folder
                </span>
                <span class="text-muted">
                  <template v-if="counts[candidate.instanceId] === 'loading'">counting…</template>
                  <template v-else-if="counts[candidate.instanceId] === 'error'">
                    <span class="text-danger">count failed</span>
                  </template>
                  <template v-else>{{ counts[candidate.instanceId] ?? 0 }} item(s)</template>
                </span>
              </span>
            </label>
          </li>
        </ul>
        <p v-if="candidates.length === 0" class="text-[11px] text-muted">
          No instance roots at this folder.
        </p>
      </div>

      <div class="space-y-2 rounded-md border border-line bg-raised/40 px-3 py-2.5">
        <p class="flex gap-2 text-[11px] leading-relaxed text-danger">
          <IconWarning class="mt-0.5" />
          *Arr will physically relocate {{ totalMedia }} item(s). This is slow and Fleetarr cannot
          undo it. If the files are <em>already</em> at the destination, close this and use
          rename &amp; align instead - that re-points without moving a byte.
        </p>

        <label class="flex items-start gap-2 text-xs">
          <BaseCheckbox v-model="removeOld" data-testid="remove-old" class="mt-0.5" />
          <span>
            <span class="font-medium text-ink">Stop rooting at {{ props.fromPath }}</span>
            <span class="block text-[11px] leading-relaxed text-muted">
              Staged as a dependent step - it only runs if that instance's move succeeded.
            </span>
          </span>
        </label>

        <label class="flex items-start gap-2 text-xs">
          <BaseCheckbox v-model="refreshAfter" data-testid="refresh-after" class="mt-0.5" />
          <span>
            <span class="font-medium text-ink">Rescan afterwards</span>
            <span class="block text-[11px] leading-relaxed text-muted">
              Off by default: *Arr answers the move request before it has moved anything, so a
              rescan staged behind it would read the new paths while the files are still in
              flight and report the library missing.
            </span>
          </span>
        </label>
      </div>

      <div
        v-if="strandedLists.length > 0"
        class="rounded-md border border-drift/40 bg-drift/5 px-3 py-2 text-[11px] text-drift"
        data-testid="stranded-lists"
      >
        <p>
          {{ strandedLists.length }} import list(s) still add to the folder being left:
          <span class="font-mono">{{ strandedLists.map((list) => list.name).join(', ') }}</span>.
        </p>
        <p class="mt-1 text-muted">
          A list is what refills a folder after it is emptied. Re-point them on the instance, or
          this switch will be undone one sync at a time.
        </p>
      </div>

      <!-- the exact chain, in words -->
      <div v-if="chosen.length > 0 && destination.length > 0" class="rounded-lg border border-staged/40 bg-staged/5 px-3 py-2.5">
        <p class="mb-1.5 text-[11px] font-semibold text-staged">What will be staged</p>
        <ol class="space-y-1 text-[11px] text-muted">
          <li v-if="mkdirPath !== null">
            <span class="font-mono text-ink">1.</span>
            create <span class="font-mono">{{ mkdirPath }}</span> on disk
          </li>
          <li v-for="(candidate, index) in chosen" :key="candidate.instanceId">
            <span class="font-mono text-ink">{{ index + (mkdirPath === null ? 1 : 2) }}.</span>
            on {{ candidate.name }}:
            <template v-if="!candidate.hasDestination">
              add <span class="font-mono">{{ destination }}</span>,
            </template>
            move its media there with <span class="font-mono text-danger">moveFiles: true</span><template v-if="refreshAfter">, rescan</template><template v-if="removeOld && candidate.oldRootFolderId !== null">, then stop rooting at <span class="font-mono">{{ props.fromPath }}</span></template>
          </li>
        </ol>
        <p class="mt-2 text-[11px] leading-relaxed text-muted">
          Applying this means *Arr <em>accepted</em> the move, not that it finished - the files
          keep moving in the background. <span class="font-mono">{{ props.fromPath }}</span> is
          left on disk; delete it from its own row once *Arr is done with it. If a step fails the
          run pauses, which can leave one instance switched and another not.
        </p>
      </div>
    </div>

    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">Cancel</BaseButton>
      <BaseButton
        variant="danger"
        data-testid="switch-confirm"
        :disabled="!valid"
        :loading="queue.busy"
        @click="confirm()"
      >
        Stage {{ stepCount }} step(s)
      </BaseButton>
    </template>
  </BaseModal>
</template>
