import { describe, expect, test } from "bun:test";
import { clipText, justify, wrapText } from "../src/wrap.ts";

describe("wrapText", () => {
  test("wraps on words and keeps paragraphs", () => {
    expect(wrapText("one two three four", 9)).toEqual(["one two", "three", "four"]);
    expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"]);
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
});

describe("clipText / justify", () => {
  test("clip marks the cut", () => {
    expect(clipText("hello world", 5)).toBe("hell…");
    expect(clipText("hi", 5)).toBe("hi");
  });
  test("justify right-aligns the trailing label", () => {
    expect(justify("left", "3/4", 12)).toBe("left     3/4");
    expect(justify("a very long left side", "3/4", 12)).toBe("a very … 3/4");
  });
});
