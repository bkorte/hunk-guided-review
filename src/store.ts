import { useSyncExternalStore } from "react";
import {
  isSectionReviewed,
  locationKey,
  nextUnreviewedFile,
  nextUnreviewedSection,
  sectionFiles,
  sectionIndexFor,
  type GuideFileStop,
  type ReviewGuide,
} from "./guide.ts";

export type GuideStatus = "idle" | "generating" | "ready" | "error";

/** The reviewed files as last loaded, enough to map ids to paths and back. */
export interface FileRef {
  id: string;
  path: string;
  hunkCount: number;
}

export interface GuideState {
  status: GuideStatus;
  guide: ReviewGuide | null;
  error: string | null;
  /** Content key of the review currently loaded. */
  changesetKey: string | null;
  /** True when the loaded review no longer matches the guide. */
  stale: boolean;
  /** When generation began, for the elapsed counter. */
  startedAt: number | null;
  now: number;
  files: readonly FileRef[];
  selected: { fileId: string; hunkIndex: number } | null;
  /** `path#hunk` keys the reviewer's selection has settled on. */
  viewed: ReadonlySet<string>;
  /** File paths the reviewer marked done; a section is done when all its files are. */
  reviewedFiles: ReadonlySet<string>;
  /** Drop reviewed files from the review stream (session toggle). */
  hideReviewed: boolean;
  /** Move to the next open section or file after marking one reviewed (from settings). */
  advanceOnSectionReviewed: boolean;
  advanceOnFileReviewed: boolean;
  /** Section whose details are expanded when it is not the current one. */
  pinnedSection: number | null;
  /** Ids of live notes this extension added for the current guide. */
  noteIds: readonly string[];
  notesKey: string | null;
  fromCache: boolean;
}

const initialState: GuideState = {
  status: "idle",
  guide: null,
  error: null,
  changesetKey: null,
  stale: false,
  startedAt: null,
  now: 0,
  files: [],
  selected: null,
  viewed: new Set(),
  reviewedFiles: new Set(),
  hideReviewed: false,
  advanceOnSectionReviewed: true,
  advanceOnFileReviewed: true,
  pinnedSection: null,
  noteIds: [],
  notesKey: null,
  fromCache: false,
};

let state = initialState;
const listeners = new Set<() => void>();

export function getState(): GuideState {
  return state;
}

export function update(mutate: (current: GuideState) => GuideState): void {
  const next = mutate(state);
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

/** Observe every state change from outside React; returns an unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGuideState(): GuideState {
  return useSyncExternalStore(subscribe, getState);
}

export function fileById(current: GuideState, id: string | null): FileRef | undefined {
  return id === null ? undefined : current.files.find((file) => file.id === id);
}

export function fileByPath(current: GuideState, path: string): FileRef | undefined {
  return current.files.find((file) => file.path === path);
}

/** The guide section the reviewer's selection sits in, or -1. */
export function currentSectionIndex(current: GuideState): number {
  if (!current.guide || !current.selected) return -1;
  const file = fileById(current, current.selected.fileId);
  if (!file) return -1;
  return sectionIndexFor(current.guide, file.path, current.selected.hunkIndex + 1);
}

export function markViewed(path: string, hunkNumber: number): void {
  const key = locationKey(path, hunkNumber);
  update((current) => {
    if (current.viewed.has(key)) return current;
    return { ...current, viewed: new Set(current.viewed).add(key) };
  });
}

/** What flipping a reviewed mark did, shared by the keyboard commands and the pane's click targets. */
export interface ReviewedToggle {
  reviewed: boolean;
  /** Where auto-advance moves (already pinned), `null` once everything is reviewed, absent when not advancing. */
  next?: GuideFileStop | null;
}

/** Flip a section's reviewed mark; once it is reviewed, find the next open section when advancing is on. */
export function toggleSectionReviewed(sectionIndex: number): ReviewedToggle {
  const guide = state.guide;
  const section = guide?.sections[sectionIndex];
  if (!guide || !section) return { reviewed: false };
  const reviewed = !isSectionReviewed(section, state.reviewedFiles);
  setFilesReviewed(sectionFiles(section), reviewed);
  if (!reviewed || !state.advanceOnSectionReviewed) return { reviewed };
  const next = nextUnreviewedSection(guide, sectionIndex, state.reviewedFiles);
  if (next === -1) return { reviewed, next: null };
  const first = guide.sections[next]!.locations[0]!;
  setPinnedSection(next);
  return { reviewed, next: { sectionIndex: next, path: first.path, hunk: first.hunk } };
}

/** Flip one file's reviewed mark; once it is reviewed, find the next open file after it in reading order. */
export function toggleFileReviewed(path: string, sectionIndex: number): ReviewedToggle {
  const reviewed = !state.reviewedFiles.has(path);
  setFilesReviewed([path], reviewed);
  const guide = state.guide;
  if (!reviewed || !guide || !state.advanceOnFileReviewed) return { reviewed };
  const next = nextUnreviewedFile(guide, sectionIndex, path, state.reviewedFiles);
  if (next) setPinnedSection(next.sectionIndex);
  return { reviewed, next };
}

/** Replace the reviewed set wholesale, used when restoring persisted marks for a loaded review. */
export function setReviewedFiles(paths: readonly string[]): void {
  update((current) => ({ ...current, reviewedFiles: new Set(paths) }));
}

export function setFilesReviewed(paths: readonly string[], reviewed: boolean): void {
  update((current) => {
    const reviewedFiles = new Set(current.reviewedFiles);
    for (const path of paths) {
      if (reviewed) reviewedFiles.add(path);
      else reviewedFiles.delete(path);
    }
    return { ...current, reviewedFiles };
  });
}

export function setAdvanceSettings(section: boolean, file: boolean): void {
  update((current) => ({ ...current, advanceOnSectionReviewed: section, advanceOnFileReviewed: file }));
}

export function setHideReviewed(hideReviewed: boolean): void {
  update((current) => ({ ...current, hideReviewed }));
}

/** Record a newly loaded review, keeping the guide only when its key still matches. */
export function loadFiles(files: readonly FileRef[], key: string): void {
  update((current) => ({
    ...current,
    files,
    changesetKey: key,
    selected: null,
    stale: current.guide !== null && current.guide.changesetKey !== key,
  }));
}

export function setSelected(fileId: string | null, hunkIndex: number | null): void {
  update((current) => ({
    ...current,
    selected: fileId !== null && hunkIndex !== null ? { fileId, hunkIndex } : null,
  }));
}

export function beginGenerating(): void {
  update((current) => ({
    ...current,
    status: "generating",
    error: null,
    startedAt: Date.now(),
    now: Date.now(),
  }));
}

export function tick(): void {
  update((current) => (current.status === "generating" ? { ...current, now: Date.now() } : current));
}

export function setGuide(guide: ReviewGuide, fromCache: boolean): void {
  update((current) => ({
    ...current,
    status: "ready",
    guide,
    error: null,
    startedAt: null,
    stale: current.changesetKey !== null && guide.changesetKey !== current.changesetKey,
    pinnedSection: null,
    fromCache,
  }));
}

export function setError(message: string): void {
  update((current) => ({
    ...current,
    status: current.guide ? "ready" : "error",
    error: message,
    startedAt: null,
  }));
}

export function setNotes(ids: readonly string[], key: string | null): void {
  update((current) => ({ ...current, noteIds: ids, notesKey: key }));
}

export function setPinnedSection(index: number | null): void {
  update((current) => ({ ...current, pinnedSection: index }));
}
