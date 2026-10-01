export type WebviewElement = HTMLElement & {
  src: string;
  partition: string;
  loadURL?: (url: string) => Promise<void>;
  getURL?: () => string;
  getTitle?: () => string;
  reload: () => void;
  reloadIgnoringCache?: () => void;
  stop: () => void;
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  goBack?: () => void;
  goForward?: () => void;
  getWebContentsId?: () => number;
  getZoomFactor?: () => number;
  setZoomFactor?: (factor: number) => void;
  openDevTools?: () => void;
  executeJavaScript?: <T = unknown>(code: string, userGesture?: boolean) => Promise<T>;
  undo?: () => void;
  redo?: () => void;
  cut?: () => void;
  copy?: () => void;
  paste?: () => void;
  delete?: () => void;
  selectAll?: () => void;
  copyImageAt?: (x: number, y: number) => void;
  downloadURL?: (url: string) => void;
};

export interface WebviewNavigateEvent extends Event {
  url?: string;
  isMainFrame?: boolean;
}

export interface WebviewTitleEvent extends Event {
  title?: string;
}

export interface WebviewFaviconEvent extends Event {
  favicons?: string[];
}

export interface WebviewContextMenuParams {
  x: number;
  y: number;
  linkURL?: string;
  linkText?: string;
  pageURL?: string;
  srcURL?: string;
  mediaType?: "none" | "image" | "audio" | "video" | "canvas" | "file" | "plugin";
  isEditable?: boolean;
  selectionText?: string;
  editFlags?: {
    canUndo?: boolean;
    canRedo?: boolean;
    canCut?: boolean;
    canCopy?: boolean;
    canPaste?: boolean;
    canDelete?: boolean;
    canSelectAll?: boolean;
  };
}

export interface WebviewContextMenuEvent extends Event {
  params?: WebviewContextMenuParams;
}
