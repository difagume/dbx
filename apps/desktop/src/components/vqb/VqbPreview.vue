<script setup lang="ts">
import { computed } from "vue";
import type { VqbDatabaseType } from "@/lib/vqb/model";

const props = defineProps<{
  sql: string | null;
  errors: string[];
  databaseType: VqbDatabaseType;
  planSupported: boolean;
}>();

const emit = defineEmits<{
  (e: "open-in-editor"): void;
  (e: "run"): void;
}>();

const isSqliteFallback = computed(() => props.databaseType === "sqlite" || !props.planSupported);
</script>

<template>
  <section aria-label="SQL preview" data-testid="vqb-preview">
    <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preview</h3>
    <pre v-if="props.sql" data-testid="vqb-preview-sql" class="overflow-x-auto whitespace-pre-wrap rounded border bg-muted/40 p-2 font-mono text-xs">{{ props.sql }}</pre>
    <p v-else data-testid="vqb-preview-empty" class="rounded border border-dashed p-2 text-xs text-muted-foreground">Add a table and select a column to preview SQL.</p>
    <ul v-if="props.errors.length > 0" data-testid="vqb-preview-errors" class="mt-1 space-y-1">
      <li v-for="error in props.errors" :key="error" class="text-xs text-destructive">{{ error }}</li>
    </ul>
    <p v-if="isSqliteFallback && props.sql" data-testid="vqb-preview-text-fallback" class="mt-1 text-xs text-muted-foreground">Text preview only — plan view is unavailable for this engine.</p>
    <div class="mt-2 flex gap-1">
      <button type="button" data-testid="vqb-open-in-editor" class="rounded border px-1.5 py-0.5 text-xs" :disabled="!props.sql || props.errors.length > 0" @click="emit('open-in-editor')">Open in editor</button>
      <button type="button" data-testid="vqb-run" class="rounded border px-1.5 py-0.5 text-xs" :disabled="!props.sql || props.errors.length > 0" @click="emit('run')">Run</button>
    </div>
    <p v-if="props.errors.length > 0" data-testid="vqb-run-blocked-hint" class="mt-1 text-xs text-muted-foreground">Run is blocked until the model is valid.</p>
  </section>
</template>
