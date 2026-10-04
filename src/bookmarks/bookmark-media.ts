import type { BookmarkEntry, BookmarkMediaType } from "../core/model";

export const BOOKMARK_MEDIA: Array<{ type: BookmarkMediaType; label: string; icon: string }> = [
  { type: "reference", label: "References", icon: "library-big" },
  { type: "video", label: "Video", icon: "clapperboard" },
  { type: "audio", label: "Audio", icon: "headphones" },
  { type: "image", label: "Images", icon: "image" },
  { type: "pdf", label: "PDF", icon: "file-text" },
  { type: "document", label: "Documents", icon: "files" },
  { type: "mail", label: "Mail", icon: "mail" },
  { type: "blog", label: "Blogs", icon: "notebook-pen" },
  { type: "forum", label: "Forums", icon: "messages-square" },
  { type: "website", label: "Websites", icon: "globe" },
];

export function classifyBookmark(bookmark: Pick<BookmarkEntry, "url" | "mediaType">): BookmarkMediaType {
  if (bookmark.mediaType && BOOKMARK_MEDIA.some((entry) => entry.type === bookmark.mediaType)) return bookmark.mediaType;
  return inferBookmarkMedia(bookmark.url);
}

export function inferBookmarkMedia(rawUrl: string): BookmarkMediaType {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return "website"; }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const domain = (name: string) => host === name || host.endsWith("." + name);
  // Inspect query values too: download links often carry their filename there.
  const filenames = [path, ...Array.from(url.searchParams.values())];
  const extension = (pattern: RegExp) => filenames.some((value) => pattern.test(value));
  if (domain("youtube.com") || domain("youtu.be") || domain("vimeo.com") || domain("nicovideo.jp") ||
    extension(/\.(mp4|webm|mov|mkv|avi|m4v)(?:$|[?#])/i)) return "video";
  if (url.protocol === "mailto:" || domain("gmail.com") || /^mail\.google\.[a-z.]+$/.test(host) ||
    domain("outlook.com") || host === "outlook.live.com" || host === "outlook.office.com" || host === "outlook.office365.com" ||
    /^mail\.yahoo\.[a-z.]+$/.test(host) || domain("proton.me") && host.startsWith("mail.")) return "mail";
  if (extension(/\.(mp3|wav|ogg|flac|m4a|aac)(?:$|[?#])/i) || domain("spotify.com") || domain("soundcloud.com")) return "audio";
  if (extension(/\.(png|jpe?g|gif|webp|svg|avif|bmp)(?:$|[?#])/i)) return "image";
  if (extension(/\.pdf(?:$|[?#])/i)) return "pdf";
  if (extension(/\.(docx?|xlsx?|pptx?|odt|ods|odp|epub|txt|md|csv)(?:$|[?#])/i)) return "document";
  if (domain("reddit.com") || domain("5ch.net") || domain("2ch.sc") || domain("stackoverflow.com") ||
    domain("stackexchange.com") || host === "news.ycombinator.com" || /^(forum|bbs)\./.test(host) || /\/(forums?|boards?|threads?)\//.test(path)) return "forum";
  if (domain("medium.com") || domain("note.com") || domain("hatena.ne.jp") || domain("hatenablog.com") ||
    domain("hatenablog.jp") || domain("blogspot.com") || domain("wordpress.com") || domain("substack.com") ||
    domain("qiita.com") || domain("zenn.dev") || domain("ameblo.jp") || domain("livedoor.blog") || domain("blog.fc2.com") ||
    host.startsWith("blog.") || /\/blog(?:\/|$)/.test(path)) return "blog";
  if (/(^|\.)google\.[a-z.]+$/.test(host) || domain("googleusercontent.com") ||
    domain("wikipedia.org") || domain("manaba.jp") || host.includes("manaba")) return "reference";
  return "website";
}
