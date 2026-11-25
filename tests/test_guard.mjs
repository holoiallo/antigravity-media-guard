import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const GUARD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'read_file_guard.mjs');
const PREP_SCRIPT = path.join(REPO_ROOT, 'scripts', 'prep_media.mjs');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-guard-test-'));

function runGuard(stdinObjOrRaw, envOverrides = {}) {
  const input = typeof stdinObjOrRaw === 'string' ? stdinObjOrRaw : JSON.stringify(stdinObjOrRaw);
  const res = spawnSync(process.execPath, [GUARD_SCRIPT], {
    input,
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, ...envOverrides },
  });
  assert.equal(res.status, 0, `Hook exited non-zero: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

function makeFakeSession(name, isSubagent, existingMediaFiles = []) {
  const logsDir = path.join(tmpRoot, name, '.system_generated', 'logs');
  const mediaDir = path.join(logsDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const transcriptPath = path.join(logsDir, 'transcript.jsonl');
  const step0 = isSubagent
    ? { step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: '<SYSTEM_MESSAGE>\n[Message] sender=parent' }
    : { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'hi' };
  fs.writeFileSync(transcriptPath, JSON.stringify(step0) + '\n', 'utf8');

  for (const [fname, sizeBytes] of existingMediaFiles) {
    fs.writeFileSync(path.join(mediaDir, fname), Buffer.alloc(sizeBytes));
  }
  return transcriptPath;
}

function makeDummyFile(name, sizeBytes) {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, Buffer.alloc(sizeBytes));
  return p;
}

try {
  const mainTranscript = makeFakeSession('main-sess', false);
  const subFreshTranscript = makeFakeSession('sub-fresh', true);
  const subHeavyTranscript = makeFakeSession('sub-heavy', true, [['prev.mp4', 15 * 1024 * 1024]]);
  const imgHeavyTranscript = makeFakeSession('img-heavy', false, [['big1.png', 22 * 1024 * 1024]]);

  const dummyTxt = makeDummyFile('notes.txt', 1024);
  const dummyPng = makeDummyFile('screen.png', 512 * 1024);
  const dummyLargePng = makeDummyFile('large.png', 5 * 1024 * 1024);
  const dummySmallMp4 = makeDummyFile('small.mp4', 4 * 1024 * 1024);
  const dummyBigMp4 = makeDummyFile('huge.mp4', 18 * 1024 * 1024);
  const dummySmallWav = makeDummyFile('clip.wav', 2 * 1024 * 1024);

  // 1. Fail-open on malformed / empty / non-read_file / disable flag
  assert.equal(runGuard('').decision, 'allow');
  assert.equal(runGuard('{bad json').decision, 'allow');
  assert.equal(runGuard({ toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } }).decision, 'allow');
  assert.equal(
    runGuard(
      { toolCall: { name: 'read_file', args: { Path: dummySmallMp4 } }, transcriptPath: mainTranscript },
      { MEDIA_GUARD_DISABLE: '1' }
    ).decision,
    'allow'
  );

  // 2. Normal code/text & missing video -> allow
  assert.equal(
    runGuard({ toolCall: { name: 'read_file', args: { Path: dummyTxt } }, transcriptPath: mainTranscript }).decision,
    'allow'
  );
  assert.equal(
    runGuard({ toolCall: { name: 'read_file', args: { Path: path.join(tmpRoot, 'missing.mp4') } }, transcriptPath: mainTranscript }).decision,
    'allow'
  );

  // 3. Main session reading video/audio via read_file OR view_file (AbsolutePath) -> deny
  const rMainVid = runGuard({ toolCall: { name: 'read_file', args: { Path: dummySmallMp4 } }, transcriptPath: mainTranscript });
  assert.equal(rMainVid.decision, 'deny');
  assert.match(rMainVid.reason, /invoke_subagent/);

  const rMainIde = runGuard({ toolCall: { name: 'view_file', args: { AbsolutePath: dummySmallMp4 } }, transcriptPath: mainTranscript });
  assert.equal(rMainIde.decision, 'deny');

  const rMainAud = runGuard({ toolCall: { name: 'read_file', args: { Path: dummySmallWav } }, transcriptPath: mainTranscript });
  assert.equal(rMainAud.decision, 'deny');

  // 4. Fresh subagent reading <= 15 MB video/audio -> allow
  assert.equal(
    runGuard({ toolCall: { name: 'read_file', args: { Path: dummySmallMp4 } }, transcriptPath: subFreshTranscript }).decision,
    'allow'
  );
  assert.equal(
    runGuard({ toolCall: { name: 'read_file', args: { Path: dummySmallWav } }, transcriptPath: subFreshTranscript }).decision,
    'allow'
  );

  // 5. Subagent reading > 15 MB video -> deny
  const rSubBig = runGuard({ toolCall: { name: 'read_file', args: { Path: dummyBigMp4 } }, transcriptPath: subFreshTranscript });
  assert.equal(rSubBig.decision, 'deny');
  assert.match(rSubBig.reason, /prep_media\.mjs/);

  // 6. Subagent exceeding 20 MB cumulative budget -> deny
  const rSubBudget = runGuard({ toolCall: { name: 'read_file', args: { Path: makeDummyFile('extra.mp4', 6 * 1024 * 1024) } }, transcriptPath: subHeavyTranscript });
  assert.equal(rSubBudget.decision, 'deny');
  assert.match(rSubBudget.reason, /cumulative session media/);

  // 7. Normal image -> allow; cumulative > 25 MB image -> ask
  assert.equal(
    runGuard({ toolCall: { name: 'read_file', args: { Path: dummyPng } }, transcriptPath: mainTranscript }).decision,
    'allow'
  );
  const rImgAsk = runGuard({ toolCall: { name: 'read_file', args: { Path: dummyLargePng } }, transcriptPath: imgHeavyTranscript });
  assert.equal(rImgAsk.decision, 'ask');

  // 8. Generate a synthetic test video via ffmpeg (if installed) and verify prep_media.mjs
  const synthVideo = path.join(tmpRoot, 'synth test 视频.mp4');
  execFileSync('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-c:a', 'aac',
    synthVideo,
  ], { stdio: 'ignore' });

  const prepOutDir = path.join(tmpRoot, 'prep-out');
  const infoRes = JSON.parse(execFileSync(process.execPath, [PREP_SCRIPT, '--input', synthVideo, '--mode', 'info'], { encoding: 'utf8' }));
  assert.equal(infoRes.info.hasVideo, true);
  assert.equal(infoRes.info.hasAudio, true);

  const kfRes = JSON.parse(execFileSync(process.execPath, [PREP_SCRIPT, '--input', synthVideo, '--mode', 'keyframes', '--out-dir', prepOutDir, '--cols', '2', '--rows', '2'], { encoding: 'utf8' }));
  assert.equal(fs.existsSync(kfRes.outputPath), true);

  const audRes = JSON.parse(execFileSync(process.execPath, [PREP_SCRIPT, '--input', synthVideo, '--mode', 'audio', '--out-dir', prepOutDir], { encoding: 'utf8' }));
  assert.equal(fs.existsSync(audRes.outputPath), true);

  const clipRes = JSON.parse(execFileSync(process.execPath, [PREP_SCRIPT, '--input', synthVideo, '--mode', 'clip', '--start', '1', '--duration', '2', '--out-dir', prepOutDir], { encoding: 'utf8' }));
  assert.equal(fs.existsSync(clipRes.outputPath), true);

  const compRes = JSON.parse(execFileSync(process.execPath, [PREP_SCRIPT, '--input', synthVideo, '--mode', 'compress', '--max-mb', '1', '--out-dir', prepOutDir], { encoding: 'utf8' }));
  assert.equal(fs.existsSync(compRes.outputPath), true);

  console.log(JSON.stringify({
    status: 'ALL_TESTS_PASSED',
    modesVerified: ['info', 'keyframes', 'audio', 'clip', 'compress'],
  }, null, 2));
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
