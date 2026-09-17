<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { PathOwner } from '@fleetarr/shared';
import BaseButton from '@/components/base/BaseButton.vue';
import BaseInstanceBadge from '@/components/base/BaseInstanceBadge.vue';
import { placeAnchored } from '@/lib/anchor';
import { ownerFacts } from '@/lib/path-matrix';
import { TONE_CLASSES, type OpPresentation } from '@/lib/staging';

/**
 * Everything one instance has to say about one folder.
 *
 * It exists because the chip could not: "Radarr-4K" alone answers *whether* an instance
 * uses a folder and nothing about how much, what keeps filling it, or whether the
 * instance can even see it. Those are the questions that decide whether a folder is safe
 * to re-point or delete, and they were previously only in a `title` attribute.
 *
 * Positioned `fixed` and teleported to the body on purpose: the table scrolls
 * horizontally, and an absolutely positioned card inside it would be clipped by that
 * scroll container at exactly the rows near the bottom edge.
 */
const props = defineProps<{
  owner: PathOwner;
  /** The folder the card is about. */
  path: string;
  /** Viewport coordinates of the chip that opened this. */
  anchor: { readonly top: number; readonly bottom: number; readonly left: number };
  /** What is already staged against this instance for this folder, if anything. */
  staged: OpPresentation | null;
}>();

const emit = defineEmits<{ remove: []; close: [] }>();

const card = ref<HTMLElement | null>(null);
const placed = ref<{ left: number; top: number } | null>(null);

const facts = computed(() => ownerFacts(props.owner, props.path));
const removable = computed(() => props.owner.use === 'rootFolder');

const TONE_TEXT = {
  normal: 'text-ink',
  warn: 'text-drift',
  muted: 'text-faint',
} as const;

/**
 * Below the chip, flipped above it when there is no room, clamped to the viewport - the
 * rule now lives in `placeAnchored`, since the picker's list needs exactly the same one.
 *
 * Measured after mount rather than guessed: the card's height depends on how many facts
 * the owner has, and a card that opens half off-screen is worse than no card.
 */
function place(): void {
  const element = card.value;
  if (element === null) return;

  const { width, height } = element.getBoundingClientRect();
  placed.value = placeAnchored({ ...props.anchor, width }, { width, height });
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

/**
 * Any scroll moves the chip out from under the card, and re-placing a card whose anchor
 * has moved would be a lie about which chip it belongs to. Capturing, because the table
 * is its own scroll container and its scroll never reaches the window.
 */
function onScroll(): void {
  emit('close');
}

onMounted(() => {
  place();
  window.addEventListener('keydown', onKey);
  window.addEventListener('scroll', onScroll, { capture: true });
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('scroll', onScroll, { capture: true });
});
</script>

<template>
  <div
    ref="card"
    role="dialog"
    :aria-label="`How ${owner.name} uses ${path}`"
    data-testid="owner-card"
    class="fixed z-50 w-72 rounded-lg border border-line-strong bg-surface p-3 text-xs shadow-xl"
    :style="{
      left: `${String(placed?.left ?? anchor.left)}px`,
      top: `${String(placed?.top ?? anchor.bottom)}px`,
      visibility: placed === null ? 'hidden' : 'visible',
    }"
  >
    <header class="flex items-center gap-2">
      <BaseInstanceBadge :name="owner.name" :kind="owner.kind" />
      <span class="min-w-0 flex-1 truncate font-semibold text-ink">{{ owner.name }}</span>
      <span class="text-[10px] tracking-wide text-faint uppercase">{{ owner.kind }}</span>
    </header>

    <p
      v-if="staged"
      class="mt-2 rounded border px-1.5 py-0.5 text-[10px]"
      :class="TONE_CLASSES[staged.tone]"
    >
      <component :is="staged.icon" size="xs" /> {{ staged.label }} staged for this folder
    </p>

    <dl class="mt-2 space-y-1.5 border-t border-line pt-2">
      <div v-for="fact in facts" :key="fact.label" class="flex gap-2">
        <dt class="w-20 shrink-0 text-[10px] tracking-wide text-faint uppercase">{{ fact.label }}</dt>
        <dd class="min-w-0 flex-1">
          <p class="text-[11px]" :class="TONE_TEXT[fact.tone]">{{ fact.value }}</p>
          <p
            v-for="line in fact.detail"
            :key="line"
            class="truncate font-mono text-[10px] text-muted"
            :title="line"
          >
            {{ line }}
          </p>
        </dd>
      </div>
    </dl>

    <div v-if="removable" class="mt-2 flex justify-end border-t border-line pt-2">
      <BaseButton size="sm" variant="danger" @click="emit('remove')">
        Unassign root folder
      </BaseButton>
    </div>
  </div>
</template>
