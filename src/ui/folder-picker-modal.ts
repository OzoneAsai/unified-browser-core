import { FuzzySuggestModal, type App } from "obsidian";
import type { BookmarkStore } from "../bookmarks/bookmark-store";
import type { BookmarkFolderId } from "../core/model";

type FolderChoice = {
  id: BookmarkFolderId | null;
  label: string;
};

export function pickBookmarkFolder(
  app: App,
  store: BookmarkStore,
  options: { excludeFolderId?: BookmarkFolderId } = {},
): Promise<BookmarkFolderId | null | undefined> {
  return new Promise((resolve) => {
    new BookmarkFolderPickerModal(app, store, options.excludeFolderId, resolve).open();
  });
}

class BookmarkFolderPickerModal extends FuzzySuggestModal<FolderChoice> {
  private chosen = false;

  constructor(
    app: App,
    private readonly store: BookmarkStore,
    private readonly excludeFolderId: BookmarkFolderId | undefined,
    private readonly resolveChoice: (value: BookmarkFolderId | null | undefined) => void,
  ) {
    super(app);
    this.setPlaceholder("Choose bookmark folder");
  }

  getItems(): FolderChoice[] {
    const choices: FolderChoice[] = [{ id: null, label: "Bookmarks root" }];
    for (const folder of this.store.folders()) {
      if (this.excludeFolderId && !this.store.canMoveFolder(this.excludeFolderId, folder.id)) continue;
      choices.push({ id: folder.id, label: this.store.folderPath(folder.id) });
    }
    return choices;
  }

  getItemText(item: FolderChoice): string {
    return item.label;
  }

  onChooseItem(item: FolderChoice): void {
    this.chosen = true;
    this.resolveChoice(item.id);
  }

  onClose(): void {
    super.onClose();
    if (!this.chosen) this.resolveChoice(undefined);
  }
}
