import express from "express";
import multer from "multer";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.FORMA_DATA || __dirname;
const PUBLIC = path.join(__dirname, "public");
const TMP = path.join(DATA, "tmp");
const CACHE = path.join(DATA, "cache");
const PORT = process.env.PORT === undefined || process.env.PORT === ""
  ? 4731
  : Number(process.env.PORT);
const MAX_BYTES = 800 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PRESETS = {
  "720": { w: 1280, h: 720, fps: 30, crf: 20 },
  "1080": { w: 1920, h: 1080, fps: 30, crf: 19 },
};

const jobs = new Map();
let active = 0;

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

function redact(value) {
  const text = typeof value === "string"
    ? value
    : (value?.stack || value?.message || String(value ?? ""));
  const pairs = [
    [TMP, "[tmp]"],
    [CACHE, "[cache]"],
    [DATA, "[data]"],
    [os.homedir(), "~"],
  ]
    .filter(([from]) => typeof from === "string" && from.length > 1)
    .sort((a, b) => b[0].length - a[0].length);
  return pairs.reduce((out, [from, to]) => out.split(from).join(to), text);
}

function findBin(name) {
  const env = {
    ...process.env,
    PATH: `${process.env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin`,
  };
  const candidates = [
    process.env[`FORMA_${name.toUpperCase()}`],
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    name,
  ].filter(Boolean);
  for (const bin of candidates) {
    const probe = spawnSync(bin, ["-version"], { encoding: "utf8", env });
    if (probe.status === 0) {
      const line = (probe.stdout || "").split("\n")[0] || "";
      const version = line.replace(new RegExp(`^${name} version\\s+`, "i"), "").split(" ")[0];
      return { bin, version };
    }
  }
  return { bin: null, version: null };
}

const ffmpegInfo = findBin("ffmpeg");
const ffprobeInfo = findBin("ffprobe");
const FFMPEG = ffmpegInfo.bin;
const FFPROBE = ffprobeInfo.bin;
const ffmpegVersion = ffmpegInfo.version;

function even(n) {
  return Math.max(2, 2 * Math.round(n / 2));
}

function fixName(name) {
  const raw = path.basename(name || "audio.ogg");
  const decoded = Buffer.from(raw, "latin1").toString("utf8");
  if (/[\u0400-\u04FF]/.test(decoded) && !/[\u0400-\u04FF]/.test(raw)) return decoded;
  return raw;
}

const INPUT_EXTENSIONS = new Set([
  "mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "aiff", "aif",
  "wma", "alac", "caf", "amr", "ac3", "mka", "weba", "mp4", "mov", "mkv",
  "webm", "ogv", "avi", "m4v",
]);

const TARGETS = {
  wav: { ext: "wav", video: false, audio: ["-c:a", "pcm_s16le"] },
  mp3: { ext: "mp3", video: false, audio: ["-c:a", "libmp3lame", "-q:a", "2"] },
  m4a: { ext: "m4a", video: false, audio: ["-c:a", "aac", "-b:a", "256k"], faststart: true },
  flac: { ext: "flac", video: false, audio: ["-c:a", "flac"] },
  ogg: { ext: "ogg", video: false, audio: ["-c:a", "libopus", "-b:a", "160k"] },
  opus: { ext: "opus", video: false, audio: ["-c:a", "libopus", "-b:a", "160k"] },
  aiff: { ext: "aiff", video: false, audio: ["-c:a", "pcm_s16be"] },
  "mp4-720": { ext: "mp4", video: true, preset: "720" },
  "mp4-1080": { ext: "mp4", video: true, preset: "1080" },
};

function isMediaUpload(file) {
  const ext = path.extname(file?.originalname || "").slice(1).toLowerCase();
  if (INPUT_EXTENSIONS.has(ext)) return true;
  const mime = String(file?.mimetype || "").toLowerCase();
  return mime.startsWith("audio/") || mime.startsWith("video/");
}

function outputName(original, ext) {
  const base = path.parse(fixName(original)).name || "audio";
  const clean = base.replace(/[^\w\u0400-\u04FF. ()\-]+/gu, "").trim().slice(0, 80);
  return `${clean || "audio"}.${ext}`;
}

function resolveTarget(requested) {
  return TARGETS[requested] ? requested : "mp4-720";
}

function probe(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE, [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      file,
    ]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(err || "ffprobe failed"));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function describe(meta) {
  const streams = meta.streams || [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration = Number(meta.format?.duration || audio?.duration || video?.duration || 0);
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    codec: audio?.codec_name || video?.codec_name || "",
    channels: audio?.channels || 0,
    sampleRate: Number(audio?.sample_rate || 0),
    width: video?.width || null,
    height: video?.height || null,
  };
}

function horizonFile(w, h) {
  const file = path.join(CACHE, `horizon-${w}x${h}.png`);
  if (fs.existsSync(file)) return file;
  const falloff = "exp(-((X-W/2)/(W*0.62))*((X-W/2)/(W*0.62))-((Y-H*1.02)/(H*0.48))*((Y-H*1.02)/(H*0.48)))";
  const geq = `r='5+48*${falloff}':g='3+16*${falloff}':b='8+92*${falloff}'`;
  if (!FFMPEG) return null;
  const result = spawnSync(FFMPEG, [
    "-hide_banner", "-y",
    "-f", "lavfi",
    "-i", `color=c=0x05040a:s=${w}x${h}:d=0.1,format=rgb24,geq=${geq}`,
    "-update", "1",
    "-frames:v", "1",
    file,
  ], { encoding: "utf8" });
  if (result.status !== 0 || !fs.existsSync(file)) return null;
  return file;
}

function audioFilter(preset, rich) {
  const { w, h, fps } = preset;
  if (!rich) {
    return [
      "[0:a]asplit=2[aw][ao]",
      `[aw]showwaves=s=${w}x${h}:mode=p2p:rate=${fps}:colors=0xC4B5FD:scale=sqrt,format=yuv420p[v]`,
    ].join(";");
  }
  const waveW = even(w * 0.86);
  const waveH = even(h * 0.36);
  const yShift = Math.round(h * 0.02);
  return [
    "[0:a]aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=2[aw][ao]",
    `[aw]showwaves=s=${waveW}x${waveH}:mode=p2p:rate=${fps}:colors=0xF4F1FF:scale=sqrt:draw=scale,format=rgb24,colorkey=0x000000:0.04:0.16,format=yuva420p[wave]`,
    "[1:v]format=yuv420p[bg]",
    `[bg][wave]overlay=(W-w)/2:(H-h)/2+${yShift}:format=auto:shortest=1[v]`,
  ].join(";");
}

function videoFilter(preset) {
  const { w, h, fps } = preset;
  return [
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x07060C`,
    "setsar=1",
    "format=yuv420p",
    `fps=${fps}[v]`,
  ].join(",");
}

function ffmpegArgs({ input, output, info, preset, rich, glow }) {
  const args = ["-hide_banner", "-y", "-i", input, "-stats_period", "0.25"];
  if (!info.hasVideo && rich && glow) {
    args.push("-loop", "1", "-framerate", String(preset.fps), "-i", glow);
  }
  if (info.hasVideo) {
    args.push("-filter_complex", videoFilter(preset), "-map", "[v]");
    if (info.hasAudio) args.push("-map", "0:a:0");
  } else {
    args.push("-filter_complex", audioFilter(preset, rich && Boolean(glow)), "-map", "[v]", "-map", "[ao]");
  }
  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", String(preset.crf),
    "-pix_fmt", "yuv420p",
  );
  if (info.hasAudio || !info.hasVideo) {
    args.push("-c:a", "aac", "-b:a", "192k");
  }
  if (!info.hasVideo) args.push("-shortest");
  args.push("-movflags", "+faststart", "-progress", "pipe:1", "-nostats", output);
  return args;
}

function audioExportArgs({ input, output, spec }) {
  const args = [
    "-hide_banner", "-y", "-i", input,
    "-vn", "-map", "0:a:0",
    "-stats_period", "0.25",
    ...spec.audio,
  ];
  if (spec.faststart) args.push("-movflags", "+faststart");
  args.push("-progress", "pipe:1", "-nostats", output);
  return args;
}

function progressSeconds(fields) {
  if (fields.out_time_us) return Number(fields.out_time_us) / 1e6;
  if (fields.out_time) {
    const match = fields.out_time.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  return null;
}

function humanize(log) {
  const text = log.toLowerCase();
  if (text.includes("invalid data") || text.includes("error opening input")) {
    return "This file cannot be read.";
  }
  if (text.includes("matches no streams") || text.includes("no audio stream") || text.includes("stream map")) {
    return "This file has no track that can be converted.";
  }
  if (text.includes("no space") || text.includes("disk full")) {
    return "The disk is full.";
  }
  if (text.includes("encoder") && text.includes("mp3")) {
    return "MP3 encoding is not available in this ffmpeg build.";
  }
  return "The conversion failed. Try another file.";
}

function filterBroke(log) {
  return /No such filter|Error reinitializing filters|Failed to configure|Option .* not found|Cannot find a matching/i.test(log);
}

function runFfmpeg(args, { duration, onProgress, shouldStop }) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args);
    let err = "";
    let buf = "";
    const fields = {};
    child.stderr.on("data", (chunk) => {
      err = (err + chunk.toString()).slice(-6000);
    });
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1);
        fields[key] = value;
        if (key === "progress" && duration > 0) {
          const secs = progressSeconds(fields);
          if (secs != null) onProgress(Math.max(0, Math.min(0.99, secs / duration)));
        }
      }
    });
    const timer = setInterval(() => {
      if (shouldStop()) child.kill("SIGKILL");
    }, 200);
    child.on("error", (error) => {
      clearInterval(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearInterval(timer);
      if (shouldStop()) {
        reject(Object.assign(new Error("cancelled"), { cancelled: true, log: err }));
        return;
      }
      if (code === 0) resolve();
      else reject(Object.assign(new Error(humanize(err)), { log: err }));
    });
  });
}

const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const id = randomUUID();
    const dir = path.join(TMP, id);
    fs.mkdirSync(dir, { recursive: true });
    req.jobId = id;
    req.jobDir = dir;
    cb(null, dir);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, `input${ext || ".ogg"}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    if (isMediaUpload(file)) cb(null, true);
    else cb(new Error("BAD_TYPE"));
  },
});

const app = express();
app.disable("x-powered-by");
app.use(express.static(PUBLIC, { index: "index.html" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: Boolean(ffmpegVersion), ffmpeg: ffmpegVersion });
});

app.get("/media/:id", (req, res) => {
  if (!UUID.test(req.params.id)) {
    res.status(404).end();
    return;
  }
  const job = jobs.get(req.params.id);
  if (!job?.output || !fs.existsSync(job.output)) {
    res.status(404).end();
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  if (req.query.download) {
    const ascii = `audio${path.extname(job.name).toLowerCase() || ".mp4"}`;
    const star = encodeURIComponent(job.name);
    res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${star}`);
  }
  res.sendFile(job.output);
});

app.delete("/api/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (job?.dir) fs.rmSync(job.dir, { recursive: true, force: true });
  jobs.delete(req.params.id);
  res.json({ ok: true });
});

app.post("/api/convert", (req, res) => {
  upload.single("file")(req, res, async (uploadErr) => {
    if (uploadErr) {
      if (req.jobDir) fs.rmSync(req.jobDir, { recursive: true, force: true });
      const tooBig = uploadErr.code === "LIMIT_FILE_SIZE";
      const badType = uploadErr.message === "BAD_TYPE";
      res.status(tooBig ? 413 : 400).json({
        error: tooBig
          ? "The file is larger than 800 MB."
          : badType
            ? "Use an audio or video file."
            : "The file could not be received.",
      });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No file arrived." });
      return;
    }
    if (!ffmpegVersion) {
      fs.rmSync(req.jobDir, { recursive: true, force: true });
      res.status(500).json({ error: "ffmpeg is not installed on this Mac." });
      return;
    }
    if (active >= 2) {
      fs.rmSync(req.jobDir, { recursive: true, force: true });
      res.status(429).json({ error: "Two conversions are already running." });
      return;
    }

    const id = req.jobId;
    const dir = req.jobDir;
    const target = resolveTarget(req.body.target || req.body.quality);
    const spec = TARGETS[target];
    const ext = spec.ext;
    const output = path.join(dir, `out.${ext}`);
    const name = outputName(req.file.originalname, ext);
    const preset = PRESETS[spec.preset] || PRESETS["720"];
    let aborted = false;
    let settled = false;
    active += 1;

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (payload) => {
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(payload)}\n`);
    };

    res.on("close", () => {
      if (!res.writableEnded) aborted = true;
    });

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      active = Math.max(0, active - 1);
      if (ok) fs.rmSync(req.file.path, { force: true });
      else fs.rmSync(dir, { recursive: true, force: true });
    };

    try {
      const info = describe(await probe(req.file.path));
      if (!info.hasAudio && (!spec.video || !info.hasVideo)) {
        write({ type: "error", message: "This file has no audio track to convert." });
        res.end();
        finish(false);
        return;
      }
      if (!info.hasAudio && !info.hasVideo) {
        write({ type: "error", message: "This file has no audio and no video." });
        res.end();
        finish(false);
        return;
      }
      if (info.duration > 0 && info.duration < 0.05) {
        write({ type: "error", message: "The file is too short." });
        res.end();
        finish(false);
        return;
      }

      write({ type: "probe", ...info, quality: target, format: ext });

      let lastSent = 0;
      const onProgress = (ratio) => {
        const now = Date.now();
        if (now - lastSent < 80 && ratio < 0.99) return;
        lastSent = now;
        write({ type: "progress", percent: Math.round(ratio * 1000) / 10 });
      };

      if (!spec.video) {
        await runFfmpeg(
          audioExportArgs({ input: req.file.path, output, spec }),
          { duration: info.duration, onProgress, shouldStop: () => aborted },
        );
      } else {
        const glow = info.hasVideo ? null : horizonFile(preset.w, preset.h);
        const attempt = (rich) => runFfmpeg(
          ffmpegArgs({ input: req.file.path, output, info, preset, rich: rich && Boolean(glow), glow }),
          { duration: info.duration, onProgress, shouldStop: () => aborted },
        );

        try {
          await attempt(!info.hasVideo);
        } catch (error) {
          if (error.cancelled || aborted) throw error;
          if (info.hasVideo || !filterBroke(error.log || "")) throw error;
          fs.rmSync(output, { force: true });
          await attempt(false);
        }
      }

      if (aborted) throw Object.assign(new Error("cancelled"), { cancelled: true });

      const bytes = fs.statSync(output).size;
      jobs.set(id, { id, dir, output, name, created: Date.now() });
      write({
        type: "done",
        id,
        url: `/media/${id}`,
        download: `/media/${id}?download=1`,
        name,
        bytes,
        format: ext,
      });
      res.end();
      finish(true);
    } catch (error) {
      if (!aborted && !error.cancelled) {
        console.error(redact(error.log || error));
        write({ type: "error", message: error.message || "The conversion failed." });
      }
      if (!res.writableEnded) res.end();
      finish(false);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.created > 60 * 60 * 1000) {
      fs.rmSync(job.dir, { recursive: true, force: true });
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();

export function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = address && typeof address === "object" ? address.port : port;
      const url = `http://127.0.0.1:${actual}`;
      console.log(`forma  →  ${url}`);
      resolve({ server, port: actual, url });
    });
    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") startServer(port + 1).then(resolve, reject);
      else reject(error);
    });
  });
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  startServer(PORT).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
