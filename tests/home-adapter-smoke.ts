import assert from "node:assert/strict";
import { TFile } from "obsidian";
import { ObsidianHomeAdapter } from "../src/adapters/obsidian-home";
import { parseHomeFilter } from "../src/home/search-model";

type File = TFile & { path: string; basename: string; extension: string };
const file = (path: string): File => {
  const filename = path.split("/").at(-1)!;
  const extension = filename.split(".").at(-1)!;
  return Object.assign(new TFile(), { path, basename: filename.slice(0, -(extension.length + 1)), extension }) as File;
};

const files = [file("notes/Project.md"), file("images/Project.png"), file("notes/Research.md"), file("notes/Work.md")];
const byPath = new Map(files.map((entry) => [entry.path, entry]));
const bookmarked = [{ type: "group", items: [{ type: "file", path: "notes/Project.md" }] }];
const removed: string[] = [];
const app = {
  vault: {
    getFiles: () => [...byPath.values()],
    getAbstractFileByPath: (path: string) => byPath.get(path) || (path === "notes" || path === "images" ? { path } : null),
    createFolder: async () => undefined,
    create: async (path: string) => {
      const created = file(path);
      byPath.set(path, created);
      return created;
    },
  },
  workspace: {
    getLastOpenFiles: () => ["notes/Research.md", "notes/Project.md"],
    getLeaf: () => ({ openFile: async () => undefined }),
  },
  metadataCache: {
    getFileCache: (entry: File) => entry.path === "notes/Project.md" ? { frontmatter: { aliases: ["The project"] } } : {},
    unresolvedLinks: { "notes/Project.md": { "Uncreated page": 1 } },
    getFirstLinkpathDest: () => null,
  },
  internalPlugins: {
    getPluginById: () => ({
      instance: {
        getBookmarks: () => bookmarked,
        removeItem: (entry: { path: string }) => { removed.push(entry.path); },
      },
    }),
  },
  plugins: {
    getPlugin: () => ({ api: { search: async () => [{ path: "notes/Project.md", basename: "Project", excerpt: "A matching excerpt" }] } }),
  },
  fileManager: { getNewFileParent: () => ({ path: "notes" }) },
};
const adapter = new ObsidianHomeAdapter(app as never);
assert.equal(adapter.searchFiles("Project", 10).length, 2);
assert.deepEqual(adapter.searchFiles("Project", 10, parseHomeFilter("md")).map((x) => x.path), ["notes/Project.md"]);
assert.deepEqual(adapter.searchFiles("Project", 10, parseHomeFilter("image")).map((x) => x.path), ["images/Project.png"]);
assert.deepEqual(adapter.searchFiles("Research", 10, undefined, true).map((x) => x.path), ["notes/Research.md"]);
assert.equal(adapter.searchFiles("The project", 10)[0]?.matchedAlias, "The project");
assert.equal(adapter.searchFiles("Uncreated", 10, undefined, false, true)[0]?.unresolved, true);
assert.deepEqual(adapter.recentFiles(10, ["notes/Research.md"]).map((x) => x.path), ["notes/Project.md"]);
assert.deepEqual(adapter.bookmarkedFiles().map((x) => x.path), ["notes/Project.md"]);
assert.equal(adapter.removeBookmark("notes/Project.md"), true);
assert.deepEqual(removed, ["notes/Project.md"]);
assert.equal(adapter.hasOmnisearch(), true);
assert.equal((await adapter.searchOmnisearch("Project"))[0]?.excerpt, "A matching excerpt");
const created = await adapter.createNote("New note");
assert.equal(created.path, "notes/New note.md");
assert.equal((await adapter.createNote("New note")).path, created.path);
await assert.rejects(() => adapter.createNote("../escape"));
console.log("Home search adapter regression tests passed");
