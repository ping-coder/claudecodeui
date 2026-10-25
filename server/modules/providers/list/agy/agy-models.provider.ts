import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { getAgyCliHome, resolveAgyCliPath } from '@/shared/agy-cli-path.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

/** One `agy models` row: the id passed to `--model`, and its display label. */
type AgyModelEntry = { value: string; label: string };

/**
 * agy reports no per-model effort, but it accepts `--effort` with these
 * levels for every model; the composer's effort menu reads them per option.
 */
const AGY_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

const createAgyModelOption = ({ value, label }: AgyModelEntry): ProviderModelOption => ({
  value,
  label,
  effort: { values: AGY_EFFORT_LEVELS.map((level) => ({ value: level })) },
});

/**
 * Catalog shown when `agy models` cannot be read (agy missing, signed out,
 * offline, or too slow). Mirrors the CLI's own listing.
 *
 * Used by AgyProviderModels as its fallback and by the provider capabilities
 * tests, which check that `effortLevels` covers every level declared here.
 */
export const AGY_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'auto', label: 'Gemini Pro Next' },
    { value: 'gemini-flash-next', label: 'Gemini Flash Next' },
    { value: 'gemini-launch-candidate-high', label: 'Gemini 4 Argon (High)' },
    { value: 'gemini-launch-candidate-medium', label: 'Gemini 4 Argon (Medium)' },
    { value: 'gemini-launch-candidate-low', label: 'Gemini 4 Argon (Low)' },
    { value: 'gemini-pro-coordinator', label: 'Gemini Pro Orchestrator' },
    { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { value: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    { value: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
    { value: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
    { value: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro' },
    { value: 'fable-5.1-max', label: 'Claude Fable 5.1 (Max)' },
    { value: 'fable-5.1-high', label: 'Claude Fable 5.1 (High)' },
    { value: 'fable-5.1-medium', label: 'Claude Fable 5.1 (Medium)' },
    { value: 'fable-5.1-low', label: 'Claude Fable 5.1 (Low)' },
    { value: 'opus-5.5-max', label: 'Claude Opus 5.5 (Max)' },
    { value: 'opus-5.5-high', label: 'Claude Opus 5.5 (High)' },
    { value: 'opus-5.5-medium', label: 'Claude Opus 5.5 (Medium)' },
    { value: 'opus-5.5-low', label: 'Claude Opus 5.5 (Low)' },
  ].map(createAgyModelOption),
  DEFAULT: 'auto',
};

/** The model agy picks on its own, used as DEFAULT when settings name none the catalog knows. */
const AGY_AUTO_MODEL = 'auto';

/** `agy models` asks the backend, so it gets a few seconds before the fallback is used. */
const AGY_MODELS_TIMEOUT_MS = 5_000;
/** How long agy's output may stay open after `agy models` exited cleanly. */
const AGY_MODELS_EXIT_GRACE_MS = 500;
/** How long a successful listing is served before it is refreshed. */
const AGY_MODELS_CACHE_TTL_MS = 10 * 60_000;
/** Empty or failed listings are retried sooner, so a transient failure does not pin the fallback. */
const AGY_MODELS_EMPTY_CACHE_TTL_MS = 30_000;
const AGY_MODELS_MAX_OUTPUT_BYTES = 1024 * 1024;
/** CLI output is untrusted: only plain ids that cannot read as flags are accepted. */
const AGY_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/**
 * Parses `agy models` output: one `id<TAB>label` row per model. Lines without
 * a tab (the "Fetching available models..." banner, blank lines) are skipped,
 * as is anything whose id does not look like a model id.
 */
function parseAgyModelsOutput(output: string): AgyModelEntry[] {
  const entries = new Map<string, AgyModelEntry>();
  for (const line of output.split(/\r?\n/)) {
    const tabIndex = line.indexOf('\t');
    if (tabIndex < 0) {
      continue;
    }
    const value = line.slice(0, tabIndex).trim();
    if (!AGY_MODEL_ID_PATTERN.test(value) || entries.has(value)) {
      continue;
    }
    const label = line.slice(tabIndex + 1).trim();
    entries.set(value, { value, label: label || value });
  }
  return [...entries.values()];
}

/**
 * Lists the models this machine's agy can run, without a shell. Resolves to
 * an empty list when agy is not installed (nothing is spawned), exits
 * non-zero, or exceeds the timeout, so a cut-off listing is never cached.
 */
const readInstalledAgyModels = (): Promise<AgyModelEntry[]> => {
  const agyPath = resolveAgyCliPath();
  if (!agyPath) {
    return Promise.resolve([]);
  }

  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    let exitGrace: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (entries: AgyModelEntry[]): void => {
      if (!settled) {
        settled = true;
        clearTimeout(exitGrace);
        clearTimeout(deadline);
        resolve(entries);
      }
    };

    // execFile enforces the timeout and the output cap.
    const child = execFile(
      agyPath,
      ['models'],
      {
        encoding: 'utf8',
        timeout: AGY_MODELS_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: AGY_MODELS_MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        finish(error ? [] : parseAgyModelsOutput(stdout));
      },
    );
    child.stdin?.end();
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    // execFile answers only once agy's output closes, which a helper agy
    // started can delay after agy itself exited cleanly; the listing is
    // complete by then.
    child.on('exit', (code) => {
      if (code === 0) {
        exitGrace = setTimeout(() => finish(parseAgyModelsOutput(output)), AGY_MODELS_EXIT_GRACE_MS);
      }
    });
    // Nothing may keep a catalog read waiting past the timeout.
    deadline = setTimeout(() => {
      child.kill('SIGKILL');
      finish([]);
    }, AGY_MODELS_TIMEOUT_MS + AGY_MODELS_EXIT_GRACE_MS);
  });
};

/**
 * Reads the model agy is configured to use from its `settings.json`, which
 * stores the model's display label (e.g. "Gemini 4 Argon (High)"). Only that
 * file is read, never the OAuth token beside it.
 */
const readConfiguredAgyModel = async (): Promise<string | undefined> => {
  try {
    const settings = readObjectRecord(JSON.parse(await readFile(path.join(getAgyCliHome(), 'settings.json'), 'utf8')));
    return readOptionalString(settings?.model);
  } catch {
    return undefined;
  }
};

/**
 * DEFAULT is agy's configured model when the catalog knows it (by label, or
 * by id), else `auto`; when the catalog has no `auto` row, its first model.
 */
const resolveAgyDefaultModel = (options: ProviderModelOption[], configuredModel: string | undefined): string => {
  const wanted = configuredModel?.toLowerCase();
  const configured = wanted
    ? options.find((option) => option.label.trim().toLowerCase() === wanted)
      ?? options.find((option) => option.value.toLowerCase() === wanted)
    : undefined;
  if (configured) {
    return configured.value;
  }
  if (options.length === 0 || options.some((option) => option.value === AGY_AUTO_MODEL)) {
    return AGY_AUTO_MODEL;
  }
  return options[0].value;
};

/** Model catalog of the Antigravity CLI; used by AgyProvider as its models facet. */
export class AgyProviderModels implements IProviderModels {
  /** Last `agy models` listing and when it stops being fresh. */
  private cachedEntries: { entries: AgyModelEntry[]; expiresAt: number } | null = null;

  /** In-flight CLI read, shared so concurrent catalog loads spawn one process. */
  private pendingEntries: Promise<AgyModelEntry[]> | null = null;

  /** Used by the provider registry; the agy models tests inject the listing, the clock, and the settings read. */
  constructor(
    private readonly readModels: () => Promise<AgyModelEntry[]> = readInstalledAgyModels,
    private readonly now: () => number = Date.now,
    private readonly readConfiguredModel: () => Promise<string | undefined> = readConfiguredAgyModel,
  ) {}

  private refreshEntries(): Promise<AgyModelEntry[]> {
    this.pendingEntries ??= this.readModels()
      // The picker stays usable when the CLI invocation fails.
      .catch(() => [] as AgyModelEntry[])
      .then((entries) => {
        const ttl = entries.length > 0 ? AGY_MODELS_CACHE_TTL_MS : AGY_MODELS_EMPTY_CACHE_TTL_MS;
        this.cachedEntries = { entries, expiresAt: this.now() + ttl };
        return entries;
      })
      .finally(() => {
        this.pendingEntries = null;
      });
    return this.pendingEntries;
  }

  /**
   * Serves the cached listing, refreshing it in the background once stale.
   * The catalog is read on every turn and picker load, so only the first read
   * after startup waits on the CLI.
   */
  private async readEntries(): Promise<AgyModelEntry[]> {
    if (!this.cachedEntries) {
      return this.refreshEntries();
    }
    if (this.now() >= this.cachedEntries.expiresAt) {
      void this.refreshEntries();
    }
    return this.cachedEntries.entries;
  }

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const [entries, configuredModel] = await Promise.all([this.readEntries(), this.readConfiguredModel()]);
    const options = entries.length > 0
      ? entries.map(createAgyModelOption)
      : AGY_PREDEFINED_MODELS.OPTIONS;
    return {
      OPTIONS: options,
      DEFAULT: resolveAgyDefaultModel(options, configuredModel),
    };
  }

  /**
   * No per-conversation model is read from agy's store, so this always
   * answers with DEFAULT, which the models service reads as "no answer" and
   * falls back to the session row or the composer's choice.
   */
  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
