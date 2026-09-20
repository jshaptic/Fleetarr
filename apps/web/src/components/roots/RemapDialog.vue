<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { FsPreflight, PathCollection, PathImportList } from '@fleetarr/shared';
import BaseButton from '@/components/base/BaseButton.vue';
import BaseCheckbox from '@/components/base/BaseCheckbox.vue';
import BaseSelect from '@/components/base/BaseSelect.vue';
import BaseModal from '@/components/base/BaseModal.vue';
import BaseInstanceBadge from '@/components/base/BaseInstanceBadge.vue';
import BaseNotice from '@/components/base/BaseNotice.vue';
import IconCreate from '@/components/base/icons/IconCreate.vue';
import IconUnknown from '@/components/base/icons/IconUnknown.vue';
import { formatBytes } from '@/lib/format';
import { rewritePathPrefix } from '@/lib/fs-tree';
import { rootFolderOwners } from '@/lib/path-matrix';
import { useMatrixStore } from '@/stores/matrix';
import { usePathsStore } from '@/stores/paths';
import {
  useQueueStore,
  type RemapCollectionTarget,
  type RemapListTarget,
  type RemapTarget,
} from '@/stores/queue';
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
const repointLists = ref(true);
const repointCollections = ref(true);
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
    collections: owner.collections,
    collectionsKnown: owner.collectionsKnown,
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

/**
 * The tail of the cross-filesystem sentence, assembled here rather than from three chained
 * `<template>` tags. Whether that comma had a space in front of it came down to where the
 * newlines fell between the tags, which is not a thing to decide by indentation.
 */
const crossDeviceDetail = computed(() => {
  const parts: string[] = [];
  if (sourceSize.value !== null) parts.push(`${formatBytes(sourceSize.value)} to move`);
  if (destinationFree.value !== null) {
    parts.push(`${formatBytes(destinationFree.value)} free there`);
  }
  return parts.length === 0 ? '' : ` - ${parts.join(', ')}`;
});

const tooLittleSpace = computed(
  () =>
    crossDevice.value &&
    sourceSize.value !== null &&
    destinationFree.value !== null &&
    destinationFree.value < sourceSize.value,
);

/**
 * Lists still aimed at the folder being left, and where each would point instead.
 *
 * Rewritten by prefix rather than replaced: a list filling `movies/4k` under a root folder
 * being switched should end up at `<new>/4k`, not at the new root itself. That is the same
 * rule a parent rename follows for nested registrations.
 */
const strandedLists = computed(() =>
  candidates.value
    .filter((candidate) => included.value.includes(candidate.instanceId))
    .flatMap((candidate) =>
      candidate.importLists.map((list: PathImportList) => ({
        instanceId: candidate.instanceId,
        importListId: list.id,
        name: list.name,
        from: list.path,
        to:
          destination.value.length === 0
            ? list.path
            : rewritePathPrefix(list.path, props.fromPath, destination.value),
      })),
    ),
);

/**
 * Collections still rooted in the folder being left, and where each would point instead.
 *
 * Same prefix rewrite as the lists, and for the same reason: a collection rooted at
 * `movies/marvel` under a root folder being switched belongs at `<new>/marvel`, not at
 * the new root. A monitored one re-adds its films into the old folder otherwise, which is
 * this switch quietly undoing itself.
 */
const strandedCollections = computed(() =>
  candidates.value
    .filter((candidate) => included.value.includes(candidate.instanceId))
    .flatMap((candidate) =>
      candidate.collections.map((entry: PathCollection) => ({
        instanceId: candidate.instanceId,
        collectionId: entry.id,
        title: entry.title,
        monitored: entry.monitored,
        from: entry.path,
        to:
          destination.value.length === 0
            ? entry.path
            : rewritePathPrefix(entry.path, props.fromPath, destination.value),
      })),
    ),
);

/** Instances that never reported their collections - stated once, never a silent zero. */
const collectionsUnknownOn = computed(() =>
  candidates.value
    .filter((candidate) => included.value.includes(candidate.instanceId))
    .filter((candidate) => !candidate.collectionsKnown)
    .map((candidate) => candidate.name),
);

function collectionTargetsFor(instanceId: number): RemapCollectionTarget[] {
  if (!repointCollections.value) return [];
  // Grouped by destination: several collections landing on the same folder are one
  // editor call, which is the unit `collection.update` takes.
  const byDestination = new Map<string, number[]>();
  for (const entry of strandedCollections.value) {
    if (entry.instanceId !== instanceId) continue;
    const group = byDestination.get(entry.to);
    if (group === undefined) byDestination.set(entry.to, [entry.collectionId]);
    else group.push(entry.collectionId);
  }
  return [...byDestination].map(([toRootFolderPath, collectionIds]) => ({
    toRootFolderPath,
    collectionIds,
  }));
}

function listTargetsFor(instanceId: number): RemapListTarget[] {
  if (!repointLists.value) return [];
  return strandedLists.value
    .filter((list) => list.instanceId === instanceId)
    .map((list) => ({
      importListId: list.importListId,
      name: list.name,
      toRootFolderPath: list.to,
    }));
}

const chosen = computed(() =>
  candidates.value.filter((candidate) => included.value.includes(candidate.instanceId)),
);

/**
 * How many items an instance has under this folder, or `null` when that is not known -
 * still counting, or the count failed. Deliberately not `0` for either: a zero is what
 * decides that no files move and that no move step is staged, and neither conclusion may
 * be drawn from a question nobody answered.
 */
function itemsUnder(instanceId: number): number | null {
  const count = counts.value[instanceId];
  return typeof count === 'number' ? count : null;
}

/** Only a counted zero cancels the move; an unknown count stages one and lets *Arr say. */
function movesMedia(instanceId: number): boolean {
  return itemsUnder(instanceId) !== 0;
}

const totalMedia = computed(() =>
  chosen.value.reduce((sum, candidate) => sum + (itemsUnder(candidate.instanceId) ?? 0), 0),
);

const counting = computed(() =>
  candidates.value.some((candidate) => counts.value[candidate.instanceId] === 'loading'),
);

const countsFailed = computed(
  () => chosen.value.filter((candidate) => counts.value[candidate.instanceId] === 'error').length,
);

/**
 * Which relocation story to tell, because "*Arr will physically relocate 0 item(s)" is
 * three different situations wearing one sentence, and two of them are not warnings at all.
 *
 * A root folder with nothing under it is the ordinary case for a freshly configured
 * instance, and switching it moves no bytes - it is a create and a delete. Saying it is
 * slow and cannot be undone is simply false there, and a red box that cries wolf on the
 * harmless case is how the one that matters stops being read. A count that has not landed
 * yet, or that failed, is not a zero either: those get their own line rather than being
 * rounded down into one.
 */
const relocation = computed<'counting' | 'unknown' | 'none' | 'some'>(() => {
  if (counting.value) return 'counting';
  if (countsFailed.value > 0) return 'unknown';
  return totalMedia.value > 0 ? 'some' : 'none';
});

const allSelected = computed(
  () => candidates.value.length > 0 && included.value.length === candidates.value.length,
);

function toggleAll(): void {
  included.value = allSelected.value ? [] : candidates.value.map((c) => c.instanceId);
}

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

/** One run of text in a staged step; `mono` for a path, `tone` for the flag worth reading. */
type StepPart = { text: string; mono?: boolean; tone?: 'danger' };

/**
 * Every queue item this dialog will stage, in the order the queue receives them.
 *
 * The chain used to render one line per instance while the button counted operations, so a
 * single instance getting a create, a move and a delete read as "1." under a button offering
 * to stage three. Both now come from this array, which cannot disagree with itself - and the
 * order is the queue's own, so the numbers are the order things will actually run in.
 */
const plan = computed<StepPart[][]>(() => {
  const steps: StepPart[][] = [];
  if (mkdirPath.value !== null) {
    steps.push([{ text: 'create ' }, { text: mkdirPath.value, mono: true }, { text: ' on disk' }]);
  }

  // The destinations, then the moves, then the lists, then the removals: each group is its
  // own push in `remapRootFolder`, and a later group depends on the earlier one landing.
  for (const candidate of chosen.value) {
    if (candidate.hasDestination) continue;
    steps.push([
      { text: `on ${candidate.name}: register ` },
      { text: destination.value, mono: true },
      { text: ' as a root folder' },
    ]);
  }

  for (const candidate of chosen.value) {
    if (!movesMedia(candidate.instanceId)) continue;
    const items = itemsUnder(candidate.instanceId);
    steps.push([
      {
        text: `on ${candidate.name}: move ${items === null ? 'its media' : `${String(items)} item(s)`} there with `,
      },
      { text: 'moveFiles: true', mono: true, tone: 'danger' },
    ]);
  }

  for (const candidate of chosen.value) {
    for (const list of listTargetsFor(candidate.instanceId)) {
      steps.push([
        { text: `on ${candidate.name}: re-aim ${list.name} at ` },
        { text: list.toRootFolderPath, mono: true },
      ]);
    }
  }

  if (removeOld.value) {
    for (const candidate of chosen.value) {
      if (candidate.oldRootFolderId === null) continue;
      steps.push([
        { text: `on ${candidate.name}: stop rooting at ` },
        { text: props.fromPath, mono: true },
      ]);
    }
  }

  return steps;
});

const stepCount = computed(() => plan.value.length);

/**
 * The instances the chain stages no move for.
 *
 * An absent line is not an explanation: the chain used to carry "keep the registration only"
 * on the instance's own row, and with one line per operation there is no row left to hang it
 * on. Naming them under the list says the same thing without a step number implying work.
 */
const registrationOnly = computed(() =>
  chosen.value.filter((candidate) => !movesMedia(candidate.instanceId)),
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
      importLists: listTargetsFor(candidate.instanceId),
      collections: collectionTargetsFor(candidate.instanceId),
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
  });
  emit('close');
}

onMounted(async () => {
  // The destination list. Fired and not awaited: the dialog is usable while it lands, and
  // a typed path is judged by the preflight regardless of whether the list holds it.
  void paths.loadDirectories();
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
    :subtitle=props.fromPath
    width="lg"
    @close="emit('close')"
  >
    <div class="space-y-5">
      <!--
        Four sections in the order the decision is made: where to, who moves, how, and then
        the chain in words. The warnings were the thing that read as awkward, and the cause
        was placement rather than wording - the acknowledgement for "the folder is not empty"
        sat outside the box holding the sentence it answered, and the red relocation warning
        shared a box with two unrelated option checkboxes, which made a danger tint the
        background of an ordinary setting. Each notice now sits inside the section whose
        facts produced it.
      -->
      <section class="space-y-2">
        <!-- A real `for`, not a heading that looks like one: BaseSelect renders the input. -->
        <label
          class="block text-[10px] font-semibold tracking-wide text-faint uppercase"
          for="switch-destination"
        >
          Destination
        </label>

        <BaseSelect
          id="switch-destination"
          v-model="toPath"
          editable
          mono
          :options="paths.knownDirectories"
          :loading="paths.directoriesLoading"
          :note="paths.directoryListNote"
          class="w-full"
          data-testid="switch-destination"
          placeholder="/data/media/movies-4k"
          browse-label="Pick from the folders on disk"
          empty-hint="No folder on disk matches - type the path and the check below will judge it"
        />

        <!-- what the disk says about that path, and the one question it can raise -->
        <div
          v-if="destination.length > 0"
          class="space-y-1.5 rounded-md border border-line bg-raised/40 px-3 py-2"
          data-testid="destination-verdict"
        >
          <BaseNotice v-if="checking">checking the destination…</BaseNotice>
          <template v-else>
            <BaseNotice v-if="destinationUnusable" tone="danger">
              {{ destinationUnusable }}
            </BaseNotice>
            <BaseNotice v-for="check in mkdirBlockers" :key="check.id" tone="danger">
              {{ check.message }}
            </BaseNotice>

            <BaseNotice v-if="mkdirPath !== null" tone="sync" :icon="IconCreate" data-testid="will-mkdir">
              Not on disk yet - it will be created first, before any instance is told about it.
            </BaseNotice>
            <BaseNotice v-else-if="destinationEmptiness === 'empty'" tone="sync">
              The folder is there and empty.
            </BaseNotice>
            <BaseNotice v-else-if="destinationEmptiness === 'unknown'" :icon="IconUnknown">
              The folder is there. Fleetarr has not counted its contents, so it cannot say
              whether it is empty - deliberately not "it is".
            </BaseNotice>
            <BaseNotice v-else tone="warn" data-testid="destination-occupied">
              The folder already has something in it. *Arr will move this library in alongside
              whatever is there.
            </BaseNotice>

            <BaseNotice v-if="crossDevice" tone="warn">
              That is a different filesystem, so *Arr copies rather than
              renames{{ crossDeviceDetail }}.
            </BaseNotice>
            <BaseNotice v-if="tooLittleSpace" tone="danger">
              There is less free space there than this folder holds.
            </BaseNotice>

            <!--
              The acknowledgement belongs under the sentence it acknowledges, not two blocks
              below it with a heading in between.
            -->
            <label
              v-if="destinationEmptiness === 'occupied' && destinationUnusable === null"
              class="mt-1.5 flex items-start gap-2 border-t border-line/60 pt-2 text-xs"
            >
              <BaseCheckbox
                v-model="acknowledgeNotEmpty"
                data-testid="acknowledge-not-empty"
                tone="danger"
                class="mt-0.5"
              />
              <span>
                <span class="font-medium text-ink">Move into it anyway</span>
                <span class="block text-[11px] leading-relaxed text-muted">
                  Merging two libraries into one folder is a legitimate thing to want, and an
                  accident worth one click.
                </span>
              </span>
            </label>
          </template>
        </div>
      </section>

      <section class="space-y-2">
        <div class="flex items-baseline justify-between gap-3">
          <p class="text-[10px] font-semibold tracking-wide text-faint uppercase">
            Instances rooting at <span class="font-mono normal-case">{{ props.fromPath }}</span>
          </p>
          <!-- Only worth a control when there is more than one thing for it to act on. -->
          <label
            v-if="candidates.length > 1"
            class="flex items-center gap-1.5 text-[11px] text-muted"
          >
            <BaseCheckbox
              :model-value="allSelected"
              :indeterminate="included.length > 0 && !allSelected"
              data-testid="select-all-instances"
              @change="toggleAll()"
            />
            all
          </label>
        </div>

        <ul v-if="candidates.length > 0" class="space-y-1">
          <li v-for="candidate in candidates" :key="candidate.instanceId">
            <!--
              The row is the hit area and it says which state it is in. Unselected is dimmed
              rather than hidden: which instances root here is a fact about the folder, and
              it stays legible whether or not this switch touches them.
            -->
            <label
              class="flex cursor-pointer items-center justify-between gap-3 rounded-md border px-2.5 py-2 text-xs transition-colors"
              :class="
                included.includes(candidate.instanceId)
                  ? 'border-accent/40 bg-accent/5'
                  : 'border-line bg-raised/40 opacity-60 hover:opacity-100'
              "
            >
              <span class="flex min-w-0 items-center gap-2">
                <BaseCheckbox
                  :model-value="included.includes(candidate.instanceId)"
                  @change="toggle(candidate.instanceId)"
                />
                <BaseInstanceBadge :name="candidate.name" :kind="candidate.kind" size="sm" />
                <span class="truncate text-ink">{{ candidate.name }}</span>
              </span>

              <span class="flex shrink-0 items-center gap-1.5 text-[11px]">
                <span
                  v-if="destination.length > 0 && !candidate.hasDestination"
                  class="rounded border border-sync/40 bg-sync/10 px-1.5 py-0.5 text-sync"
                  title="The destination root folder will be registered here first"
                >
                  <IconCreate size="xs" /> root folder
                </span>
                <span
                  class="rounded border border-line px-1.5 py-0.5 tabular-nums"
                  :class="
                    counts[candidate.instanceId] === 'error' ? 'text-danger' : 'text-muted'
                  "
                >
                  <template v-if="counts[candidate.instanceId] === 'loading'">counting…</template>
                  <template v-else-if="counts[candidate.instanceId] === 'error'">
                    count failed
                  </template>
                  <template v-else>{{ itemsUnder(candidate.instanceId) ?? 0 }} item(s)</template>
                </span>
              </span>
            </label>
          </li>
        </ul>
        <p v-else class="rounded-md border border-dashed border-line px-3 py-2 text-[11px] text-muted">
          No instance roots at this folder.
        </p>

        <!--
          One line about what happens to the bytes, and it is the truth for the case at hand.
          A counted zero is not a warning at all - it is the ordinary state of a root folder
          nothing has been downloaded into yet, and the switch is a create and a delete.
        -->
        <BaseNotice
          v-if="chosen.length > 0"
          :tone="relocation === 'some' ? 'danger' : relocation === 'unknown' ? 'warn' : 'neutral'"
          variant="panel"
          data-testid="relocation-notice"
        >
          <template v-if="relocation === 'counting'">
            Counting what each instance has under this folder…
          </template>
          <template v-else-if="relocation === 'unknown'">
            Fleetarr could not count {{ countsFailed }} of the selected instance(s), so it cannot
            say how much moves - only that whatever is there will be relocated by *Arr, which is
            slow and cannot be undone from here.
          </template>
          <template v-else-if="relocation === 'none'">
            Nothing is registered under this folder on the selected instance(s), so no files
            move. This only re-points the registration: the destination is added, and
            <span class="font-mono">{{ props.fromPath }}</span> is dropped.
          </template>
          <template v-else>
            *Arr will physically relocate {{ totalMedia }} item(s). This is slow and Fleetarr
            cannot undo it. If the files are <em>already</em> at the destination, close this and
            use rename &amp; align instead - that re-points without moving a byte.
          </template>
        </BaseNotice>
      </section>

      <section class="space-y-2">
        <p class="text-[10px] font-semibold tracking-wide text-faint uppercase">Options</p>

        <div class="space-y-2.5 rounded-md border border-line bg-raised/40 px-3 py-2.5">
          <label class="flex items-start gap-2 text-xs">
            <BaseCheckbox v-model="removeOld" data-testid="remove-old" class="mt-0.5" />
            <span>
              <span class="font-medium text-ink">Stop rooting at {{ props.fromPath }}</span>
              <span class="block text-[11px] leading-relaxed text-muted">
                Staged as a dependent step - it only runs if that instance's move succeeded.
              </span>
            </span>
          </label>
        </div>

        <div
          v-if="strandedCollections.length > 0"
          class="space-y-2 rounded-md border px-3 py-2.5"
          :class="repointCollections ? 'border-line bg-raised/40' : 'border-drift/40 bg-drift/5'"
          data-testid="stranded-collections"
        >
          <label class="flex items-start gap-2 text-xs">
            <BaseCheckbox
              v-model="repointCollections"
              data-testid="repoint-collections"
              class="mt-0.5"
            />
            <span>
              <span class="font-medium text-ink">
                Aim {{ strandedCollections.length }} collection(s) at the new folder
              </span>
              <span class="block text-[11px] leading-relaxed text-muted">
                A monitored collection re-adds its films on the next sync. Left pointing at
                <span class="font-mono">{{ props.fromPath }}</span>, it refills the folder the
                media just left.
              </span>
            </span>
          </label>

          <ul class="space-y-0.5 pl-6 font-mono text-[10px]">
            <li
              v-for="entry in strandedCollections"
              :key="`${entry.instanceId}-${entry.collectionId}`"
            >
              <span class="text-ink">{{ entry.title }}</span>
              <span v-if="!entry.monitored" class="text-faint"> (not monitored)</span>
              <span class="text-faint"> {{ entry.from }}</span>
              <template v-if="repointCollections && destination.length > 0">
                <span class="text-faint"> → </span><span class="text-sync">{{ entry.to }}</span>
              </template>
            </li>
          </ul>

          <BaseNotice v-if="!repointCollections" tone="warn">
            Left alone, so re-point them in Radarr yourself.
          </BaseNotice>
        </div>

        <!--
          An absent line here would read as "there were none", and the switch would look
          complete while a collection it could not see refilled the old folder.
        -->
        <BaseNotice
          v-if="collectionsUnknownOn.length > 0"
          tone="warn"
          data-testid="collections-unknown"
        >
          {{ collectionsUnknownOn.join(', ') }} did not report their collections - none of
          theirs are being re-pointed.
        </BaseNotice>

        <div
          v-if="strandedLists.length > 0"
          class="space-y-2 rounded-md border px-3 py-2.5"
          :class="repointLists ? 'border-line bg-raised/40' : 'border-drift/40 bg-drift/5'"
          data-testid="stranded-lists"
        >
          <label class="flex items-start gap-2 text-xs">
            <BaseCheckbox v-model="repointLists" data-testid="repoint-lists" class="mt-0.5" />
            <span>
              <span class="font-medium text-ink">
                Aim {{ strandedLists.length }} import list(s) at the new folder
              </span>
              <span class="block text-[11px] leading-relaxed text-muted">
                A list is what refills a folder after the media leaves it. Left pointing at
                <span class="font-mono">{{ props.fromPath }}</span>, it undoes this switch one
                sync at a time.
              </span>
            </span>
          </label>

          <ul class="space-y-0.5 pl-6 font-mono text-[10px]">
            <li v-for="list in strandedLists" :key="`${list.instanceId}-${list.importListId}`">
              <span class="text-ink">{{ list.name }}</span>
              <span class="text-faint"> {{ list.from }}</span>
              <template v-if="repointLists && destination.length > 0">
                <span class="text-faint"> → </span><span class="text-sync">{{ list.to }}</span>
              </template>
            </li>
          </ul>

          <BaseNotice v-if="!repointLists" tone="warn">
            Left alone, so re-point them on the instance yourself.
          </BaseNotice>
        </div>
      </section>

      <!-- the exact chain, in words -->
      <section
        v-if="chosen.length > 0 && destination.length > 0"
        class="rounded-lg border border-staged/40 bg-staged/5 px-3 py-2.5"
      >
        <p class="mb-1.5 text-[10px] font-semibold tracking-wide text-staged uppercase">
          What will be staged
        </p>
        <ol class="space-y-1 text-[11px] text-muted">
          <li v-for="(step, index) in plan" :key="index">
            <span class="font-mono text-ink">{{ index + 1 }}.</span>
            <template v-for="(part, partIndex) in step" :key="partIndex"
              ><span
                :class="[part.mono === true ? 'font-mono' : '', part.tone === 'danger' ? 'text-danger' : '']"
                >{{ part.text }}</span
              ></template
            >
          </li>
        </ol>
        <p v-if="registrationOnly.length > 0" class="mt-2 text-[11px] leading-relaxed text-muted">
          {{ registrationOnly.map((candidate) => candidate.name).join(', ') }}
          {{ registrationOnly.length === 1 ? 'holds' : 'hold' }} nothing under
          <span class="font-mono">{{ props.fromPath }}</span
          >, so there is nothing to move - only the registration changes.
        </p>
        <p class="mt-2 text-[11px] leading-relaxed text-muted">
          <template v-if="relocation === 'some'">
            Applying this means *Arr <em>accepted</em> the move, not that it finished - the files
            keep moving in the background.
          </template>
          <span class="font-mono">{{ props.fromPath }}</span> is left on disk; delete it from its
          own row once *Arr is done with it. If a step fails the run pauses, which can leave one
          instance switched and another not.
        </p>
      </section>
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
