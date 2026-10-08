/** Word-wrap text into rows no wider than `width` cells, preserving paragraph breaks. */
export function wrapText(text: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      rows.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if (line.length === 0) {
        line = word;
      } else if (line.length + 1 + word.length <= limit) {
        line += ` ${word}`;
      } else {
        rows.push(line);
        line = word;
      }
      while (line.length > limit) {
        rows.push(line.slice(0, limit));
        line = line.slice(limit);
      }
    }
    if (line) rows.push(line);
  }
  return rows;
}

/** Clip one row to `width` cells, marking the cut with an ellipsis. */
export function clipText(text: string, width: number): string {
  const limit = Math.max(0, Math.floor(width));
  if (text.length <= limit) return text;
  if (limit <= 1) return text.slice(0, limit);
  return `${text.slice(0, limit - 1)}…`;
}

/** Pad or clip `left` so `right` ends flush with `width`. */
export function justify(left: string, right: string, width: number): string {
  const limit = Math.max(0, Math.floor(width));
  if (right.length >= limit) return clipText(right, limit);
  const room = limit - right.length - 1;
  const head = clipText(left, room);
  return `${head}${" ".repeat(Math.max(0, room - head.length))} ${right}`;
}
