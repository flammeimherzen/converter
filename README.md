# forma

Local audio and video converter for macOS. Conversion runs on this computer with ffmpeg. Files are not uploaded.

## Requirements

- macOS 13 or newer
- Node.js 18 or newer
- ffmpeg and ffprobe (`brew install ffmpeg`)

## Run in the browser

```bash
npm install
npm run server
```

Open the address printed in the terminal. The server listens on `127.0.0.1` only.

## Run as a Mac app

```bash
npm install
npm run build
npm start
```

`forma.app` is built on your machine and is not part of this repository.

## Output

WAV, MP3, M4A, FLAC, OGG, Opus, AIFF, MP4 720p, and MP4 1080p. An audio-only file rendered to MP4 gets a generated waveform. A video keeps its picture, scaled into the chosen frame.

## Environment

- `PORT` — local server port. `0` picks a free port.
- `FORMA_DATA` — directory for temporary files and the generated background. Defaults to the project folder.
- `FORMA_FFMPEG` — path to the ffmpeg binary.
- `FORMA_FFPROBE` — path to the ffprobe binary.

## What stays off GitHub

`.gitignore` keeps local and private files out of the repository:

- `node_modules/`
- `forma.app/`
- `tmp/` — files being converted
- `cache/` — generated backgrounds
- `.env`, keys, and media dropped into the folder

Do not force-add those paths.
