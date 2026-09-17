<script setup lang="ts">
import { computed, type Component } from 'vue';
import type { PathNode, PathSeverity, QueueItem } from '@fleetarr/shared';
import IconCollapsed from '@/components/base/icons/IconCollapsed.vue';
import IconCreate from '@/components/base/icons/IconCreate.vue';
import IconDelete from '@/components/base/icons/IconDelete.vue';
import IconEdit from '@/components/base/icons/IconEdit.vue';
import IconError from '@/components/base/icons/IconError.vue';
import IconExpanded from '@/components/base/icons/IconExpanded.vue';
import IconFile from '@/components/base/icons/IconFile.vue';
import IconFocus from '@/components/base/icons/IconFocus.vue';
import IconLoading from '@/components/base/icons/IconLoading.vue';
import IconMerge from '@/components/base/icons/IconMerge.vue';
import IconMove from '@/components/base/icons/IconMove.vue';
import IconSymlink from '@/components/base/icons/IconSymlink.vue';
import IconWarning from '@/components/base/icons/IconWarning.vue';
import PathFlagBadge from './PathFlagBadge.vue';
import PathOwnerChips from './PathOwnerChips.vue';
import { formatBytes, formatRelativeTime } from '@/lib/format';
import {
  actionsFor,
  alignTargetsFor,
  FLAG_STYLES,
  mediaSummary,
  SEVERITY_STYLES,
  type PathAction,
} from '@/lib/path-matrix';
import { stagedIntent, TONE_CLASSES } from '@/lib/staging';
import BaseCheckbox from '@/components/base/BaseCheckbox.vue';

const props = defineProps<{
  node: PathNode;
  depth: number;
  /**
   * A row in the flat list, where there is no tree to walk: no twisty, and no focus, since
   * both only mean something next to a hierarchy.
   */
  flat: boolean;
  /** Instances that could not be read, so an empty Used-by cell is not read as "nobody". */
  unknownCount: number;
  expanded: boolean;
  /**
   * Kept by the filter only as a way down to something that might match, rather than
   * being a match itself. Dimmed, so a filtered tree still reads as an answer.
   */
  onTheWay?: boolean;
  /** Worst severity inside this node, when its level is loaded. */
  childSeverity: PathSeverity | null;
  busy: boolean;
  loading: boolean;
  /**
   * Whether this row can be selected at all - a leaf folder, in either view.
   *
   * A folder the tree renders children under is not a selection target: every batch action
   * the toolbar offers is about the folder itself (root folders live on leaves, and a
   * prune or a rename is per folder), so a parent's checkbox would only ever mean "and not
   * the four rows indented under it", which is not a thing anyone wants to say.
   */
  selectable: boolean;
  selected: boolean;
  measured: number | null;
  measuring: boolean;
  stagedForPath: readonly QueueItem[];
  stagedForCell: (instanceId: number, path: string) => readonly QueueItem[];
}>();

const emit = defineEmits<{
  toggle: [];
  select: [];
  measure: [];
  action: [action: PathAction];
  ownerRemove: [target: { instanceId: number; rootFolderId: number | null }];
}>();

const ACTION_LABELS: Record<Exclude<PathAction, 'focus'>, string> = {
  addRoot: 'add root folder',
  remap: 'switch root folder',
  rename: 'rename',
  move: 'move',
  prune: 'remove',
};

/** Every row action is an icon next to the name; the title is what names it. */
const ACTION_ICONS: Record<Exclude<PathAction, 'focus'>, Component> = {
  addRoot: IconCreate,
  remap: IconMerge,
  rename: IconEdit,
  move: IconMove,
  prune: IconDelete,
};

/**
 * `align` is not a button of its own any more - it is what a rename does when the folder is
 * somebody's root folder, or the parent of one, chosen per instance inside the one dialog.
 * The title still says so, because the difference between the two renames is the whole point.
 */
function labelFor(action: Exclude<PathAction, 'focus'>): string {
  return action === 'rename' && alignTargetsFor(props.node).length > 0
    ? 'rename & align'
    : ACTION_LABELS[action];
}

const allActions = computed(() => actionsFor(props.node));
/**
 * Path-column actions. `addRoot` lives in Used by, after the owner chips, and only on a
 * leaf - a parent with children under it is a place to look, not a place to attach a root.
 */
const actions = computed(() =>
  allActions.value.filter(
    (action): action is Exclude<PathAction, 'focus' | 'addRoot'> =>
      action !== 'focus' && action !== 'addRoot',
  ),
);
const canAddRoot = computed(() => props.selectable && allActions.value.includes('addRoot'));
const canFocus = computed(() => !props.flat && allActions.value.includes('focus'));
const intent = computed(() => stagedIntent(props.stagedForPath));
const media = computed(() => mediaSummary(props.node));

/**
 * The badges that still need words.
 *
 * `mount` and `rootFolder` are the folder's colour: a blue name is a filesystem
 * mount, a green name is a root folder. A badge there would repeat the thing the
 * row is organised around. That leaves the badge row meaning "something is off here".
 */
const badges = computed(() =>
  props.node.flags.filter((flag) => flag !== 'mount' && flag !== 'rootFolder'),
);

const isMount = computed(() => props.node.flags.includes('mount'));
const isRootFolder = computed(() => props.node.flags.includes('rootFolder'));

const severity = computed(() => SEVERITY_STYLES[props.node.severity]);

/**
 * Why the glyph is there, in the badge vocabulary rather than in flag ids.
 *
 * A root folder its own instance cannot see is the one severity with no flag behind it,
 * so it has to name itself or the glyph would appear with an empty reason.
 */
const severityTitle = computed(() => {
  if (badges.value.length > 0) {
    return `This folder needs attention: ${badges.value.map((flag) => FLAG_STYLES[flag].label).join(', ')}`;
  }
  if (props.node.owners.some((owner) => owner.use === 'rootFolder' && owner.accessible === false)) {
    return 'An instance reports its own root folder here as not accessible';
  }
  return props.node.lowSpace
    ? 'This filesystem is below the low-space threshold'
    : 'This folder needs attention';
});

/**
 * A dimmed warning for a collapsed folder whose children need attention, so a problem two
 * levels down is not invisible until you go looking for it. Only when the row's own state
 * is quiet - it would be noise next to the row's own glyph.
 */
const inheritedSeverity = computed(() => {
  if (severity.value !== null || props.expanded) return null;
  if (props.childSeverity === null) return null;
  return SEVERITY_STYLES[props.childSeverity];
});

const twistyIcon = computed<Component>(() => {
  if (props.loading) return IconLoading;
  if (props.node.kind === 'symlink') return IconSymlink;
  if (!props.node.exists) return IconError;
  if (props.node.kind !== 'directory') return IconFile;
  return props.expanded ? IconExpanded : IconCollapsed;
});

/**
 * Hoisted out of the template so the button can say the same thing twice - as a tooltip
 * for a mouse and as an accessible name for everyone else. Its only content is an icon,
 * so without the second the control has no name at all.
 */
const twistyTitle = computed(() => {
  if (props.loading) return 'Reading…';
  if (isRootFolder.value) return 'Root folders are not expanded here';
  if (!props.node.expandable) return 'Nothing to expand here';
  return props.expanded ? 'Collapse' : 'Expand';
});

/** A root folder is a leaf on purpose - the chevron stays, it just is not a control. */
const rootFolderLeaf = computed(() => isRootFolder.value);

/**
 * A top-level row is a mount or a root folder this container cannot see; either way the
 * basename alone ("movies") would not say where it is, so those show the whole path.
 */
const label = computed(() =>
  props.depth === 0 || !props.node.inScope ? props.node.path : props.node.name,
);

const nameClasses = computed(() => {
  const classes: string[] = [];
  // Dimmed rather than hidden: this folder is the route to a match, not a match.
  if (props.onTheWay === true) classes.push('opacity-45');
  // A mount is a section header: few of them, and everything below sits on that disk.
  if (isMount.value) classes.push('font-semibold');

  if (!props.node.exists || intent.value?.tone === 'destroy') {
    return [...classes, 'text-danger', 'line-through'];
  }
  // The badges these replaced. Colour scales where a chip does not: a fleet of 79 root
  // folders used to be 79 identical chips saying the thing the row is about. A mount
  // is rarer, so the same idea (colour the name) plus weight is enough to scan for.
  if (isRootFolder.value) return [...classes, 'text-sync'];
  if (isMount.value) return [...classes, 'text-accent'];
  return [...classes, 'text-ink'];
});

/**
 * A mount row is a faint band, so a long tree still shows where one filesystem ends
 * and the next begins. Selected wins: the accent wash is the stronger "this one".
 */
const rowClasses = computed(() => {
  if (props.selected) return 'bg-accent/5';
  return isMount.value ? 'bg-raised hover:bg-overlay' : 'hover:bg-raised/40';
});

const pathCellClasses = computed(() => {
  if (props.selected) return 'bg-[#16202b]';
  return isMount.value ? 'bg-raised' : 'bg-surface';
});

/** The disk facts that do not earn a column of their own, in one tooltip. */
const diskTitle = computed(() => {
  const lines = [props.node.path];
  if (props.onTheWay === true) lines.push('on the way to a match - it does not match the filter itself');
  if (isMount.value) lines.push('a configured filesystem mount - hence the blue name');
  if (isRootFolder.value) lines.push('a root folder - hence the green name');
  if (props.node.modifiedAt !== null) lines.push(`modified ${formatRelativeTime(props.node.modifiedAt)}`);
  if (props.node.exists && props.node.inScope) {
    lines.push(props.node.readable ? (props.node.writable ? 'read-write' : 'read-only') : 'no read access');
  }
  if (props.node.deviceId !== null) lines.push(`filesystem ${props.node.deviceId}`);
  return lines.join('\n');
});

const spaceTitle = computed(() => {
  if (props.node.freeSpace === null) return 'Free space not evaluated for this path';
  const share =
    props.node.totalSpace === null || props.node.totalSpace === 0
      ? ''
      : ` (${String(Math.round((props.node.freeSpace / props.node.totalSpace) * 100))}%)`;
  const of = props.node.totalSpace === null ? '' : ` of ${formatBytes(props.node.totalSpace)}`;
  return `${formatBytes(props.node.freeSpace)} free${of}${share}${props.node.lowSpace ? ' - below the low-space threshold' : ''}`;
});

/**
 * One tree step equals the twisty column (`w-4` = 1rem). The checkbox stays in a
 * column of its own, so this padding is only the fold-and-name tree. A child's
 * chevron sits exactly one column to the right of its parent's, and folder names
 * at the same depth share a left edge.
 */
const treeIndent = computed(() =>
  props.flat || props.depth === 0 ? undefined : { paddingLeft: `${String(props.depth)}rem` },
);
</script>

<template>
  <tr
    class="group"
    :class="rowClasses"
    :data-path="node.path"
    :data-mount="isMount ? 'true' : undefined"
  >
    <th
      scope="row"
      class="sticky left-0 z-10 border-b border-line px-3 py-1.5 text-left font-normal"
      :class="pathCellClasses"
    >
      <div class="flex items-center gap-1.5">
        <BaseCheckbox
          v-if="selectable"
          :model-value="selected"
          :title="`Select ${node.path}`"
          @change="emit('select')"
        />
        <!-- Alignment only: a parent has no checkbox, but same-depth names still have
             to line up with rows that do. -->
        <span
          v-else
          class="w-3.5 shrink-0"
          title="This folder holds subfolders - select those instead"
          data-testid="no-checkbox"
        ></span>

        <div
          data-testid="path-tree"
          class="flex min-w-0 flex-1 items-center gap-1.5"
          :style="treeIndent"
        >
          <div class="flex min-w-0 flex-1 items-center gap-1.5">
            <template v-if="!flat">
              <button
                v-if="!rootFolderLeaf"
                type="button"
                data-testid="path-twisty"
                class="flex w-4 shrink-0 items-center justify-center transition-colors hover:text-ink disabled:opacity-30"
                :class="loading ? 'animate-spin text-accent' : 'text-faint'"
                :disabled="!node.expandable || loading"
                :title="twistyTitle"
                :aria-label="twistyTitle"
                @click="emit('toggle')"
              >
                <component :is="twistyIcon" size="sm" />
              </button>
              <span
                v-else
                data-testid="path-twisty"
                class="flex w-4 shrink-0 items-center justify-center text-faint/40"
                :title="twistyTitle"
              >
                <IconCollapsed size="sm" />
              </span>
            </template>

            <span
              data-name
              class="min-w-0 truncate font-mono"
              :class="nameClasses"
              :title="diskTitle"
            >
              {{ label }}
            </span>

            <!-- Free space is a filesystem fact, so it lives on the mount, not in a
                 column that would repeat the same number on every child. -->
            <span
              v-if="isMount && node.freeSpace !== null"
              data-free-space
              class="shrink-0 font-mono text-[11px] whitespace-nowrap"
              :class="node.lowSpace ? 'text-drift' : 'text-faint'"
              :title="spaceTitle"
            >
              <IconWarning v-if="node.lowSpace" data-low-space="true" class="mr-0.5" />
              {{ formatBytes(node.freeSpace) }} free
            </span>

            <!-- Staged work and the glyph stay by the name. Word badges sit after the
                 row actions, at the right of the Path column, so `empty` does not sit
                 between the folder and the buttons that act on it. -->
            <span
              v-if="intent"
              class="shrink-0 rounded border px-1.5 py-0.5 text-[10px]"
              :class="TONE_CLASSES[intent.tone]"
              :title="`${intent.label} is staged for this folder`"
            >
              <component :is="intent.icon" size="xs" /> staged
            </span>

            <span
              v-if="severity"
              class="flex w-4 shrink-0 justify-end text-[11px]"
              :class="severity.classes"
              :title="severityTitle"
              data-severity="own"
            >
              <component :is="severity.icon" />
            </span>
            <span
              v-else-if="inheritedSeverity"
              class="flex w-4 shrink-0 justify-end text-[11px] opacity-40"
              :class="inheritedSeverity.classes"
              title="Something inside this folder needs attention"
              data-severity="child"
            >
              <component :is="inheritedSeverity.icon" />
            </span>
          </div>

          <span
            v-if="actions.length > 0"
            class="inline-flex shrink-0 items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <button
              v-for="action in actions"
              :key="action"
              type="button"
              class="shrink-0 text-[11px] text-faint transition-colors disabled:opacity-30"
              :class="action === 'prune' ? 'hover:text-danger' : 'hover:text-accent'"
              :disabled="busy"
              :title="labelFor(action)"
              :aria-label="labelFor(action)"
              :data-action="action"
              @click="emit('action', action)"
            >
              <component :is="ACTION_ICONS[action]" size="lg" />
            </button>
          </span>

          <button
            v-if="canFocus"
            type="button"
            data-testid="path-focus"
            class="shrink-0 text-[11px] text-faint transition-colors hover:text-accent"
            title="Focus: re-root this view at this folder"
            aria-label="Focus this folder"
            :disabled="busy"
            @click="emit('action', 'focus')"
          >
            <IconFocus />
          </button>

          <PathFlagBadge v-for="flag in badges" :key="flag" :flag="flag" class="shrink-0" />
        </div>
      </div>
    </th>

    <PathOwnerChips
      :owners="node.owners"
      :path="node.path"
      :unknown-count="unknownCount"
      :staged="stagedForCell"
      :can-add-root="canAddRoot"
      :busy="busy"
      @add-root="emit('action', 'addRoot')"
      @remove="emit('ownerRemove', $event)"
    />

    <!-- media -->
    <td class="border-b border-l border-line px-2 py-1.5 text-[11px] text-muted">
      <span v-if="media" class="truncate" :title="media.detail">{{ media.label }}</span>
      <span v-else class="text-faint">—</span>
    </td>

    <!-- disk facts -->
    <td class="border-b border-l border-line px-2 py-1.5 font-mono text-[11px] text-muted">
      <template v-if="measured !== null">{{ formatBytes(measured) }}</template>
      <template v-else-if="node.sizeOnDisk !== null">{{ formatBytes(node.sizeOnDisk) }}</template>
      <button
        v-else-if="node.kind === 'directory' && node.exists"
        type="button"
        class="text-accent hover:underline"
        :disabled="measuring"
        @click="emit('measure')"
      >
        {{ measuring ? 'measuring…' : 'measure' }}
      </button>
      <span v-else>—</span>
    </td>

    <td class="border-b border-l border-line px-2 py-1.5 text-[11px] whitespace-nowrap text-faint">
      {{ node.modifiedAt === null ? '—' : formatRelativeTime(node.modifiedAt) }}
    </td>
  </tr>
</template>
