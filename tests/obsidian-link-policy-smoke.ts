import assert from "node:assert/strict";
import { parseObsidianWebLink } from "../src/integrations/obsidian-link-policy";

for (const [input, expected] of [
  ["https://manaba.example.ac.jp/course/123", "https://manaba.example.ac.jp/course/123"],
  ["https://docs.google.com/presentation/d/abc/edit?x=1&y=2", "https://docs.google.com/presentation/d/abc/edit?x=1&y=2"],
  [" https://example.com/path?q=1 ", "https://example.com/path?q=1"],
  ["http://localhost:8080/test", "http://localhost:8080/test"],
  ["mailto:example@example.com", null],
  ["obsidian://open?vault=test", null],
  ["javascript:alert(1)", null],
  ["data:text/html,test", null],
  ["file:///tmp/page.html", null],
  ["[[An Obsidian link]]", null],
  ["https://", null],
  ["", null],
] as const) {
  assert.equal(parseObsidianWebLink(input), expected, input);
}

console.log("Obsidian integration URL policy passed");
