import assert from "node:assert/strict";
import { webTextFragmentUrl, formatBrowserTabsMarkdown, selectionNoteContent, videoTimestampLink } from "../src/integrations/obsidian-web-transfer";
assert.equal(webTextFragmentUrl("https://example.org/hello#section", "hello world"), "https://example.org/hello#section:~:text=hello%20world");
assert.equal(webTextFragmentUrl("https://example.org/", "日本語 検証"), "https://example.org/#:~:text=%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E6%A4%9C%E8%A8%BC");
assert.equal(webTextFragmentUrl("javascript:alert(1)", "test"), null);
assert.equal(webTextFragmentUrl("https://example.org", "  "), null);
assert.equal(webTextFragmentUrl("https://example.org/path", "one,two"), "https://example.org/path#:~:text=one%2Ctwo");
assert.deepEqual(formatBrowserTabsMarkdown([{ title: "Title [1]", url: "https://example.org" }, { title: "Home", url: "browser://home" }]), "- [Title \\[1\\]](<https://example.org>)");
const note = selectionNoteContent({ text: "one\ntwo", title: "Clip: <live>", url: "https://example.org" });
assert.match(note.markdown, /source: "https:\/\/example.org"/);
assert.match(note.markdown, /> one\n> two/);
assert.equal(note.baseName, "Clip- -live-");
assert.throws(() => selectionNoteContent({ text: "", title: "x", url: "https://example.org" }));
assert.deepEqual(videoTimestampLink("https://www.bilibili.com/video/BV123?foo=1", 123.8), {
  url: "https://www.bilibili.com/video/BV123?foo=1&t=123", label: "2:03",
});
assert.deepEqual(videoTimestampLink("https://example.org/media.mp4", 3661), {
  url: "https://example.org/media.mp4#t=3661", label: "1:01:01",
});
assert.equal(videoTimestampLink("file:///tmp/test", 1), null);
console.log("Web to Vault selection/fragment/tab Markdown transfer passed");
