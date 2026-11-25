#!/usr/bin/env node
/**
 * PreToolUse hook for `read_file` / `view_file`.
 *
 * Balanced Media Guard policy (Node.js >= 18, Windows / macOS / Linux):
 * - Non-media files (code, text, docs, PDFs, etc.): always allow immediately.
 * - Video / Audio in main session: deny direct read so raw binaries are never
 *   attached to main conversation history (guide agent to subagent isolation or
 *   ffmpeg / gemini-api preprocessing).
 * - Video / Audio in an isolated subagent: allow if file <= 15 MB and session
 *   cumulative media <= 20 MB; otherwise deny and require compression/clipping/ffmpeg.
 * - Images: always allow while single image <= 15 MB and cumulative session media <= 25 MB;
 *   above that, return "ask" to warn before bloating the session.
 * - Fail-open: any parse/IO/unexpected error returns "allow" so normal workflows never break.
 */

import fs from 'node:fs';
import path from 'node:path';

const MB = 1024 * 1024;
const SUBAGENT_MAX_MEDIA_BYTES = Number(process.env.MEDIA_GUARD_SUBAGENT_MAX_MB || 15) * MB;
const SUBAGENT_BUDGET_BYTES = Number(process.env.MEDIA_GUARD_SUBAGENT_BUDGET_MB || 20) * MB;
const IMAGE_SINGLE_ASK_BYTES = Number(process.env.MEDIA_GUARD_SINGLE_IMAGE_ASK_MB || 15) * MB;
const SESSION_MEDIA_BUDGET_BYTES = Number(process.env.MEDIA_GUARD_MEDIA_BUDGET_MB || 25) * MB;

const TARGET_TOOLS = new Set(['read_file', 'view_file']);

const VIDEO_EXTS = new Set([
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv', '.m4v', '.mpeg', '.mpg', '.ts', '.3gp',
]);

const AUDIO_EXTS = new Set([
  '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma',
]);

const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.heic',
]);

function respond(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(0);
}

function allow() {
  respond({ decision: 'allow' });
}

function deny(reason) {
  respond({ decision: 'deny', reason });
}

function ask(reason) {
  respond({ decision: 'ask', reason });
}

function fmtMB(bytes) {
  return (bytes / MB).toFixed(2);
}

function stripQuotes(p) {
  const trimmed = p.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function readStdin() {
  process.stdin.setEncoding('utf8');
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

function readFirstLine(filePath, maxBytes = 8192) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    if (bytesRead <= 0) return '';
    const text = buf.toString('utf8', 0, bytesRead);
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(0, nl) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function detectSubagent(transcriptPath) {
  if (!transcriptPath) return false;
  const firstLine = readFirstLine(transcriptPath);
  if (!firstLine) return false;
  try {
    const step0 = JSON.parse(firstLine);
    return (
      Number(step0?.step_index) === 0 &&
      String(step0?.source || '').includes('SYSTEM') &&
      String(step0?.type || '').includes('SYSTEM_MESSAGE')
    );
  } catch {
    return false;
  }
}

function getExistingMediaBytes(transcriptPath) {
  if (!transcriptPath) return 0;
  try {
    const mediaDir = path.join(path.dirname(transcriptPath), 'media');
    if (!fs.existsSync(mediaDir)) return 0;
    let total = 0;
    for (const entry of fs.readdirSync(mediaDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        total += fs.statSync(path.join(mediaDir, entry.name)).size;
      } catch {}
    }
    return total;
  } catch {
    return 0;
  }
}

async function main() {
  if (process.env.MEDIA_GUARD_DISABLE === '1') {
    return allow();
  }

  let rawStdin = '';
  try {
    rawStdin = await readStdin();
  } catch {
    return allow();
  }

  if (!rawStdin || !rawStdin.trim()) return allow();

  let payload;
  try {
    payload = JSON.parse(rawStdin);
  } catch {
    return allow();
  }

  const toolName = payload?.toolCall?.name;
  if (!TARGET_TOOLS.has(toolName)) return allow();

  const args = payload?.toolCall?.args || {};
  const rawPath = args.Path ?? args.AbsolutePath ?? args.path;
  if (typeof rawPath !== 'string' || !rawPath.trim()) return allow();

  const cleanedPath = stripQuotes(rawPath);
  const cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const targetPath = path.isAbsolute(cleanedPath) ? cleanedPath : path.resolve(cwd, cleanedPath);
  const ext = path.extname(targetPath).toLowerCase();

  const isVideo = VIDEO_EXTS.has(ext);
  const isAudio = AUDIO_EXTS.has(ext);
  const isImage = IMAGE_EXTS.has(ext);

  if (!isVideo && !isAudio && !isImage) {
    return allow();
  }

  let stat;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    // Missing/unreadable file: let the read tool return its standard error.
    return allow();
  }

  if (!stat.isFile()) return allow();

  const fileSize = stat.size;
  const transcriptPath = typeof payload?.transcriptPath === 'string' ? payload.transcriptPath : '';
  const existingMediaBytes = getExistingMediaBytes(transcriptPath);
  const projectedBytes = existingMediaBytes + fileSize;
  const fileName = path.basename(targetPath);

  if (isVideo || isAudio) {
    const isSubagent = detectSubagent(transcriptPath);
    const kind = isVideo ? 'video' : 'audio';

    if (!isSubagent) {
      if (fileSize <= SUBAGENT_MAX_MEDIA_BYTES) {
        return deny(
          `[media-guard] Blocked direct ${toolName} on ${kind} in the main session ("${fileName}", ${fmtMB(fileSize)} MB) to prevent raw media re-upload bloat and session freezes. ` +
          `Use either: (1) invoke_subagent (TypeName: "self") to read this ${fmtMB(fileSize)} MB file in an isolated one-shot subagent and return a text summary, OR ` +
          `(2) the media-safe-read skill (prep_media.mjs with ffmpeg keyframes/audio/clip, or gemini-api files upload + analyze).`
        );
      }
      return deny(
        `[media-guard] Blocked direct ${toolName} on oversized ${kind} ("${fileName}", ${fmtMB(fileSize)} MB > ${fmtMB(SUBAGENT_MAX_MEDIA_BYTES)} MB limit). ` +
        `Use the media-safe-read skill first: run prep_media.mjs (--mode keyframes / audio / clip / compress) or gemini-api files upload + analyze.`
      );
    }

    // Inside isolated subagent: enforce per-file and cumulative media limits.
    if (fileSize > SUBAGENT_MAX_MEDIA_BYTES) {
      return deny(
        `[media-guard] Blocked direct ${toolName} inside subagent: "${fileName}" is ${fmtMB(fileSize)} MB (limit ${fmtMB(SUBAGENT_MAX_MEDIA_BYTES)} MB). ` +
        `Preprocess with media-safe-read (prep_media.mjs --mode clip / compress / keyframes / audio, or gemini-api files upload + analyze) first.`
      );
    }

    if (projectedBytes > SUBAGENT_BUDGET_BYTES) {
      return deny(
        `[media-guard] Blocked direct ${toolName} inside subagent: cumulative session media would reach ${fmtMB(projectedBytes)} MB (limit ${fmtMB(SUBAGENT_BUDGET_BYTES)} MB). ` +
        `Extract keyframes/audio/clip via prep_media.mjs or start a fresh subagent per file.`
      );
    }

    return allow();
  }

  // Image cumulative safety check (normal screenshots pass silently).
  if (fileSize > IMAGE_SINGLE_ASK_BYTES || projectedBytes > SESSION_MEDIA_BUDGET_BYTES) {
    return ask(
      `[media-guard] Reading image "${fileName}" (${fmtMB(fileSize)} MB) would bring this session's attached media to ${fmtMB(projectedBytes)} MB ` +
      `(threshold ${fmtMB(SESSION_MEDIA_BUDGET_BYTES)} MB). Confirm to proceed, or downsample/inspect via a subagent.`
    );
  }

  return allow();
}

main().catch(() => {
  // Fail-open guarantee: never break file reading if an unexpected error occurs.
  allow();
});
