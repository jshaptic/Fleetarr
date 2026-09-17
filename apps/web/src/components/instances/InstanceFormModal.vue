<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ConnectionTestResult, Instance, InstanceKind } from '@fleetarr/shared';
import BaseButton from '@/components/base/BaseButton.vue';
import BaseModal from '@/components/base/BaseModal.vue';
import BaseSelect from '@/components/base/BaseSelect.vue';
import type { SelectOption } from '@/components/base/select';
import { ApiRequestError } from '@/api/client';
import { useInstancesStore } from '@/stores/instances';
import { useMatrixStore } from '@/stores/matrix';
import { useUiStore } from '@/stores/ui';
import IconCheck from '@/components/base/icons/IconCheck.vue';
import IconError from '@/components/base/icons/IconError.vue';
import BaseCheckbox from '@/components/base/BaseCheckbox.vue';

const KIND_OPTIONS: readonly SelectOption<InstanceKind>[] = [
  { value: 'radarr', label: 'Radarr (movies)' },
  { value: 'sonarr', label: 'Sonarr (series)' },
];

const props = withDefaults(defineProps<{ instance?: Instance | null }>(), { instance: null });
const emit = defineEmits<{ close: [] }>();

const instances = useInstancesStore();
const matrix = useMatrixStore();
const ui = useUiStore();

const editing = computed(() => props.instance !== null);

const name = ref(props.instance?.name ?? '');
const kind = ref<InstanceKind>(props.instance?.kind ?? 'radarr');
const baseUrl = ref(props.instance?.baseUrl ?? '');
const apiKey = ref('');
const verifySsl = ref(props.instance?.verifySsl ?? true);
const timeoutMs = ref(props.instance?.timeoutMs ?? 20_000);

const testing = ref(false);
const saving = ref(false);
const testResult = ref<ConnectionTestResult | null>(null);

const canTest = computed(() => baseUrl.value.trim().length > 0 && apiKey.value.trim().length >= 8);
const canSave = computed(
  () =>
    name.value.trim().length > 0 &&
    baseUrl.value.trim().length > 0 &&
    (editing.value || apiKey.value.trim().length >= 8),
);

function messageOf(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return error instanceof Error ? error.message : 'Request failed';
}

async function test(): Promise<void> {
  testing.value = true;
  try {
    testResult.value = await instances.testCandidate({
      kind: kind.value,
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value.trim(),
      verifySsl: verifySsl.value,
      timeoutMs: timeoutMs.value,
    });
  } catch (error) {
    testResult.value = { ok: false, error: { code: 'request_failed', message: messageOf(error) } };
  } finally {
    testing.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const result = editing.value
      ? await instances.update(props.instance?.id ?? 0, {
          name: name.value.trim(),
          kind: kind.value,
          baseUrl: baseUrl.value.trim(),
          verifySsl: verifySsl.value,
          timeoutMs: timeoutMs.value,
          ...(apiKey.value.trim().length > 0 ? { apiKey: apiKey.value.trim() } : {}),
        })
      : await instances.create({
          name: name.value.trim(),
          kind: kind.value,
          baseUrl: baseUrl.value.trim(),
          apiKey: apiKey.value.trim(),
          verifySsl: verifySsl.value,
          timeoutMs: timeoutMs.value,
        });

    if (result?.ok === false) {
      ui.notify('error', `Saved, but the instance did not answer: ${result.error?.message ?? ''}`);
    } else {
      ui.notify('success', `${name.value.trim()} saved and reachable`);
    }

    await matrix.load({ refresh: true });
    emit('close');
  } catch (error) {
    ui.notify('error', messageOf(error));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <BaseModal
    :title="editing ? `Edit ${props.instance?.name ?? ''}` : 'Connect an instance'"
    subtitle="Fleetarr stores the API key encrypted and never returns it to the browser"
    @close="emit('close')"
  >
    <div class="space-y-3">
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block">
          <span class="mb-1 block text-xs text-muted">Name</span>
          <input
            v-model="name"
            type="text"
            placeholder="Radarr-4K"
            class="w-full rounded-md border border-line bg-raised px-3 py-2 text-sm text-ink outline-none focus:border-accent"
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-xs text-muted">Application</span>
          <BaseSelect v-model="kind" :options="KIND_OPTIONS" class="w-full" />
        </label>
      </div>

      <label class="block">
        <span class="mb-1 block text-xs text-muted">Base URL (include any reverse-proxy path)</span>
        <input
          v-model="baseUrl"
          type="text"
          placeholder="http://192.168.1.10:7878"
          class="w-full rounded-md border border-line bg-raised px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent"
        />
      </label>

      <label class="block">
        <span class="mb-1 block text-xs text-muted">
          API key
          <span v-if="editing" class="text-faint">(leave blank to keep the stored key)</span>
        </span>
        <input
          v-model="apiKey"
          type="password"
          autocomplete="off"
          placeholder="Settings → General → API Key"
          class="w-full rounded-md border border-line bg-raised px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent"
        />
      </label>

      <div class="grid gap-3 sm:grid-cols-2">
        <label class="flex items-center gap-2 text-xs text-muted">
          <BaseCheckbox v-model="verifySsl" />
          Verify SSL certificate
        </label>
        <label class="flex items-center gap-2 text-xs text-muted">
          Timeout
          <input
            v-model.number="timeoutMs"
            type="number"
            min="1000"
            max="120000"
            step="1000"
            class="w-24 rounded-md border border-line bg-raised px-2 py-1 text-right font-mono text-xs text-ink outline-none focus:border-accent"
          />
          ms
        </label>
      </div>

      <div
        v-if="testResult"
        class="rounded-md border px-3 py-2 text-[11px] leading-relaxed"
        :class="
          testResult.ok
            ? 'border-sync/40 bg-sync/5 text-sync'
            : 'border-danger/40 bg-danger/5 text-danger'
        "
      >
        <template v-if="testResult.ok">
          <IconCheck size="xs" /> Connected to {{ testResult.instanceName ?? 'the instance' }} · version
          {{ testResult.appVersion }}
        </template>
        <template v-else>
          <IconError /> {{ testResult.error?.code }}: {{ testResult.error?.message }}
        </template>
      </div>
    </div>

    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">Cancel</BaseButton>
      <BaseButton :disabled="!canTest" :loading="testing" @click="test()">
        Test connection
      </BaseButton>
      <BaseButton variant="primary" :disabled="!canSave" :loading="saving" @click="save()">
        {{ editing ? 'Save changes' : 'Add instance' }}
      </BaseButton>
    </template>
  </BaseModal>
</template>
