# Media Guard Rules

To prevent Antigravity sessions from attaching raw video/audio binaries to history steps and re-uploading them on every turn:

1. Never call `read_file` (or `view_file`) directly on video or audio files in the main conversation session.
2. For video or audio analysis, load and follow the `media-safe-read` skill:
   - For files `<= 15 MB` needing native multimodal viewing/listening, delegate `read_file` to a one-shot `invoke_subagent` (`self`) and return only a text summary to the main session.
   - For files `> 15 MB`, preprocess locally with `prep_media.mjs` (`--mode keyframes`, `--mode audio`, `--mode clip`, or `--mode compress`) or use `gemini-api` (`files upload` + `analyze`/`transcribe`) before inspecting.
3. Never run `/compact` to rescue a session already bloated by video/audio attachments; branch from an earlier turn (`分支会话`) or start a new conversation instead.
