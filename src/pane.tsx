import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ExtensionPaneProps } from "hunkdiff/extension";
import { isSectionReviewed, locationKey, sectionFiles, type GuideSection } from "./guide.ts";
import {
  currentSectionIndex,
  fileById,
  toggleFileReviewed,
  toggleSectionReviewed,
  useGuideState,
  type GuideState,
  type ReviewedToggle,
} from "./store.ts";
import { clipText, justify, wrapText } from "./wrap.ts";

export const EXTENSION_ID = "hunk-guided-review";

/** One clickable run of text; a row is one or more of these side by side. */
export interface Segment {
  text: string;
  fg: string;
  bg?: string;
  onClick?: () => void;
}

export interface Row {
  id?: string;
  segments: Segment[];
}

/** What role a section plays in the change, shown on its button row. */
const KIND_LABEL: Record<GuideSection["kind"], string> = {
  core: "Core change",
  supporting: "Supporting change",
  tests: "Tests",
  config: "Configuration",
  docs: "Documentation",
  generated: "Generated code",
  cleanup: "Cleanup",
};

/** Row width inside the pane rectangle that is fully visible and clickable. */
export function rowWidth(paneWidth: number): number {
  return Math.max(8, paneWidth - 2);
}

export const SECTION_BUTTON_ON = "[✓ section reviewed]";
export const SECTION_BUTTON_OFF = "[ mark section reviewed ]";
export const FILE_BOX_ON = "[✓]";
export const FILE_BOX_OFF = "[ ]";

function riskBadge(risk: GuideSection["risk"]): string {
  return risk === "high" ? "▲ high" : risk === "medium" ? "△ med" : "";
}

function keyHint(keys: readonly string[]): string {
  return keys.length > 0 ? keys[0]! : "";
}

function shortPath(path: string, width: number): string {
  if (path.length <= width) return path;
  const parts = path.split("/");
  let candidate = parts[parts.length - 1]!;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const next = `${parts[index]}/${candidate}`;
    if (next.length + 1 > width) return `…/${candidate}`.length <= width ? `…/${candidate}` : clipText(candidate, width);
    candidate = next;
  }
  return candidate;
}

/** Turn the store plus pane props into rows the pane paints one per line. */
export function buildRows(
  props: Pick<ExtensionPaneProps, "files" | "theme" | "actions" | "keybindings" | "width">,
  state: GuideState,
): Row[] {
  const { theme, keybindings, actions } = props;
  // The host clips the last two columns of the pane rectangle, so rows stop short of them;
  // otherwise trailing click targets lose their hit area.
  const inner = Math.max(8, rowWidth(props.width) - 1);
  const rows: Row[] = [];
  const visibleIdByPath = new Map(props.files.map((file) => [file.path, file.id]));
  const jump = (path: string, hunk: number) => {
    const fileId = visibleIdByPath.get(path);
    if (fileId) actions.selectHunk(fileId, hunk - 1);
  };
  /** Follow a reviewed toggle made from the pane, which cannot refresh the review itself. */
  const followToggle = ({ next }: ReviewedToggle, doneMessage: string) => {
    if (next === null) actions.notify(doneMessage);
    else if (next) jump(next.path, next.hunk);
    if (state.hideReviewed) actions.notify("Press r to apply the change to the review");
  };
  const line = (text: string, fg: string, bg?: string, extra: { id?: string; onClick?: () => void } = {}): Row => ({
    id: extra.id,
    segments: [{ text: ` ${text}`, fg, bg: bg ?? theme.panel, onClick: extra.onClick }],
  });
  const split = (left: string, right: Segment, fg: string, bg?: string, extra: { id?: string; onLeft?: () => void } = {}): Row => {
    const room = Math.max(0, inner - right.text.length - 1);
    const head = clipText(left, room);
    return {
      id: extra.id,
      segments: [
        { text: ` ${head}${" ".repeat(Math.max(0, room - head.length))} `, fg, bg: bg ?? theme.panel, onClick: extra.onLeft },
        { ...right, bg: right.bg ?? bg ?? theme.panel },
      ],
    };
  };

  const generateKey = keyHint(keybindings.getKeys(`${EXTENSION_ID}.generate`));
  const stepKey = keyHint(keybindings.getKeys(`${EXTENSION_ID}.next-step`));
  const sectionKey = keyHint(keybindings.getKeys(`${EXTENSION_ID}.next-section`));
  const doneKey = keyHint(keybindings.getKeys(`${EXTENSION_ID}.toggle-reviewed`));
  const fileDoneKey = keyHint(keybindings.getKeys(`${EXTENSION_ID}.toggle-file-reviewed`));

  const header = state.guide ? justify("Review guide", state.fromCache ? "cached" : "", inner) : "Review guide";
  rows.push(line(header, theme.accent));

  if (state.status === "generating") {
    const seconds = state.startedAt ? Math.max(0, Math.round((state.now - state.startedAt) / 1000)) : 0;
    const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[Math.floor(seconds * 2) % 10];
    rows.push(line(`${spinner} Generating… ${seconds}s`, theme.muted));
    rows.push(line("", theme.text));
  }

  if (state.error) {
    for (const text of wrapText(`Error: ${state.error}`, inner)) rows.push(line(text, theme.badgeRemoved));
    rows.push(line("", theme.text));
  }

  const guide = state.guide;
  if (!guide) {
    if (state.status === "idle") {
      const hint = generateKey
        ? `Press ${generateKey} to generate a guide for this diff.`
        : "Run “Generate review guide” from the Extensions menu.";
      for (const text of wrapText(hint, inner)) rows.push(line(text, theme.muted));
      rows.push(line("", theme.text));
      for (const text of wrapText(
        "The guide splits the change into logical sections, orders them for reading, and explains what to check in each.",
        inner,
      )) {
        rows.push(line(text, theme.muted));
      }
    }
    return rows;
  }

  if (state.stale) {
    for (const text of wrapText(
      `The diff changed since this guide was written${generateKey ? `; press ${generateKey} to regenerate` : ""}.`,
      inner,
    )) {
      rows.push(line(text, theme.fileModified));
    }
    rows.push(line("", theme.text));
  }

  for (const text of wrapText(guide.title, inner)) rows.push(line(text, theme.text));
  for (const text of wrapText(guide.summary, inner)) rows.push(line(text, theme.muted));
  rows.push(line("", theme.text));

  const current = currentSectionIndex(state);
  const expanded = current >= 0 ? current : state.pinnedSection;
  const selectedPath = state.selected ? fileById(state, state.selected.fileId)?.path ?? null : null;
  const allPaths = new Set(guide.sections.flatMap(sectionFiles));
  const reviewedCount = [...allPaths].filter((path) => state.reviewedFiles.has(path)).length;
  const totalLocations = guide.sections.reduce((count, section) => count + section.locations.length, 0);
  const viewedTotal = guide.sections.reduce(
    (count, section) =>
      count + section.locations.filter((location) => state.viewed.has(locationKey(location.path, location.hunk))).length,
    0,
  );
  rows.push(
    line(
      justify(`${viewedTotal}/${totalLocations} hunks seen`, `${reviewedCount}/${allPaths.size} files done`, inner),
      theme.muted,
    ),
  );
  if (state.hideReviewed) rows.push(line("Reviewed files are hidden from the review", theme.muted));

  guide.sections.forEach((section, sectionIndex) => {
    const isCurrent = sectionIndex === current;
    const isExpanded = sectionIndex === expanded;
    const isReviewed = isSectionReviewed(section, state.reviewedFiles);
    const seen = section.locations.filter((location) => state.viewed.has(locationKey(location.path, location.hunk))).length;
    const marker = isReviewed ? "✓" : isCurrent ? "▶" : seen === section.locations.length ? "·" : " ";
    const left = `${marker} ${sectionIndex + 1}. ${section.title}`;
    const right = [riskBadge(section.risk), `${seen}/${section.locations.length}`].filter(Boolean).join("  ");
    const first = section.locations[0]!;
    rows.push(
      line(
        justify(left, right, inner),
        isReviewed ? theme.muted : section.risk === "high" && !isCurrent ? theme.fileModified : isCurrent ? theme.accent : theme.text,
        isCurrent ? theme.selectedHunk : theme.panel,
        { id: `section-${sectionIndex}`, onClick: () => jump(first.path, first.hunk) },
      ),
    );

    if (!isExpanded) return;

    const detailWidth = inner - 3;
    const paths = sectionFiles(section);
    rows.push(
      split(
        `  ${KIND_LABEL[section.kind]}`,
        {
          text: isReviewed ? SECTION_BUTTON_ON : SECTION_BUTTON_OFF,
          fg: isReviewed ? theme.badgeAdded : theme.accent,
          onClick: () => followToggle(toggleSectionReviewed(sectionIndex), "All sections reviewed"),
        },
        theme.muted,
        theme.panel,
        { id: `section-button-${sectionIndex}` },
      ),
    );
    for (const text of wrapText(section.explanation, detailWidth)) rows.push(line(`  ${text}`, theme.text));
    if (section.lookFor.length > 0) {
      rows.push(line("  Look for", theme.noteBorder));
      for (const item of section.lookFor) {
        wrapText(item, detailWidth - 2).forEach((text, index) => {
          rows.push(line(`  ${index === 0 ? "•" : " "} ${text}`, theme.text));
        });
      }
    }
    rows.push(line("", theme.text));

    for (const path of paths) {
      const locations = section.locations.filter((location) => location.path === path);
      const fileId = visibleIdByPath.get(path);
      const fileReviewed = state.reviewedFiles.has(path);
      const allSeen = locations.every((location) => state.viewed.has(locationKey(location.path, location.hunk)));
      const isSelected = path === selectedPath;
      const hunkLabel = locations.map((location) => `#${location.hunk}`).join(" ");
      const hidden = !fileId && state.hideReviewed && fileReviewed;
      const box = fileReviewed ? FILE_BOX_ON : FILE_BOX_OFF;
      const mark = fileReviewed ? "✓" : allSeen ? "·" : "○";
      const label = `  ${mark} ${shortPath(path, detailWidth - hunkLabel.length - box.length - 4)} ${hunkLabel}${hidden ? " (hidden)" : ""}`;
      rows.push(
        split(
          label,
          {
            text: box,
            fg: fileReviewed ? theme.badgeAdded : theme.accent,
            onClick: () => followToggle(toggleFileReviewed(path, sectionIndex), "All files reviewed"),
          },
          fileReviewed ? theme.muted : fileId ? (isSelected ? theme.accent : theme.text) : theme.muted,
          isSelected ? theme.selectedHunk : theme.panel,
          {
            id: `file-${sectionIndex}-${path}`,
            onLeft: fileId ? () => actions.selectHunk(fileId, locations[0]!.hunk - 1) : undefined,
          },
        ),
      );
      for (const location of locations) {
        if (!location.note) continue;
        wrapText(`#${location.hunk} ${location.note}`, detailWidth - 4).forEach((text, index) => {
          rows.push(line(`    ${index === 0 ? "" : "  "}${text}`, theme.muted));
        });
      }
    }
    rows.push(line("", theme.text));
  });

  const hints = [
    stepKey ? `${stepKey} next hunk` : "",
    sectionKey ? `${sectionKey} next section` : "",
    doneKey ? `${doneKey} section done` : "",
    fileDoneKey ? `${fileDoneKey} file done` : "",
    generateKey ? `${generateKey} regenerate` : "",
  ].filter(Boolean);
  if (hints.length > 0) {
    rows.push(line("", theme.text));
    for (const text of wrapText(hints.join(" · "), inner)) rows.push(line(text, theme.muted));
  }
  return rows;
}

/** The docked pane: title, summary, and the sectioned reading plan with reviewed toggles. */
export function GuidePane(props: ExtensionPaneProps): ReactNode {
  const state = useGuideState();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const rows = useMemo(
    () => buildRows(props, state),
    [props.files, props.theme, props.keybindings, props.actions, props.width, state],
  );
  const current = currentSectionIndex(state);
  const selectedPath = state.selected ? fileById(state, state.selected.fileId)?.path ?? null : null;

  useEffect(() => {
    if (current >= 0) scrollRef.current?.scrollChildIntoView(`section-${current}`);
    if (current >= 0 && selectedPath) scrollRef.current?.scrollChildIntoView(`file-${current}-${selectedPath}`);
  }, [current, selectedPath]);

  return (
    <scrollbox
      ref={scrollRef}
      width="100%"
      height="100%"
      focused={false}
      scrollY={true}
      rootOptions={{ backgroundColor: props.theme.panel }}
      wrapperOptions={{ backgroundColor: props.theme.panel }}
      viewportOptions={{ backgroundColor: props.theme.panel }}
      contentOptions={{ backgroundColor: props.theme.panel }}
      verticalScrollbarOptions={{ visible: false }}
      horizontalScrollbarOptions={{ visible: false }}
    >
      <box style={{ width: "100%", flexDirection: "column", backgroundColor: props.theme.panel }}>
        {rows.map((row, index) => {
          let remaining = rowWidth(props.width);
          return (
            <box key={index} id={row.id} style={{ width: rowWidth(props.width), height: 1, flexDirection: "row", backgroundColor: props.theme.panel }}>
              {row.segments.map((segment, segmentIndex) => {
                const text = clipText(segment.text, remaining) || (segmentIndex === 0 ? " " : "");
                remaining -= text.length;
                if (!text) return null;
                // One box per segment: boxes are what Hunk's own rows use as click targets. The
                // first segment absorbs any width mismatch so trailing buttons keep their full hit area.
                const style =
                  segmentIndex === 0
                    ? { flexGrow: 1, flexShrink: 1, height: 1, overflow: "hidden" as const, backgroundColor: segment.bg ?? props.theme.panel }
                    : { width: text.length, flexShrink: 0, height: 1, backgroundColor: segment.bg ?? props.theme.panel };
                return (
                  <box key={segmentIndex} style={style} onMouseUp={segment.onClick}>
                    <text content={text} style={{ fg: segment.fg, bg: segment.bg ?? props.theme.panel }} />
                  </box>
                );
              })}
            </box>
          );
        })}
      </box>
    </scrollbox>
  );
}
