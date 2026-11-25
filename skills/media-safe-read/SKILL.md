---
name: media-safe-read
description: Safe workflow for inspecting video and audio files without bloating or freezing Antigravity sessions. Use when analyzing videos, screen recordings, or audio files, or when `read_file` / `view_file` is blocked by media-guard.
---

# Safe Media Reading (`media-safe-read`)

Antigravity attaches media read via `read_file` into the conversation's `logs/media/` directory. To keep the main session responsive and avoid re-uploading large payloads on every turn:

## Locating `prep_media.mjs`

Run `prep_media.mjs` from the installed `media-guard` plugin directory (or `../../scripts/prep_media.mjs` relative to this `SKILL.md` file):

- **Windows (PowerShell):**
  ```powershell
  node "$env:USERPROFILE\.gemini\config\plugins\media-guard\scripts\prep_media.mjs" ...
  ```
- **macOS / Linux:**
  ```bash
  node ~/.gemini/config/plugins/media-guard/scripts/prep_media.mjs ...
  ```

## Choose the Right Path

1. **Small Video / Audio (`<= 15 MB`) needing native multimodal inspection:**
   - Do **not** call `read_file` in the main session.
   - Launch a one-shot `invoke_subagent` (`TypeName: "self"`, `Model: "inherit"`) whose sole job is to call `read_file` on that single file and return a detailed text/timestamped summary.
   - Keep the subagent single-purpose (avoid multi-turn tool loops inside it).

2. **Large Video (`> 15 MB`) or multiple videos:**
   - **Probe metadata first:**
     ```bash
     node <prep_media.mjs> --input "<path>" --mode info
     ```
   - **Overview via keyframe contact sheet (`.jpg`):**
     ```bash
     node <prep_media.mjs> --input "<path>" --mode keyframes --out-dir "<scratch_dir>" --cols 4 --rows 3
     ```
     Then inspect the lightweight `*_keyframes.jpg` via `read_file`.
   - **Speech / audio extraction (`.mp3`, mono 32 kbps):**
     ```bash
     node <prep_media.mjs> --input "<path>" --mode audio --out-dir "<scratch_dir>"
     ```
   - **High-FPS / dynamic motion in a specific segment (recommended for motion analysis):**
     First locate the target timestamp via `--mode keyframes`, then slice just that window at full frame rate so it fits `<= 15 MB`:
     ```bash
     node <prep_media.mjs> --input "<path>" --mode clip --start 40 --duration 15 --out-dir "<scratch_dir>"
     ```
     Pass the clipped `.mp4` to a one-shot `invoke_subagent`.
   - **Compress full video to `<= 12 MB` for a one-shot subagent:**
     ```bash
     node <prep_media.mjs> --input "<path>" --mode compress --max-mb 12 --out-dir "<scratch_dir>"
     ```

3. **Alternative via `gemini-api` CLI (when `GEMINI_API_KEY` is configured):**
   - Upload once with `gemini-api files upload "<path>" --wait` (returns `files/<id>`), then run `gemini-api analyze -i "files/<id>" "..."` or `gemini-api transcribe -i "files/<id>"`. Only text returns to the session.

## Rescuing an Already-Bloated Session

- Do **not** rely on `/compact` inside a media-bloated session.
- Use native `分支会话` (or `branch-session`) from a turn **before** the media was read, or start a `New Conversation`.
