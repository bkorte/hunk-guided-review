import type {
  ExtensionChangeset,
  ExtensionPaneControls,
  ExtensionCommandContext,
  ExtensionDiffFile,
  ExtensionEventContext,
  ExtensionLineHighlight,
  ExtensionLineHighlightTone,
  ExtensionPaneSize,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import { readFile } from "node:fs/promises";
import {
  changesetKey,
  deleteCachedGuide,
  filePatchHash,
  mergeReviewMarks,
  readCachedGuide,
  readReviewMarks,
  reviewedPathsFromMarks,
  writeCachedGuide,
  writeReviewMarks,
} from "./src/cache.ts";
import {
  GUIDE_JSON_SCHEMA,
  normalizeGuide,
  orderedLocations,
  orderFilesByGuide,
  parseStoredGuide,
  type ReviewGuide,
} from "./src/guide.ts";
import { runHarnessStructured } from "./src/harness.ts";
import { GuidePane } from "./src/pane.tsx";
import { buildPromptFiles, inventoryOf, renderPrompt, splitPatchHunks, SYSTEM_PROMPT } from "./src/prompt.ts";
import { applyGuideNotes, removeGuideNotes } from "./src/session.ts";
import { readSettings } from "./src/settings.ts";
import {
  beginGenerating,
  currentSectionIndex,
  fileByPath,
  getState,
  loadFiles,
  markViewed,
  setAdvanceSettings,
  setError,
  setGuide,
  setHideReviewed,
  setNotes,
  setPinnedSection,
  setReviewedFiles,
  setSelected,
  subscribe,
  tick,
  toggleFileReviewed,
  toggleSectionReviewed,
  type FileRef,
} from "./src/store.ts";

/** Internal handshake from the `hunk guide` CLI command to the review it delegates to; consumed on first read. */
const AUTO_ENV = "HUNK_GUIDED_REVIEW_AUTO";
/** Path to a guide JSON (for example from `scripts/generate.ts --json`) to adopt for the loaded review. */
const GUIDE_FILE_ENV = "HUNK_GUIDED_REVIEW_GUIDE";

/** API generations that introduced surfaces this extension uses opportunistically. */
const API_WITH_CLI_COMMANDS = 10;
const API_WITH_DIM_TONE = 11;
const API_WITH_FRACTION_WIDTH = 12;

/** The `dim` tone exists from API 11; older hosts never see these marks. */
const DIM_TONE = "dim" as ExtensionLineHighlightTone;

/** `registerCliCommand` as shipped from API 10, typed locally so older type packages still compile. */
interface CliCommandHost {
  registerCliCommand(
    command: { name: string; summary: string; usage?: string },
    handler: (
      args: readonly string[],
      ctx: { cwd: string; stdout: { write(text: string): Promise<void> }; stderr: { write(text: string): Promise<void> } },
    ) => Promise<{ kind: "exit"; code?: number } | { kind: "delegate"; argv: string[] }>,
  ): void;
}
const PANE_ID = "guide";
const FILES_PANE_ID = "hunk:files";
const DIM_HIGHLIGHTER_ID = "low-signal";

function toFileRefs(files: readonly ExtensionDiffFile[]): FileRef[] {
  return files.map((file) => ({ id: file.id, path: file.path, hunkCount: file.hunks?.length ?? 0 }));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Hunk keeps at most 2,000 marks per file from one highlighter; stay under it so a huge file is not refused. */
const MAX_DIM_MARKS_PER_FILE = 1_900;

/** Section kinds whose hunks are painted dim so low-signal changes recede. */
const LOW_SIGNAL_KINDS = new Set(["generated", "cleanup"]);

/** Hunk indexes (0-based) per path that should render dimmed under the current guide. */
export function dimmedHunksByPath(guide: ReviewGuide | null, reviewedFiles: ReadonlySet<string>): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  if (!guide) return result;
  guide.sections.forEach((section) => {
    const lowSignal = LOW_SIGNAL_KINDS.has(section.kind);
    for (const location of section.locations) {
      if (!lowSignal && !reviewedFiles.has(location.path)) continue;
      let set = result.get(location.path);
      if (!set) {
        set = new Set();
        result.set(location.path, set);
      }
      set.add(location.hunk - 1);
    }
  });
  return result;
}

/** Dim marks covering every line of the given hunks of one file. */
export function dimMarksForFile(file: ExtensionDiffFile, hunkIndexes: ReadonlySet<number>): ExtensionLineHighlight[] {
  const marks: ExtensionLineHighlight[] = [];
  const texts = splitPatchHunks(file.patch);
  const summaries = file.hunks ?? [];
  if (texts.length !== summaries.length) return marks;
  summaries.forEach((summary, index) => {
    if (!hunkIndexes.has(index)) return;
    let oldLine = summary.oldRange?.[0] ?? 0;
    let newLine = summary.newRange?.[0] ?? 0;
    const lines = texts[index]!.split("\n").slice(1);
    for (const raw of lines) {
      if (marks.length >= MAX_DIM_MARKS_PER_FILE) return;
      if (raw.startsWith("\\")) continue;
      const length = Math.max(1, raw.length - 1);
      if (raw.startsWith("-")) {
        if (oldLine > 0) marks.push({ side: "old", line: oldLine, range: [0, length], tone: DIM_TONE });
        oldLine += 1;
      } else if (raw.startsWith("+")) {
        if (newLine > 0) marks.push({ side: "new", line: newLine, range: [0, length], tone: DIM_TONE });
        newLine += 1;
      } else {
        if (newLine > 0) marks.push({ side: "new", line: newLine, range: [0, length], tone: DIM_TONE });
        oldLine += 1;
        newLine += 1;
      }
    }
  });
  return marks;
}

export default function registerGuidedReview(hunk: HunkExtensionAPI) {
  const settings = readSettings(hunk.config);
  setAdvanceSettings(settings.advanceOnSectionReviewed, settings.advanceOnFileReviewed);
  let latestFiles: readonly ExtensionDiffFile[] = [];
  let latestTitle = "";
  let latestSourceLabel = "";
  let generation: AbortController | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let highlightsDirty = false;
  /** Current per-file patch hashes and the repo the marks belong to, for persisting reviewed files. */
  let fileHashes = new Map<string, string>();
  let marksRoot: string | null = null;
  let persistedReviewed: ReadonlySet<string> | null = null;
  let persistQueue: Promise<void> = Promise.resolve();

  /**
   * Whenever the reviewed set changes: write it to disk, serialized so writes
   * never race, and mark the dimming stale. Pane clicks cannot refresh
   * highlights themselves, so the next guide command catches up.
   */
  const onReviewedChange = () => {
    const { reviewedFiles } = getState();
    if (!marksRoot || reviewedFiles === persistedReviewed) return;
    persistedReviewed = reviewedFiles;
    highlightsDirty = true;
    const root = marksRoot;
    const hashes = fileHashes;
    persistQueue = persistQueue
      .then(async () => {
        const marks = await readReviewMarks(root);
        await writeReviewMarks(root, mergeReviewMarks(marks, hashes, reviewedFiles));
      })
      .catch((error) => hunk.log(`could not save reviewed marks: ${describeError(error)}`));
  };
  const unsubscribeReviewed = subscribe(onReviewedChange);

  const width: ExtensionPaneSize = { preferred: settings.paneWidth, min: 28 };
  if (hunk.apiVersion >= API_WITH_FRACTION_WIDTH) {
    (width as ExtensionPaneSize & { fraction?: number }).fraction = 0.3;
  }
  hunk.registerPane({
    id: PANE_ID,
    title: "Review guide",
    placement: settings.placement,
    width,
    component: GuidePane,
  });

  /** The guide that applies to a changeset, from memory or the cache, without touching UI state. */
  async function guideFor(files: readonly ExtensionDiffFile[]): Promise<ReviewGuide | null> {
    const key = changesetKey(files);
    const state = getState();
    if (state.guide && state.guide.changesetKey === key) return state.guide;
    return settings.cache ? readCachedGuide(key) : null;
  }

  // Order the review stream by section, and optionally drop reviewed files, whenever a guide exists.
  hunk.transformChangeset(async (changeset) => {
    const guide = await guideFor(changeset.files);
    if (!guide) return changeset;
    let files = settings.reorderFiles ? orderFilesByGuide(changeset.files, guide) : changeset.files;
    const { hideReviewed, reviewedFiles } = getState();
    if (hideReviewed) files = files.filter((file) => !reviewedFiles.has(file.path));
    return { ...changeset, files };
  });

  const dimAvailable = settings.dimLowSignal && hunk.apiVersion >= API_WITH_DIM_TONE;
  if (dimAvailable) {
    hunk.registerLineHighlighter({
      id: DIM_HIGHLIGHTER_ID,
      highlight({ file }) {
        const state = getState();
        if (!state.guide || state.stale) return null;
        const dimmed = dimmedHunksByPath(state.guide, state.reviewedFiles).get(file.path);
        return dimmed && dimmed.size > 0 ? dimMarksForFile(file, dimmed) : null;
      },
    });
  }

  const refreshHighlights = (ctx: ExtensionCommandContext) => {
    if (!dimAvailable) return;
    ctx.highlights.refresh(DIM_HIGHLIGHTER_ID);
    highlightsDirty = false;
  };

  /** Show the guide pane, taking the files pane's place when configured to. */
  const showGuidePane = (panes: ExtensionPaneControls) => {
    panes.open(PANE_ID);
    if (settings.replaceFilesPane) panes.close(FILES_PANE_ID);
  };
  /** Hide the guide pane and give the files pane back. */
  const hideGuidePane = (panes: ExtensionPaneControls) => {
    panes.close(PANE_ID);
    if (settings.replaceFilesPane) panes.open(FILES_PANE_ID);
  };

  /** Re-run the changeset transform (file order, hidden files) through Hunk's own refresh. */
  const refreshReview = (ctx: ExtensionCommandContext): boolean =>
    ctx.commands.isEnabled("hunk.app.refresh") && ctx.commands.execute("hunk.app.refresh");

  const startTicker = () => {
    if (ticker) return;
    ticker = setInterval(tick, 500);
  };
  const stopTicker = () => {
    if (ticker) clearInterval(ticker);
    ticker = null;
  };

  async function pushNotes(cwd: string, guide: ReviewGuide, notify: (message: string, type?: "info" | "warning" | "error") => void) {
    if (!settings.inlineNotes) return;
    const state = getState();
    if (state.notesKey === guide.changesetKey && state.noteIds.length > 0) return;
    try {
      if (state.noteIds.length > 0) await removeGuideNotes(cwd, state.noteIds);
      const ids = await applyGuideNotes(cwd, guide);
      setNotes(ids, guide.changesetKey);
    } catch (error) {
      setNotes([], null);
      notify(`Guide ready, but inline notes failed: ${describeError(error)}`, "warning");
    }
  }

  interface GenerateOptions {
    force?: boolean;
    focus?: string;
    cwd: string;
    notify: (message: string, type?: "info" | "warning" | "error") => void;
    openPane: () => void;
    /** Reload the review so the transform reorders files; absent in event handlers. */
    refresh?: () => boolean;
  }

  /** After a guide lands, reorder the review stream or tell the user how to. */
  function reorderAfterGuide(options: GenerateOptions) {
    if (!settings.reorderFiles) return;
    if (options.refresh?.()) return;
    options.notify("Press r to reorder files by section");
  }

  async function generate(options: GenerateOptions): Promise<void> {
    if (getState().status === "generating") {
      options.notify("A guide is already being generated", "warning");
      return;
    }
    const files = latestFiles;
    const key = changesetKey(files);
    if (files.length === 0 || key !== getState().changesetKey) {
      options.notify("No reviewable changes loaded yet", "warning");
      return;
    }

    if (!options.force && settings.cache) {
      const cached = await readCachedGuide(key);
      if (cached) {
        setGuide(cached, true);
        options.openPane();
        highlightsDirty = true;
        options.notify(`Loaded a cached guide with ${cached.sections.length} sections`);
        await pushNotes(options.cwd, cached, options.notify);
        reorderAfterGuide(options);
        return;
      }
    }

    const promptFiles = buildPromptFiles(files);
    const inventory = inventoryOf(promptFiles);
    if (inventory.every((file) => file.hunkCount === 0)) {
      options.notify("Nothing to guide: no text hunks in this review", "warning");
      return;
    }
    const prompt = renderPrompt(promptFiles, {
      title: latestTitle || "Working tree changes",
      sourceLabel: latestSourceLabel,
      maxChars: settings.maxPromptChars,
      focus: options.focus,
    });

    generation?.abort();
    const controller = new AbortController();
    generation = controller;
    beginGenerating();
    startTicker();
    options.openPane();
    options.notify(`Generating review guide with ${settings.harness}…`);

    try {
      const result = await runHarnessStructured({
        harness: settings.harness,
        cwd: options.cwd,
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        schema: GUIDE_JSON_SCHEMA,
        model: settings.model,
        provider: settings.provider,
        maxTurns: settings.maxTurns,
        tools: settings.tools,
        timeoutMs: settings.timeoutMs,
        signal: controller.signal,
      });
      const guide = normalizeGuide(result.output, inventory, {
        changesetKey: key,
        model: result.model,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
      });
      if (controller.signal.aborted) return;
      setGuide(guide, false);
      highlightsDirty = true;
      if (settings.cache) {
        await writeCachedGuide(guide).catch((error) => hunk.log(`cache write failed: ${describeError(error)}`));
      }
      const cost = result.costUsd !== undefined ? ` · $${result.costUsd.toFixed(2)}` : "";
      const seconds = Math.round(result.durationMs / 1000);
      options.notify(
        `Guide ready: ${guide.sections.length} sections${guide.unassigned ? `, ${guide.unassigned} unassigned` : ""} · ${seconds}s${cost}`,
      );
      await pushNotes(options.cwd, guide, options.notify);
      reorderAfterGuide(options);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = describeError(error);
      setError(message);
      hunk.log(`generation failed: ${message}`);
      options.notify(`Guide generation failed: ${message}`, "error");
    } finally {
      if (generation === controller) generation = null;
      if (!generation) stopTicker();
    }
  }

  const eventOptions = (ctx: ExtensionEventContext): GenerateOptions => ({
    cwd: ctx.cwd,
    notify: ctx.notify,
    openPane: () => showGuidePane(ctx.panes),
  });
  const commandOptions = (ctx: ExtensionCommandContext): GenerateOptions => ({
    cwd: ctx.cwd,
    notify: ctx.notify,
    openPane: () => showGuidePane(ctx.panes),
    refresh: () => refreshReview(ctx),
  });

  async function onChangeset(changeset: ExtensionChangeset, ctx: ExtensionEventContext) {
    latestFiles = changeset.files;
    latestTitle = changeset.title;
    latestSourceLabel = changeset.sourceLabel;
    const key = changesetKey(changeset.files);
    const previousKey = getState().changesetKey;
    loadFiles(toFileRefs(changeset.files), key);

    // Restore reviewed marks for these exact file contents before anything else reads them.
    fileHashes = new Map(changeset.files.map((file) => [file.path, filePatchHash(file.patch)]));
    marksRoot = ctx.cwd;
    const marks = await readReviewMarks(ctx.cwd);
    if (getState().changesetKey !== key) return;
    const restored = reviewedPathsFromMarks(marks, fileHashes);
    persistedReviewed = null;
    setReviewedFiles(restored);
    persistedReviewed = getState().reviewedFiles;
    if (key === previousKey) return;

    const auto = process.env[AUTO_ENV] === "1";
    if (auto) delete process.env[AUTO_ENV];

    const seededPath = process.env[GUIDE_FILE_ENV];
    if (seededPath) {
      try {
        const stored = parseStoredGuide(await readFile(seededPath, "utf8"));
        if (!stored) throw new Error("not a review guide file");
        const inventory = inventoryOf(buildPromptFiles(changeset.files));
        const guide = normalizeGuide(stored, inventory, {
          changesetKey: key,
          generatedAt: stored.generatedAt,
          model: stored.model,
          costUsd: stored.costUsd,
          durationMs: stored.durationMs,
        });
        if (getState().changesetKey !== key) return;
        setGuide(guide, true);
        highlightsDirty = true;
        showGuidePane(ctx.panes);
        ctx.notify(`Loaded review guide from ${seededPath}`);
        await pushNotes(ctx.cwd, guide, ctx.notify);
        reorderAfterGuide(eventOptions(ctx));
        return;
      } catch (error) {
        ctx.notify(`Could not load ${GUIDE_FILE_ENV}: ${describeError(error)}`, "warning");
      }
    }

    if (settings.cache) {
      const cached = await readCachedGuide(key);
      if (cached && getState().changesetKey === key) {
        setGuide(cached, true);
        highlightsDirty = true;
        showGuidePane(ctx.panes);
        await pushNotes(ctx.cwd, cached, ctx.notify);
        return;
      }
    }
    if ((auto || settings.autoGenerate) && changeset.files.length > 0) {
      await generate({ ...eventOptions(ctx), force: false });
    }
  }

  hunk.on("changeset_loaded", ({ changeset }, ctx) => onChangeset(changeset, ctx));
  hunk.on("selection_changed", ({ fileId, hunkIndex }) => {
    setSelected(fileId, hunkIndex);
    if (fileId !== null && hunkIndex !== null) {
      const file = getState().files.find((entry) => entry.id === fileId);
      if (file) markViewed(file.path, hunkIndex + 1);
    }
  });
  hunk.on("shutdown", () => {
    generation?.abort();
    generation = null;
    stopTicker();
    unsubscribeReviewed();
  });

  /** Resolve the reviewer's current place in the guide's reading order, or -1. */
  function currentStepIndex(ctx: ExtensionCommandContext, guide: ReviewGuide): number {
    const { file, hunkIndex } = ctx.selection;
    if (!file || hunkIndex === null) return -1;
    return orderedLocations(guide).findIndex(
      (location) => location.path === file.path && location.hunk === hunkIndex + 1,
    );
  }

  function jumpTo(ctx: ExtensionCommandContext, path: string, hunk: number): boolean {
    const snapshot = ctx.review.snapshot();
    const runtimeId =
      snapshot?.files.find((file) => file.path === path)?.runtimeId ?? fileByPath(getState(), path)?.id;
    if (!runtimeId) {
      ctx.notify(`${path} is not in the current review`, "warning");
      return false;
    }
    ctx.navigation.selectHunk(runtimeId, hunk - 1);
    return true;
  }

  /** Reviewed marks affect dimming always and the file list when hiding is on. */
  function afterReviewedChange(ctx: ExtensionCommandContext) {
    refreshHighlights(ctx);
    if (getState().hideReviewed && !refreshReview(ctx)) ctx.notify("Press r to apply the change to the review");
  }

  function requireGuide(ctx: ExtensionCommandContext): ReviewGuide | null {
    const state = getState();
    if (highlightsDirty) refreshHighlights(ctx);
    if (!state.guide) {
      ctx.notify(
        state.status === "generating" ? "The guide is still being generated" : "No review guide yet; generate one first",
        "warning",
      );
      return null;
    }
    return state.guide;
  }

  hunk.registerCommand(
    { id: "generate", title: "Generate review guide", key: "ctrl+g" },
    async (ctx) => {
      const state = getState();
      if (state.guide && !state.stale && state.status !== "generating") {
        showGuidePane(ctx.panes);
        refreshHighlights(ctx);
        const choice = await ctx.dialogs.select({
          title: "A review guide already exists",
          options: ["Show the guide", "Regenerate", "Regenerate with a focus…"],
        });
        if (choice === null || choice === "Show the guide") return;
        const focus =
          choice === "Regenerate with a focus…"
            ? await ctx.dialogs.input({ title: "What should the guide focus on?", placeholder: "e.g. the migration and its rollback" })
            : undefined;
        if (choice === "Regenerate with a focus…" && focus === null) return;
        await generate({ ...commandOptions(ctx), force: true, focus: focus ?? undefined });
        refreshHighlights(ctx);
        return;
      }
      await generate({ ...commandOptions(ctx), force: state.stale });
      refreshHighlights(ctx);
    },
  );

  hunk.registerCommand({ id: "regenerate", title: "Regenerate review guide" }, async (ctx) => {
    const key = getState().changesetKey;
    if (key && settings.cache) await deleteCachedGuide(key).catch(() => undefined);
    await generate({ ...commandOptions(ctx), force: true });
    refreshHighlights(ctx);
  });

  hunk.registerCommand({ id: "cancel", title: "Cancel guide generation" }, (ctx) => {
    if (!generation) {
      ctx.notify("Nothing is being generated");
      return;
    }
    generation.abort();
    generation = null;
    stopTicker();
    setError("cancelled");
    ctx.notify("Cancelled guide generation");
  });

  hunk.registerCommand({ id: "toggle", title: "Toggle review guide pane", key: "ctrl+t" }, (ctx) => {
    if (ctx.panes.isOpen(PANE_ID)) hideGuidePane(ctx.panes);
    else showGuidePane(ctx.panes);
    if (highlightsDirty) refreshHighlights(ctx);
  });

  hunk.registerCommand({ id: "next-step", title: "Guide: next hunk", key: "n" }, (ctx) => {
    const guide = requireGuide(ctx);
    if (!guide) return;
    const order = orderedLocations(guide);
    const index = currentStepIndex(ctx, guide);
    const next = order[index + 1];
    if (!next) {
      ctx.notify(index === -1 ? "Guide has no hunks to visit" : "End of the guide");
      return;
    }
    jumpTo(ctx, next.path, next.hunk);
  });

  hunk.registerCommand({ id: "prev-step", title: "Guide: previous hunk", key: "p" }, (ctx) => {
    const guide = requireGuide(ctx);
    if (!guide) return;
    const order = orderedLocations(guide);
    const index = currentStepIndex(ctx, guide);
    const previous = index === -1 ? order[0] : order[index - 1];
    if (!previous) {
      ctx.notify("Start of the guide");
      return;
    }
    jumpTo(ctx, previous.path, previous.hunk);
  });

  hunk.registerCommand({ id: "next-section", title: "Guide: next section", key: "N" }, (ctx) => {
    const guide = requireGuide(ctx);
    if (!guide) return;
    const current = currentSectionIndex(getState());
    const target = guide.sections[current + 1];
    if (!target) {
      ctx.notify(current === -1 ? "Guide has no sections" : "Last section of the guide");
      return;
    }
    setPinnedSection(current + 1);
    const first = target.locations[0]!;
    jumpTo(ctx, first.path, first.hunk);
  });

  hunk.registerCommand({ id: "prev-section", title: "Guide: previous section", key: "P" }, (ctx) => {
    const guide = requireGuide(ctx);
    if (!guide) return;
    const current = currentSectionIndex(getState());
    const targetIndex = current === -1 ? 0 : current - 1;
    const target = guide.sections[targetIndex];
    if (!target) {
      ctx.notify("First section of the guide");
      return;
    }
    setPinnedSection(targetIndex);
    const first = target.locations[0]!;
    jumpTo(ctx, first.path, first.hunk);
  });

  hunk.registerCommand(
    { id: "toggle-reviewed", title: "Guide: mark current section reviewed", key: "ctrl+x" },
    (ctx) => {
      const guide = requireGuide(ctx);
      if (!guide) return;
      const current = currentSectionIndex(getState());
      if (current === -1) {
        ctx.notify("Select a hunk inside a guide section first", "warning");
        return;
      }
      const { reviewed, next } = toggleSectionReviewed(current);
      ctx.notify(`${reviewed ? "Marked" : "Unmarked"} section ${current + 1}: ${guide.sections[current]!.title}`);
      if (next === null) ctx.notify("All sections reviewed");
      else if (next) jumpTo(ctx, next.path, next.hunk);
      afterReviewedChange(ctx);
    },
  );

  hunk.registerCommand(
    { id: "toggle-file-reviewed", title: "Guide: mark current file reviewed", key: "x" },
    (ctx) => {
      const guide = requireGuide(ctx);
      if (!guide) return;
      const file = ctx.selection.file;
      if (!file) {
        ctx.notify("Select a file first", "warning");
        return;
      }
      const { reviewed, next } = toggleFileReviewed(file.path, Math.max(0, currentSectionIndex(getState())));
      ctx.notify(`${reviewed ? "Marked" : "Unmarked"} ${file.path} reviewed`);
      if (next === null) ctx.notify("All files reviewed");
      else if (next) jumpTo(ctx, next.path, next.hunk);
      afterReviewedChange(ctx);
    },
  );

  hunk.registerCommand({ id: "hide-reviewed", title: "Guide: hide/show reviewed files" }, (ctx) => {
    const guide = requireGuide(ctx);
    if (!guide) return;
    const hide = !getState().hideReviewed;
    setHideReviewed(hide);
    if (!refreshReview(ctx)) ctx.notify("Press r to apply the change to the review");
    ctx.notify(hide ? "Reviewed files are hidden from the review" : "Reviewed files are shown again");
  });

  hunk.registerCommand({ id: "apply-notes", title: "Guide: add explanations as inline notes" }, async (ctx) => {
    const guide = requireGuide(ctx);
    if (!guide) return;
    setNotes([], null);
    try {
      const ids = await applyGuideNotes(ctx.cwd, guide);
      setNotes(ids, guide.changesetKey);
      ctx.notify(`Added ${ids.length} guide notes to the review`);
    } catch (error) {
      ctx.notify(`Could not add notes: ${describeError(error)}`, "error");
    }
  });

  hunk.registerCommand({ id: "clear-notes", title: "Guide: remove inline notes" }, async (ctx) => {
    const ids = getState().noteIds;
    if (ids.length === 0) {
      ctx.notify("No guide notes to remove");
      return;
    }
    await removeGuideNotes(ctx.cwd, ids);
    setNotes([], null);
    ctx.notify(`Removed ${ids.length} guide notes`);
  });

  const cliHost = hunk as unknown as Partial<CliCommandHost>;
  if (hunk.apiVersion < API_WITH_CLI_COMMANDS || typeof cliHost.registerCliCommand !== "function") {
    return;
  }
  cliHost.registerCliCommand(
    {
      name: "guide",
      summary: "Open a review and generate its guide right away",
      usage: "[diff|show] [target] [-- <pathspec...>]",
    },
    async (args, ctx) => {
      if (args[0] === "--help" || args[0] === "-h") {
        await ctx.stdout.write(
          [
            "Usage: hunk guide [diff|show] [target] [-- <pathspec...>]",
            "",
            "Opens the review like `hunk diff` (or `hunk show`) and generates a",
            "review guide with the configured harness as soon as the changes load.",
            "",
            "Examples:",
            "  hunk guide                 # working tree",
            "  hunk guide --staged        # staged changes",
            "  hunk guide main...HEAD     # a range",
            "  hunk guide show HEAD~1     # one commit",
            "",
          ].join("\n"),
        );
        return { kind: "exit", code: 0 };
      }
      const [first, ...rest] = args;
      const command = first === "diff" || first === "show" ? first : "diff";
      const forwarded = first === "diff" || first === "show" ? rest : args;
      process.env[AUTO_ENV] = "1";
      return { kind: "delegate", argv: [command, ...forwarded] };
    },
  );
}
