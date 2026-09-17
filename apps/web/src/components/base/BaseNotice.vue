<script setup lang="ts">
import { computed, type Component } from 'vue';
import IconCheck from '@/components/base/icons/IconCheck.vue';
import IconError from '@/components/base/icons/IconError.vue';
import IconHelp from '@/components/base/icons/IconHelp.vue';
import IconWarning from '@/components/base/icons/IconWarning.vue';

/**
 * A line of prose that carries a severity.
 *
 * Why it exists: fourteen sites had written `<p class="flex gap-2 text-danger"><IconWarning
 * class="mt-0.5" /> …` by hand, and the copies had drifted in all three ways that matter.
 * Some lines had a glyph and their neighbours in the same stack had none, so the prose in
 * one box started at three different x positions. The glyphs are deliberately different
 * sizes - the light triangle is `h-4.5`, the dense circle `h-3`, which is the pairing
 * `icons.test.ts` pins - so even the lines that all had one did not line up. And because a
 * flex container makes an anonymous item of every contiguous text run, any line whose prose
 * contained an `<em>` or a `<span>` was silently broken into two or three columns squeezed
 * side by side; that is a real bug that shipped, and it is structurally impossible here
 * because the slot renders inside one element.
 *
 * So the glyph sits in a fixed-width rail rather than in the text flow. The rail is as wide
 * as the widest glyph in the set, it is there whether or not this tone draws one, and the
 * prose therefore begins at the same place on every line of every stack - including the
 * neutral ones, which by the app's severity rules draw nothing at all.
 */

/**
 * `neutral` is a statement of fact with no severity - the folder is there, the count is
 * still running. It draws no glyph, which is the same rule the folder rows follow for
 * `info` severity, and it keeps the rail so a fact and a fault still line up.
 */
type NoticeTone = 'neutral' | 'info' | 'sync' | 'warn' | 'danger';

/**
 * `line` is a row inside a box a caller already drew; `panel` draws its own. Two variants
 * rather than two components because the only difference is the box, and a caller choosing
 * between them must not also get to choose a different colour for the same severity.
 */
type NoticeVariant = 'line' | 'panel';

const props = withDefaults(
  defineProps<{
    tone?: NoticeTone;
    variant?: NoticeVariant;
    /**
     * Overrides the tone's glyph, never its colour. For the handful of lines whose meaning
     * is narrower than their severity - "this will be created", "nobody answered" - where
     * the right glyph is not the one the severity implies.
     */
    icon?: Component;
  }>(),
  { tone: 'neutral', variant: 'line', icon: undefined },
);

const TONES: Record<
  NoticeTone,
  { readonly text: string; readonly panel: string; readonly glyph: Component | null }
> = {
  neutral: { text: 'text-muted', panel: 'border-line bg-raised/40', glyph: null },
  info: { text: 'text-accent', panel: 'border-accent/40 bg-accent/5', glyph: IconHelp },
  sync: { text: 'text-sync', panel: 'border-sync/40 bg-sync/5', glyph: IconCheck },
  warn: { text: 'text-drift', panel: 'border-drift/40 bg-drift/5', glyph: IconWarning },
  danger: { text: 'text-danger', panel: 'border-danger/40 bg-danger/5', glyph: IconError },
};

const glyph = computed(() => props.icon ?? TONES[props.tone].glyph);

const classes = computed(() => [
  'flex items-start gap-2 text-[11px] leading-relaxed',
  TONES[props.tone].text,
  props.variant === 'panel' ? `rounded-md border px-3 py-2 ${TONES[props.tone].panel}` : '',
]);
</script>

<template>
  <div :class="classes">
    <!--
      No comment may sit beside this root: a sibling comment node makes the component a
      fragment, and Vue then stops inheriting `class` onto it - silently, since fallthrough
      has nowhere to land. Same trap BaseIcon documents.

      The rail is `w-4.5` because that is the tallest glyph in the set, and it centres what
      it holds so a narrower one still lands on the same axis. `mt-px` against the first
      line of `leading-relaxed` 11px text is the optical match for the icons' own baseline
      nudge - `mt-0.5` reads a hair low at this size.
    -->
    <span class="mt-px flex w-4.5 shrink-0 justify-center">
      <component :is="glyph" v-if="glyph" />
    </span>
    <span class="min-w-0 flex-1"><slot /></span>
  </div>
</template>
