#!/usr/bin/env node
/**
 * Local media preprocessing helper for media-safe-read (Node.js >= 18).
 * Uses ffmpeg / ffprobe to inspect media, extract keyframe contact sheets,
 * extract low-bitrate audio, slice high-FPS time clips, or compress videos.
 *
 * Usage:
 *   node prep_media.mjs --input <path> --mode <info|keyframes|audio|clip|compress> [options]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function runBin(bin, binArgs) {
  try {
    return execFileSync(bin, binArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(
        `Required binary "${bin}" was not found in PATH. Install ffmpeg (Windows: winget install Gyan.FFmpeg; macOS: brew install ffmpeg; Linux: apt install ffmpeg).`
      );
    }
    throw err;
  }
}

function probeMedia(inputPath) {
  const out = runBin('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    inputPath,
  ]);
  const info = JSON.parse(out);
  const stat = fs.statSync(inputPath);
  const duration = Number(info?.format?.duration || 0);
  const videoStream = (info?.streams || []).find((s) => s.codec_type === 'video');
  const audioStream = (info?.streams || []).find((s) => s.codec_type === 'audio');
  return {
    path: inputPath,
    sizeBytes: stat.size,
    sizeMB: Number((stat.size / (1024 * 1024)).toFixed(2)),
    durationSec: Number(duration.toFixed(2)),
    hasVideo: Boolean(videoStream),
    video: videoStream
      ? { codec: videoStream.codec_name, width: videoStream.width, height: videoStream.height }
      : null,
    hasAudio: Boolean(audioStream),
    audio: audioStream
      ? { codec: audioStream.codec_name, sampleRate: audioStream.sample_rate, channels: audioStream.channels }
      : null,
  };
}

function makeKeyframes(inputPath, outDir, cols, rows, intervalSec) {
  const info = probeMedia(inputPath);
  if (!info.hasVideo) {
    throw new Error('Input file has no video stream.');
  }
  const totalSlots = Math.max(1, cols * rows);
  const duration = Math.max(1, info.durationSec || 10);
  const step = intervalSec > 0 ? intervalSec : Math.max(0.5, duration / totalSlots);
  const fpsFilter = `fps=1/${step.toFixed(3)}`;
  const vf = `${fpsFilter},scale=480:-1:flags=lanczos,drawtext=text='%{pts\\:hms}':x=8:y=8:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6,tile=${cols}x${rows}`;
  const fallbackVf = `${fpsFilter},scale=480:-1:flags=lanczos,tile=${cols}x${rows}`;

  const base = path.basename(inputPath, path.extname(inputPath));
  const outPath = path.join(outDir, `${base}_keyframes.jpg`);

  try {
    runBin('ffmpeg', ['-y', '-i', inputPath, '-frames:v', '1', '-vf', vf, '-q:v', '4', outPath]);
  } catch (err) {
    if (String(err.message || '').includes('not found in PATH')) throw err;
    runBin('ffmpeg', ['-y', '-i', inputPath, '-frames:v', '1', '-vf', fallbackVf, '-q:v', '4', outPath]);
  }

  const outStat = fs.statSync(outPath);
  return {
    mode: 'keyframes',
    info,
    outputPath: outPath,
    outputSizeMB: Number((outStat.size / (1024 * 1024)).toFixed(2)),
    grid: `${cols}x${rows}`,
    approxIntervalSec: Number(step.toFixed(2)),
  };
}

function extractAudio(inputPath, outDir) {
  const info = probeMedia(inputPath);
  if (!info.hasAudio) {
    throw new Error('Input file has no audio stream.');
  }
  const base = path.basename(inputPath, path.extname(inputPath));
  const outPath = path.join(outDir, `${base}_audio.mp3`);
  runBin('ffmpeg', [
    '-y', '-i', inputPath,
    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k',
    outPath,
  ]);
  const outStat = fs.statSync(outPath);
  return {
    mode: 'audio',
    info,
    outputPath: outPath,
    outputSizeMB: Number((outStat.size / (1024 * 1024)).toFixed(2)),
  };
}

function extractClip(inputPath, outDir, start, duration) {
  const info = probeMedia(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  const ext = info.hasVideo ? '.mp4' : path.extname(inputPath);
  const safeStart = String(start || '0').replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `${base}_clip_${safeStart}_${duration}s${ext}`);

  const ffArgs = ['-y', '-ss', String(start || '0'), '-i', inputPath, '-t', String(duration)];
  if (info.hasVideo) {
    ffArgs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-movflags', '+faststart');
  }
  if (info.hasAudio) {
    ffArgs.push('-c:a', 'aac', '-b:a', '96k');
  } else if (info.hasVideo) {
    ffArgs.push('-an');
  }
  ffArgs.push(outPath);

  runBin('ffmpeg', ffArgs);
  const outStat = fs.statSync(outPath);
  return {
    mode: 'clip',
    info,
    start: String(start || '0'),
    durationSec: Number(duration),
    outputPath: outPath,
    outputSizeMB: Number((outStat.size / (1024 * 1024)).toFixed(2)),
  };
}

function compressVideo(inputPath, outDir, targetMaxMB) {
  const info = probeMedia(inputPath);
  if (!info.hasVideo) {
    throw new Error('Input file has no video stream.');
  }
  const duration = Math.max(1, info.durationSec || 10);
  const targetTotalBits = targetMaxMB * 1024 * 1024 * 8 * 0.88;
  const audioKbps = info.hasAudio ? 48 : 0;
  const totalKbps = Math.floor(targetTotalBits / duration / 1000);
  const videoKbps = Math.max(80, Math.min(800, totalKbps - audioKbps));

  const base = path.basename(inputPath, path.extname(inputPath));
  const outPath = path.join(outDir, `${base}_compact.mp4`);

  const ffArgs = [
    '-y', '-i', inputPath,
    '-vf', "scale='min(854,iw)':-2",
    '-r', '15',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-b:v', `${videoKbps}k`,
    '-maxrate', `${Math.round(videoKbps * 1.3)}k`,
    '-bufsize', `${videoKbps * 2}k`,
    '-movflags', '+faststart',
  ];
  if (info.hasAudio) {
    ffArgs.push('-c:a', 'aac', '-ac', '1', '-b:a', `${audioKbps}k`);
  } else {
    ffArgs.push('-an');
  }
  ffArgs.push(outPath);

  runBin('ffmpeg', ffArgs);
  const outStat = fs.statSync(outPath);
  return {
    mode: 'compress',
    info,
    outputPath: outPath,
    outputSizeMB: Number((outStat.size / (1024 * 1024)).toFixed(2)),
    videoKbps,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = args.input;
  const mode = args.mode || 'info';

  if (!inputPath || !fs.existsSync(inputPath)) {
    console.error(JSON.stringify({ error: 'Missing or non-existent --input file.' }));
    process.exit(2);
  }

  const outDir = args['out-dir'] || path.dirname(inputPath);
  fs.mkdirSync(outDir, { recursive: true });

  try {
    let result;
    if (mode === 'info') {
      result = { mode: 'info', info: probeMedia(inputPath) };
    } else if (mode === 'keyframes') {
      const cols = Number(args.cols || 4);
      const rows = Number(args.rows || 3);
      const interval = Number(args.interval || 0);
      result = makeKeyframes(inputPath, outDir, cols, rows, interval);
    } else if (mode === 'audio') {
      result = extractAudio(inputPath, outDir);
    } else if (mode === 'clip') {
      const start = args.start || '0';
      const duration = Number(args.duration || 15);
      result = extractClip(inputPath, outDir, start, duration);
    } else if (mode === 'compress') {
      const maxMB = Number(args['max-mb'] || 12);
      result = compressVideo(inputPath, outDir, maxMB);
    } else {
      console.error(JSON.stringify({ error: `Unsupported --mode: ${mode}` }));
      process.exit(2);
    }

    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    console.error(JSON.stringify({ error: err.message || String(err) }));
    process.exit(1);
  }
}

main();
