if (location.search.includes("shell=app")) sessionStorage.setItem("forma-shell", "app");
if (navigator.userAgent.includes("Electron") || sessionStorage.getItem("forma-shell") === "app") {
  document.documentElement.classList.add("app");
}

const $ = (id) => document.getElementById(id);

const els = {
  pill: $("pill"),
  veil: $("veil"),
  stage: $("stage"),
  wave: $("wave"),
  idle: $("view-idle"),
  ready: $("view-ready"),
  run: $("view-run"),
  done: $("view-done"),
  browse: $("browse"),
  replace: $("replace"),
  file: $("file"),
  fileName: $("file-name"),
  fileMeta: $("file-meta"),
  player: $("player"),
  play: $("play"),
  seek: $("seek"),
  clock: $("clock"),
  percent: $("percent"),
  status: $("status"),
  track: $("track"),
  bar: $("bar"),
  video: $("video"),
  result: $("result"),
  doneNote: $("done-note"),
  alert: $("alert"),
  go: $("go"),
  again: $("again"),
};

const state = {
  phase: "idle",
  file: null,
  kind: "media",
  quality: "mp4-720",
  userPicked: false,
  renderedQuality: null,
  peaks: null,
  duration: 0,
  channels: 0,
  jobId: null,
  downloadUrl: "",
  downloadName: "audio.mp4",
  abort: null,
  raf: 0,
  tick: 0,
  shown: 0,
  target: 0,
  animating: false,
  fileToken: 0,
  hasFfmpeg: true,
};

const audio = new Audio();
audio.preload = "metadata";
const ctx = els.wave.getContext("2d");

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const INPUT_EXTENSIONS = new Set([
  "mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "aiff", "aif",
  "wma", "alac", "caf", "amr", "ac3", "mka", "weba", "mp4", "mov", "mkv",
  "webm", "ogv", "avi", "m4v",
]);

const TARGET_LABELS = {
  wav: "WAV",
  mp3: "MP3",
  m4a: "M4A",
  flac: "FLAC",
  ogg: "OGG",
  opus: "OPUS",
  aiff: "AIFF",
  "mp4-720": "MP4",
  "mp4-1080": "MP4",
};

const FALLBACK = {
  mp3: "wav",
  wav: "mp3",
  m4a: "wav",
  aac: "m4a",
  flac: "wav",
  ogg: "mp4-720",
  oga: "mp4-720",
  opus: "mp4-720",
  ogv: "mp4-720",
  aiff: "wav",
  aif: "wav",
  mp4: "wav",
  mov: "wav",
  mkv: "wav",
  webm: "wav",
  avi: "wav",
  m4v: "wav",
};

function inputExt(file) {
  return (file?.name || "").split(".").pop()?.toLowerCase() || "";
}

function isAccepted(file) {
  if (!file) return false;
  if (INPUT_EXTENSIONS.has(inputExt(file))) return true;
  return /^(audio|video)\//.test(file.type || "");
}

function outputExt(target) {
  return target === "mp4-720" || target === "mp4-1080" ? "mp4" : target;
}

function outputLabel(target = state.quality) {
  return TARGET_LABELS[target] || "FILE";
}

function chooseTarget(file) {
  const ext = inputExt(file);
  const same = outputExt(state.quality) === ext;
  if (!state.userPicked) {
    if (["ogg", "oga", "opus", "ogv"].includes(ext)) return "mp4-720";
    if (same) return FALLBACK[ext] || "wav";
    return state.quality;
  }
  if (same) return FALLBACK[ext] || "wav";
  return state.quality;
}

function showAlert(message) {
  els.alert.hidden = !message;
  els.alert.textContent = message || "";
}

function setQuality(quality) {
  state.quality = quality;
  document.querySelectorAll("[data-target]").forEach((button) => {
    button.setAttribute("aria-checked", button.dataset.target === quality ? "true" : "false");
  });
}

function setPhase(phase) {
  state.phase = phase;
  els.idle.hidden = phase !== "idle";
  els.ready.hidden = phase !== "ready";
  els.run.hidden = phase !== "run";
  els.done.hidden = phase !== "done";
  els.stage.classList.toggle("is-done", phase === "done");
  els.again.hidden = phase !== "done";
  const locked = phase === "run";
  document.querySelectorAll("[data-target]").forEach((button) => {
    button.disabled = locked;
  });

  if (phase === "run") {
    els.go.textContent = "Cancel";
    els.go.disabled = false;
    els.go.classList.add("ghost");
  } else if (phase === "done") {
    els.go.textContent = `Download ${outputLabel()}`;
    els.go.disabled = false;
    els.go.classList.remove("ghost");
  } else if (phase === "ready") {
    els.go.textContent = `Convert to ${outputLabel()}`;
    els.go.disabled = !state.hasFfmpeg;
    els.go.classList.remove("ghost");
  } else {
    els.go.textContent = "Convert";
    els.go.disabled = true;
    els.go.classList.remove("ghost");
  }
  paint();
}

function resizeCanvas() {
  const rect = els.stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (els.wave.width !== w || els.wave.height !== h) {
    els.wave.width = w;
    els.wave.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawIdle() {
  resizeCanvas();
  const w = els.stage.clientWidth;
  const h = els.stage.clientHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  const mid = h * 0.8;
  const amp = Math.min(22, h * 0.06);
  for (let x = 0; x <= w; x += 3) {
    const n = Math.sin(x * 0.018 + state.tick) * 0.55
      + Math.sin(x * 0.009 - state.tick * 1.3) * 0.35
      + Math.sin(x * 0.045 + state.tick * 0.35) * 0.18;
    const y = mid + n * amp;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "rgba(90, 58, 210, 0.9)";
  ctx.lineWidth = 1.6;
  ctx.shadowColor = "rgba(109, 74, 255, 0.35)";
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.shadowBlur = 0;
  state.tick += 0.016;
}

function drawPeaks() {
  resizeCanvas();
  const w = els.stage.clientWidth;
  const h = els.stage.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const peaks = state.peaks;
  if (!peaks?.length) {
    drawIdle();
    return;
  }
  const padX = 26;
  const gap = 3;
  const barW = Math.max(2, (w - padX * 2 - gap * (peaks.length - 1)) / peaks.length);
  const max = peaks.reduce((m, v) => (v > m ? v : m), 0.02);
  const head = audio.duration ? audio.currentTime / audio.duration : -1;
  const usable = h * 0.32;
  ctx.shadowColor = "rgba(109, 74, 255, 0.2)";
  ctx.shadowBlur = 10;
  for (let i = 0; i < peaks.length; i++) {
    const bh = Math.max(3, (peaks[i] / max) * usable);
    const x = padX + i * (barW + gap);
    const y = (h - bh) / 2;
    ctx.fillStyle = head > 0.01 && i / peaks.length <= head
      ? "#16161a"
      : "rgba(109, 74, 255, 0.82)";
    ctx.beginPath();
    ctx.roundRect(x, y, Math.max(1.5, barW - 0.4), bh, 99);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

function paint() {
  cancelAnimationFrame(state.raf);
  if (state.phase === "done") return;
  if (state.phase === "idle" || !state.peaks) {
    const step = () => {
      if (state.phase === "done") return;
      if (state.phase !== "idle" && state.peaks) {
        drawPeaks();
        return;
      }
      drawIdle();
      state.raf = requestAnimationFrame(step);
    };
    state.raf = requestAnimationFrame(step);
    return;
  }
  drawPeaks();
}

function extractPeaks(buffer, count) {
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const block = Math.max(1, Math.floor(left.length / count));
  const step = Math.max(1, Math.floor(block / 70));
  const peaks = new Array(count);
  for (let i = 0; i < count; i++) {
    let max = 0;
    const start = i * block;
    for (let j = 0; j < block; j += step) {
      const a = Math.abs(left[start + j] || 0);
      const b = right ? Math.abs(right[start + j] || 0) : 0;
      if (a > max) max = a;
      if (b > max) max = b;
    }
    peaks[i] = max;
  }
  return peaks;
}

function metaLine() {
  const bits = [formatBytes(state.file.size)];
  if (state.duration) bits.push(formatTime(state.duration));
  if (state.channels) bits.push(state.channels > 1 ? "stereo" : "mono");
  els.fileMeta.textContent = bits.join("   ·   ");
}

async function useFile(file) {
  if (!file) return;
  if (!isAccepted(file)) {
    showAlert("Use an audio or video file.");
    return;
  }
  const token = ++state.fileToken;
  showAlert("");
  stopPlayback();
  forgetJob();
  els.video.pause();
  els.video.removeAttribute("src");
  els.video.load();
  els.result.pause();
  els.result.removeAttribute("src");
  els.result.hidden = true;
  els.video.hidden = false;
  state.file = file;
  setQuality(chooseTarget(file));
  state.peaks = null;
  state.duration = 0;
  state.channels = 0;
  state.renderedQuality = null;
  els.fileName.textContent = file.name;
  metaLine();
  els.player.hidden = false;
  const url = URL.createObjectURL(file);
  audio.src = url;
  setPhase("ready");

  audio.addEventListener("loadedmetadata", () => {
    if (token !== state.fileToken) return;
    if (!state.duration && Number.isFinite(audio.duration)) {
      state.duration = audio.duration;
      metaLine();
    }
  }, { once: true });
  audio.addEventListener("error", () => {
    if (token !== state.fileToken || audio.src !== url) return;
    els.player.hidden = true;
  }, { once: true });

  if (file.size > 48 * 1024 * 1024) return;
  try {
    const copy = (await file.arrayBuffer()).slice(0);
    const ac = new AudioContext();
    const decoded = await ac.decodeAudioData(copy);
    if (token !== state.fileToken) {
      ac.close();
      return;
    }
    state.duration = decoded.duration;
    state.channels = decoded.numberOfChannels;
    state.peaks = extractPeaks(decoded, 96);
    metaLine();
    ac.close();
    paint();
  } catch {
    // Waveform preview is optional. ffmpeg still builds the file.
  }
}

function stopPlayback() {
  audio.pause();
  if (audio.src) URL.revokeObjectURL(audio.src);
  audio.removeAttribute("src");
  els.play.classList.remove("is-on");
  els.play.querySelector(".i-play").hidden = false;
  els.play.querySelector(".i-pause").hidden = true;
  els.seek.value = "0";
  els.clock.textContent = "0:00";
}

function forgetJob() {
  if (!state.jobId) return;
  fetch(`/api/job/${state.jobId}`, { method: "DELETE" }).catch(() => {});
  state.jobId = null;
}

function resetAll() {
  state.abort?.abort();
  stopPlayback();
  forgetJob();
  els.video.pause();
  els.video.removeAttribute("src");
  els.video.load();
  els.result.pause();
  els.result.removeAttribute("src");
  els.result.hidden = true;
  els.video.hidden = false;
  state.file = null;
  state.userPicked = false;
  setQuality("mp4-720");
  state.peaks = null;
  state.renderedQuality = null;
  showAlert("");
  setPhase("idle");
}

function statusFor(percent, probe) {
  const ext = outputExt(state.quality);
  if (percent < 8) return "reading the file";
  if (percent > 92) return "writing the file";
  if (ext === "mp4" && probe?.hasVideo) return "keeping the picture";
  if (ext === "mp4") return "drawing the wave";
  return `encoding ${ext}`;
}

function renderPercent(value) {
  const shown = Math.max(0, Math.min(100, value));
  els.percent.textContent = String(Math.round(shown));
  if (!els.track.classList.contains("wait")) els.bar.style.width = `${shown}%`;
}

function animateTo(target) {
  state.target = target;
  if (state.animating) return;
  state.animating = true;
  const step = () => {
    state.shown += (state.target - state.shown) * 0.18;
    if (Math.abs(state.target - state.shown) < 0.2) state.shown = state.target;
    renderPercent(state.shown);
    if (state.shown !== state.target && state.phase === "run") requestAnimationFrame(step);
    else state.animating = false;
  };
  requestAnimationFrame(step);
}

async function convert() {
  if (!state.file || state.phase === "run" || !state.hasFfmpeg) return;
  showAlert("");
  audio.pause();
  els.video.pause();
  forgetJob();
  state.animating = false;
  state.shown = 0;
  state.target = 0;
  renderPercent(0);
  els.track.classList.add("wait");
  els.bar.style.width = "";
  els.status.textContent = "reading the file";
  setPhase("run");

  const controller = new AbortController();
  state.abort = controller;
  const body = new FormData();
  body.append("file", state.file);
  body.append("target", state.quality);
  let probe = null;

  try {
    const response = await fetch("/api/convert", { method: "POST", body, signal: controller.signal });
    const type = response.headers.get("content-type") || "";
    if (!response.ok && type.includes("application/json")) {
      const payload = await response.json();
      throw new Error(payload.error || "The conversion failed.");
    }
    if (!response.ok || !response.body) throw new Error("The conversion failed.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "probe") {
          probe = event;
          if (event.duration) state.duration = event.duration;
          const codec = [event.codec, event.sampleRate ? `${Math.round(event.sampleRate / 1000)} kHz` : ""]
            .filter(Boolean)
            .join(" · ");
          els.status.textContent = codec || statusFor(0, event);
        } else if (event.type === "progress") {
          els.track.classList.remove("wait");
          const label = statusFor(event.percent, probe);
          els.status.textContent = probe?.codec ? `${label}  ·  ${probe.codec}` : label;
          animateTo(event.percent);
        } else if (event.type === "error") {
          throw new Error(event.message);
        } else if (event.type === "done") {
          state.jobId = event.id;
          state.downloadUrl = event.download;
          state.downloadName = event.name;
          state.renderedQuality = state.quality;
          els.track.classList.remove("wait");
          animateTo(100);
          const label = (event.format || outputExt(state.quality)).toUpperCase();
          els.doneNote.textContent = `Ready  ·  ${formatBytes(event.bytes)}  ·  ${label}`;
          const showVideo = event.format === "mp4" || (!event.format && outputExt(state.quality) === "mp4");
          if (showVideo) {
            els.result.hidden = true;
            els.video.hidden = false;
            els.video.src = event.url;
            els.video.play().catch(() => {});
          } else {
            els.video.pause();
            els.video.hidden = true;
            els.result.hidden = false;
            els.result.src = event.url;
            els.result.onerror = () => {
              els.result.hidden = true;
            };
          }
          setPhase("done");
        }
      }
    }
    if (state.phase === "run") throw new Error("The conversion stopped before a file was ready.");
  } catch (error) {
    if (error.name === "AbortError") {
      setPhase(state.file ? "ready" : "idle");
      showAlert("Conversion cancelled.");
      return;
    }
    setPhase(state.file ? "ready" : "idle");
    showAlert(error.message || "The conversion failed.");
  } finally {
    state.abort = null;
  }
}

function download() {
  if (!state.downloadUrl) return;
  const absolute = new URL(state.downloadUrl, location.origin).href;
  const bridge = window.webkit?.messageHandlers?.saveFile;
  if (bridge) {
    bridge.postMessage({ url: absolute, name: state.downloadName || "audio.wav" });
    return;
  }
  const link = document.createElement("a");
  link.href = absolute;
  link.download = state.downloadName || "audio.wav";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function pickFile(list) {
  return [...list].find((file) => isAccepted(file)) || null;
}

els.browse.addEventListener("click", () => els.file.click());
els.replace.addEventListener("click", () => els.file.click());
els.file.addEventListener("change", () => {
  const file = els.file.files?.[0];
  els.file.value = "";
  if (file) useFile(file);
});
els.again.addEventListener("click", resetAll);
els.go.addEventListener("click", () => {
  if (state.phase === "run") state.abort?.abort();
  else if (state.phase === "done") download();
  else convert();
});

document.querySelectorAll("[data-target]").forEach((button) => {
  button.addEventListener("click", () => {
    const next = button.dataset.target;
    if (state.phase === "run" || next === state.quality) return;
    state.userPicked = true;
    setQuality(next);
    if (state.phase === "ready") setPhase("ready");
    if (state.phase === "done" && state.file && state.renderedQuality !== next) convert();
  });
});

els.play.addEventListener("click", async () => {
  if (!audio.src) return;
  if (audio.paused) {
    try { await audio.play(); } catch { /* autoplay or codec */ }
  } else {
    audio.pause();
  }
});
audio.addEventListener("play", () => {
  els.play.classList.add("is-on");
  els.play.querySelector(".i-play").hidden = true;
  els.play.querySelector(".i-pause").hidden = false;
  els.play.setAttribute("aria-label", "Pause");
});
audio.addEventListener("pause", () => {
  els.play.classList.remove("is-on");
  els.play.querySelector(".i-play").hidden = false;
  els.play.querySelector(".i-pause").hidden = true;
  els.play.setAttribute("aria-label", "Play");
});
audio.addEventListener("timeupdate", () => {
  if (!audio.duration) return;
  if (document.activeElement !== els.seek) {
    els.seek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
  }
  els.clock.textContent = formatTime(audio.currentTime);
  if (state.peaks && state.phase === "ready") drawPeaks();
});
audio.addEventListener("ended", () => {
  els.seek.value = "0";
  els.clock.textContent = formatTime(audio.duration || 0);
});
els.seek.addEventListener("input", () => {
  if (!audio.duration) return;
  audio.currentTime = (Number(els.seek.value) / 1000) * audio.duration;
});

window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && state.phase === "ready") {
    event.preventDefault();
    convert();
  }
  if (event.key === "Escape" && state.phase === "run") state.abort?.abort();
});

let dragDepth = 0;
function isFileDrag(event) {
  return [...(event.dataTransfer?.types || [])].includes("Files");
}
window.addEventListener("dragover", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
});
window.addEventListener("dragenter", (event) => {
  if (!isFileDrag(event)) return;
  dragDepth += 1;
  els.veil.hidden = false;
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.veil.hidden = true;
});
window.addEventListener("drop", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth = 0;
  els.veil.hidden = true;
  const file = pickFile(event.dataTransfer.files);
  if (file) useFile(file);
  else if (event.dataTransfer.files?.length) showAlert("Use an audio or video file.");
});

new ResizeObserver(() => paint()).observe(els.stage);

fetch("/api/health")
  .then((response) => response.json())
  .then((health) => {
    state.hasFfmpeg = Boolean(health.ok);
    if (!health.ok) {
      els.pill.textContent = "no ffmpeg";
      els.pill.classList.add("warn");
      showAlert("ffmpeg was not found on this Mac, so nothing can be converted.");
      els.go.disabled = true;
    }
  })
  .catch(() => {});

setPhase("idle");
