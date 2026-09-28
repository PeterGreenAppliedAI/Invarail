/**
 * Extract [IMAGE:path] and [FILE:path] tokens from text, read files, return attachments + cleaned text.
 * Extracted from orchestrator for testability and reuse.
 */
import { readFileSync, realpathSync, readdirSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, basename } from 'node:path';

const IMAGE_TOKEN_RE = /\[IMAGE:([^\]]+)\]/g;
const FILE_TOKEN_RE = /\[FILE:([^\]]+)\]/g;

const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', txt: 'text/plain', html: 'text/html',
};

export interface MediaExtractOptions {
  /** The active agent: only its workspace artifacts (plus data/media, data/uploads) are attachable. */
  agentId?: string;
  /** Directories an attachment may be read from. Default: `defaultArtifactRoots()` —
   *  the directories tools WRITE artifacts to, and nothing else. The token is
   *  model-written text: a prompt-injected answer can name ANY path, so containment is
   *  checked on the canonical (symlink-resolved) path. The whole `data/` tree is NOT a
   *  root: it also holds `data/secrets.json`, the ledgers, transcripts and memory
   *  (re-review F04, 2026-09-27). */
  allowedRoots?: string[];
}

/** Per-workspace subdirectories that tools produce deliverable artifacts in. Identity
 *  files at the workspace root (SOUL/USER/MEMORY/TASKS) and `memory/` are never here. */
export const WORKSPACE_ARTIFACT_DIRS = ['images', 'diagrams', 'research', 'documents', 'builds'] as const;

/** `data/media`, `data/uploads`, and `<workspace>/<artifact dir>` for every workspace. */
export function defaultArtifactRoots(cwd = process.cwd(), agentId?: string): string[] {
  const roots = [resolve(cwd, 'data', 'media'), resolve(cwd, 'data', 'uploads')];
  const ws = resolve(cwd, 'data', 'workspaces');
  if (!existsSync(ws)) return roots;
  // The ACTIVE agent's artifact directories only (third review F04): a model-authored token
  // must not attach another agent's research or builds. Without an agent (legacy callers)
  // every workspace's artifact dirs remain eligible, as before.
  const agents = agentId ? [agentId] : readdirSync(ws);
  for (const agent of agents) {
    for (const sub of WORKSPACE_ARTIFACT_DIRS) roots.push(resolve(ws, agent, sub));
  }
  return roots;
}

type PathCheck = { ok: true; path: string } | { ok: false; reason: 'missing' | 'outside' };

/** Canonicalize and confine. `missing` keeps the token as text (old behavior for a
 *  path that does not exist); `outside` strips the token and attaches nothing. */
function checkDeliverable(raw: string, roots: string[]): PathCheck {
  const p = raw.trim();
  if (!p) return { ok: false, reason: 'missing' };
  let real: string;
  try { real = realpathSync(resolve(p)); } catch { return { ok: false, reason: 'missing' }; }
  for (const root of roots) {
    let r: string;
    try { r = realpathSync(resolve(root)); } catch { continue; }
    const rel = relative(r, real);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return { ok: true, path: real };
  }
  console.warn(`[Media] Blocked attachment outside allowed roots: ${p}`);
  return { ok: false, reason: 'outside' };
}

export function extractMediaAttachments(text: string, opts?: MediaExtractOptions): {
  cleanText: string;
  attachments: Array<{ data: Buffer; mimeType: string; filename: string }>;
} {
  const attachments: Array<{ data: Buffer; mimeType: string; filename: string }> = [];
  const roots = opts?.allowedRoots ?? defaultArtifactRoots(process.cwd(), opts?.agentId);

  let cleanText = text.replace(IMAGE_TOKEN_RE, (match, filePath: string) => {
    const check = checkDeliverable(filePath, roots);
    if (!check.ok) return check.reason === 'missing' ? match : '';
    try {
      const data = readFileSync(check.path);
      const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png';
      attachments.push({ data, mimeType: MIME_MAP[ext] ?? 'image/png', filename: basename(filePath.trim()) || 'image.png' });
      return '';
    } catch { return match; }
  });

  cleanText = cleanText.replace(FILE_TOKEN_RE, (match, filePath: string) => {
    const check = checkDeliverable(filePath, roots);
    if (!check.ok) return check.reason === 'missing' ? match : '';
    try {
      const data = readFileSync(check.path);
      const ext = filePath.split('.').pop()?.toLowerCase() ?? 'bin';
      attachments.push({ data, mimeType: MIME_MAP[ext] ?? 'application/octet-stream', filename: basename(filePath.trim()) || 'file' });
      return '';
    } catch { return match; }
  });

  // Catch document file paths the model may have reformatted (markdown links, plain mentions)
  const docPathRe = /(?:\[([^\]]*)\]\([^)]*\)|(?:^|\s))((?:\/[^\s]*|data)\/media\/documents\/[^\s)]+\.(?:pdf|docx|xlsx|pptx|csv))/gim;
  const seenPaths = new Set(attachments.map(a => a.filename));
  for (const m of cleanText.matchAll(docPathRe)) {
    const filePath = (m[2] || '').trim();
    const filename = basename(filePath) || 'file';
    if (seenPaths.has(filename)) continue;
    const check = checkDeliverable(filePath, roots);
    if (!check.ok) continue;
    try {
      const data = readFileSync(check.path);
      const ext = filePath.split('.').pop()?.toLowerCase() ?? 'bin';
      attachments.push({ data, mimeType: MIME_MAP[ext] ?? 'application/octet-stream', filename });
      seenPaths.add(filename);
      cleanText = cleanText.replace(m[0], '').trim();
    } catch { /* file doesn't exist */ }
  }

  return { cleanText: cleanText.trim(), attachments };
}

/**
 * Does this caption ask to TRANSFORM/GENERATE from an attached image (img2img)
 * rather than ask ABOUT it? Gates the image-attachment routing override:
 * plain captions keep the chat+vision flow; transform intent routes to the
 * image specialist with the saved file as reference_image_path.
 * Precision over recall — "what can I make with this?" (fridge photo) must
 * NOT match, so the action verb requires an explicit picture/image object,
 * with style keywords (anime, cartoon...) as the second, independent signal.
 */
const IMAGE_TRANSFORM_RE = new RegExp(
  [
    /\b(make|turn|convert|transform|animate|redraw|restyle|stylize|remix|reimagine|edit)\b[\s\S]{0,50}\b(picture|photo|image)\b/.source,
    /\b(generate|create|draw)\b[\s\S]{0,40}\b(picture|photo|image|illustration|version)\b/.source,
    /\b(anime|cartoon|ghibli|watercolor|pixel\s?art|comic|caricature)\b/.source,
  ].join('|'),
  'i',
);

export function isImageTransformRequest(caption: string): boolean {
  return IMAGE_TRANSFORM_RE.test(caption);
}
