import "./style.css";
import * as PIXI from "pixi.js";
import { BaseTexture, MIPMAP_MODES, SCALE_MODES, Texture } from "pixi.js";
import { TextureAtlas } from "@pixi-spine/base";
import { AtlasAttachmentLoader, SkeletonData, SkeletonJson, Spine } from "@pixi-spine/runtime-3.7";
import { GIFEncoder, applyPalette, quantize, type GifPalette } from "gifenc";
import { SkeletonBinary37 } from "./skeletonBinary37";

type SpineData = SkeletonData & {
  binaryAnimationsParsed?: boolean;
  skins: Array<{ name: string; attachments?: unknown[]; getAttachments?: () => unknown[] }>;
};

type SpineDisplay = PIXI.Container & {
  autoUpdate: boolean;
  skeleton: {
    setToSetupPose?: () => void;
    setSkinByName(name: string): void;
    setSlotsToSetupPose(): void;
    updateWorldTransform?: () => void;
  };
  state: {
    timeScale: number;
    clearTracks(): void;
    setAnimation(trackIndex: number, animationName: string, loop: boolean): void;
  };
  scale: PIXI.ObservablePoint;
  position: PIXI.ObservablePoint;
  pivot: PIXI.ObservablePoint;
  skew: PIXI.ObservablePoint;
  rotation: number;
  update(dt: number): void;
  getLocalBounds(): PIXI.Rectangle;
  destroy(options?: unknown): void;
};

type LoadedPose = {
  file: File;
  data: SpineData;
  attachments: number;
  summary: string;
};

type LoadedSpine = {
  atlas: TextureAtlas;
  spine: SpineDisplay | null;
  urls: string[];
  poses: LoadedPose[];
  poseIndex: number;
  zoom: number;
};

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element.");

root.innerHTML = `
  <main id="appShell">
    <aside id="sidePanel">
      <section class="panelBlock">
        <div class="panelTitle">Spine Viewer</div>
        <button id="browseButton" type="button">Browse files</button>
        <input id="fileInput" type="file" multiple accept=".skel,.json,.atlas,.png,.bytes,.txt" />
        <div id="status"></div>
      </section>

      <section class="panelBlock">
        <label for="poseSelect">Pose</label>
        <select id="poseSelect" disabled></select>
      </section>

      <section class="panelBlock">
        <label for="skinSelect">Skin</label>
        <select id="skinSelect" disabled></select>
      </section>

      <section class="panelBlock">
        <label for="animationSelect">Animation</label>
        <select id="animationSelect" disabled></select>
        <div class="controlRow">
          <button id="playButton" type="button" disabled>Play</button>
          <button id="stopButton" type="button" disabled>Reset</button>
        </div>
        <label for="speedRange">Speed</label>
        <input id="speedRange" type="range" min="0.1" max="2" step="0.1" value="1" disabled />
      </section>

      <section class="panelBlock">
        <label>GIF Export</label>
        <div class="controlGrid">
          <label for="gifFpsInput">FPS</label>
          <input id="gifFpsInput" type="number" min="1" max="60" step="1" value="24" />
          <label for="gifSecondsInput">Seconds</label>
          <input id="gifSecondsInput" type="number" min="0.5" max="20" step="0.1" value="3.3" />
          <label for="gifWidthInput">Width</label>
          <input id="gifWidthInput" type="number" min="128" max="1920" step="64" value="640" />
          <label for="gifBackgroundSelect">Background</label>
          <select id="gifBackgroundSelect">
            <option value="transparent">Transparent</option>
            <option value="discord">Discord matte</option>
          </select>
        </div>
        <button id="exportGifButton" type="button" disabled>Export GIF</button>
      </section>

      <section class="panelBlock">
        <label for="zoomRange">Zoom</label>
        <input id="zoomRange" type="range" min="0.25" max="2" step="0.05" value="1" disabled />
        <button id="fitButton" type="button" disabled>Fit</button>
      </section>
    </aside>

    <section id="viewerPanel">
      <div id="viewerFrame">
        <div id="dropOverlay">Drop files here</div>
      </div>
    </section>
  </main>
`;

const appShell = document.getElementById("appShell") as HTMLElement;
const viewerFrame = document.getElementById("viewerFrame") as HTMLDivElement;
const browseButton = document.getElementById("browseButton") as HTMLButtonElement;
const fileInput = document.getElementById("fileInput") as HTMLInputElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const dropOverlay = document.getElementById("dropOverlay") as HTMLDivElement;
const poseSelect = document.getElementById("poseSelect") as HTMLSelectElement;
const skinSelect = document.getElementById("skinSelect") as HTMLSelectElement;
const animationSelect = document.getElementById("animationSelect") as HTMLSelectElement;
const playButton = document.getElementById("playButton") as HTMLButtonElement;
const stopButton = document.getElementById("stopButton") as HTMLButtonElement;
const speedRange = document.getElementById("speedRange") as HTMLInputElement;
const gifFpsInput = document.getElementById("gifFpsInput") as HTMLInputElement;
const gifSecondsInput = document.getElementById("gifSecondsInput") as HTMLInputElement;
const gifWidthInput = document.getElementById("gifWidthInput") as HTMLInputElement;
const gifBackgroundSelect = document.getElementById("gifBackgroundSelect") as HTMLSelectElement;
const exportGifButton = document.getElementById("exportGifButton") as HTMLButtonElement;
const zoomRange = document.getElementById("zoomRange") as HTMLInputElement;
const fitButton = document.getElementById("fitButton") as HTMLButtonElement;

PIXI.settings.SCALE_MODE = SCALE_MODES.LINEAR;
PIXI.settings.MIPMAP_TEXTURES = MIPMAP_MODES.ON;

const app = new PIXI.Application({
  resizeTo: viewerFrame,
  backgroundColor: 0x111111,
  backgroundAlpha: 0,
  antialias: true,
  autoDensity: true,
  resolution: Math.min(window.devicePixelRatio || 1, 3),
});
viewerFrame.appendChild(app.view as HTMLCanvasElement);

let active: LoadedSpine | null = null;
let playing = false;
let trackLoaded = false;
let exportingGif = false;
setStatus("Drop .skel/.json + .atlas + .png, or browse files.");

function setStatus(message = "") {
  statusEl.textContent = message;
  statusEl.style.display = message ? "block" : "none";
}

function normalizeName(name: string) {
  const base = name.replace(/\\/g, "/").split("/").pop() || name;
  return base.toLowerCase().replace(/\.bytes$/i, "").replace(/\.txt$/i, "");
}

function findFiles(files: File[], extensions: string[]) {
  return files.filter((file) => {
    const name = normalizeName(file.name);
    return extensions.some((ext) => name.endsWith(ext));
  });
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function readBinary(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not decode ${url}`));
    image.src = url;
  });
}

function findAtlasImage(pageName: string, imageFiles: File[]) {
  const expected = normalizeName(pageName);
  return imageFiles.find((file) => normalizeName(file.name) === expected);
}

async function createAtlas(atlasText: string, imageFiles: File[], urls: string[]) {
  const textures = new Map<string, BaseTexture>();
  const pageNames = atlasText
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes(":") && normalizeName(line).endsWith(".png"));

  for (const pageName of pageNames) {
    const file = findAtlasImage(pageName, imageFiles);
    if (!file) throw new Error(`Missing PNG for atlas page "${pageName}".`);

    const url = URL.createObjectURL(file);
    urls.push(url);
    const image = await loadImage(url);
    const texture = Texture.from(image);
    texture.baseTexture.scaleMode = SCALE_MODES.LINEAR;
    texture.baseTexture.mipmap = MIPMAP_MODES.ON;
    textures.set(pageName, texture.baseTexture);
    textures.set(normalizeName(pageName), texture.baseTexture);
  }

  return new Promise<TextureAtlas>((resolve, reject) => {
    try {
      new TextureAtlas(
        atlasText,
        (path, callback) => {
          const texture = textures.get(path) ?? textures.get(normalizeName(path));
          if (!texture) throw new Error(`No texture loaded for atlas page "${path}".`);
          callback(texture);
        },
        (atlasObj) => resolve(atlasObj)
      );
    } catch (error) {
      reject(error);
    }
  });
}

function readSkeletonData(file: File, atlas: TextureAtlas): Promise<SpineData> {
  const loader = new AtlasAttachmentLoader(atlas);
  const name = normalizeName(file.name);

  if (name.endsWith(".json")) {
    return readText(file).then((text) => {
      const parser = new SkeletonJson(loader);
      parser.scale = 1;
      return parser.readSkeletonData(text) as SpineData;
    });
  }

  return readBinary(file).then((bytes) => {
    const parser = new SkeletonBinary37(atlas);
    parser.scale = 1;
    return parser.readSkeletonData(bytes) as SpineData;
  });
}

function countAttachments(data: SpineData) {
  let count = 0;
  for (const skin of data.skins) {
    if (typeof skin.getAttachments === "function") count += skin.getAttachments().length;
    else if (Array.isArray(skin.attachments)) {
      count += skin.attachments.reduce<number>((sum, slot) => {
        if (!slot) return sum;
        if (slot instanceof Map) return sum + slot.size;
        return sum + Object.keys(slot as Record<string, unknown>).length;
      }, 0);
    }
  }
  return count;
}

function makeSummary(file: File, data: SpineData, attachments: number) {
  const animationSummary = data.binaryAnimationsParsed === false ? "setup pose only" : `animations ${data.animations.length}`;
  return `${file.name}: version ${data.version || "?"}, bones ${data.bones.length}, slots ${data.slots.length}, skins ${data.skins.length}, attachments ${attachments}, ${animationSummary}`;
}

async function readAllSkeletons(files: File[], atlas: TextureAtlas) {
  const poses: LoadedPose[] = [];
  const attempts: string[] = [];

  for (const file of files) {
    try {
      const data = await readSkeletonData(file, atlas);
      const attachments = countAttachments(data);
      const summary = makeSummary(file, data, attachments);
      attempts.push(summary);
      if (attachments > 0 || data.bones.length > 0) poses.push({ file, data, attachments, summary });
    } catch (error) {
      attempts.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!poses.length) throw new Error(`Could not read any skeleton file.\n${attempts.join("\n")}`);
  poses.sort((a, b) => b.attachments - a.attachments);
  return { poses, attempts };
}

function selectedPose() {
  return active?.poses[active.poseIndex] ?? null;
}

function centerInStage(spine: SpineDisplay, zoom = active?.zoom ?? 1) {
  spine.scale.set(1);
  spine.position.set(0, 0);
  spine.pivot.set(0, 0);
  spine.skew.set(0, 0);
  spine.rotation = 0;
  spine.update(0);

  const local = spine.getLocalBounds();
  const stageWidth = app.screen.width;
  const stageHeight = app.screen.height;
  const fitScale = Math.min(
    1,
    (stageWidth * 0.76) / Math.max(1, local.width),
    (stageHeight * 0.78) / Math.max(1, local.height)
  );
  const scale = fitScale * zoom;

  spine.scale.set(scale);
  spine.position.set(
    stageWidth / 2 - (local.x + local.width / 2) * scale,
    stageHeight / 2 - (local.y + local.height / 2) * scale
  );
}

function updateControlState() {
  const pose = selectedPose();
  const hasPose = Boolean(pose && active?.spine);
  const hasAnimation = hasPose && (pose?.data.animations.length ?? 0) > 0;
  poseSelect.disabled = !hasPose || (active?.poses.length ?? 0) < 2;
  skinSelect.disabled = !hasPose || (pose?.data.skins.length ?? 0) < 2;
  animationSelect.disabled = !hasAnimation || exportingGif;
  playButton.disabled = animationSelect.disabled;
  stopButton.disabled = animationSelect.disabled;
  speedRange.disabled = animationSelect.disabled;
  exportGifButton.disabled = !hasAnimation || exportingGif;
  gifFpsInput.disabled = exportingGif;
  gifSecondsInput.disabled = exportingGif;
  gifWidthInput.disabled = exportingGif;
  gifBackgroundSelect.disabled = exportingGif;
  zoomRange.disabled = !hasPose;
  fitButton.disabled = !hasPose;
}

function populateControls() {
  if (!active) return;
  poseSelect.innerHTML = active.poses
    .map((pose, index) => `<option value="${index}">${pose.file.name}</option>`)
    .join("");
  poseSelect.value = String(active.poseIndex);
  populatePoseDependentControls();
}

function populatePoseDependentControls() {
  const pose = selectedPose();
  if (!pose) return;

  skinSelect.innerHTML = pose.data.skins
    .map((skin) => `<option value="${skin.name}">${skin.name}</option>`)
    .join("");
  skinSelect.value = pose.data.skins[0]?.name ?? "";

  if (pose.data.animations.length) {
    animationSelect.innerHTML = pose.data.animations
      .map((animation) => `<option value="${animation.name}">${animation.name}</option>`)
      .join("");
  } else {
    animationSelect.innerHTML = `<option value="">No embedded animations</option>`;
  }

  zoomRange.value = String(active?.zoom ?? 1);
  playButton.textContent = playing ? "Pause" : "Play";
  updateControlState();
}

function destroySpineOnly() {
  if (!active?.spine) return;
  app.stage.removeChild(active.spine);
  active.spine.destroy({ children: true });
  active.spine = null;
}

function destroyActive() {
  destroySpineOnly();
  if (!active) return;
  active.atlas.dispose();
  for (const url of active.urls) URL.revokeObjectURL(url);
  active = null;
}

function resetSkeletonPose(spine: SpineDisplay) {
  spine.state.clearTracks();
  trackLoaded = false;
  spine.skeleton.setToSetupPose?.();
  spine.skeleton.setSlotsToSetupPose();
  spine.skeleton.updateWorldTransform?.();
  spine.update(0);
}

function applyCurrentAnimation(resetFirst = true) {
  if (!active?.spine) return;
  const animationName = animationSelect.value;
  if (resetFirst) resetSkeletonPose(active.spine);
  else active.spine.state.clearTracks();
  if (animationName) {
    active.spine.state.setAnimation(0, animationName, true);
    trackLoaded = true;
    active.spine.state.timeScale = playing ? Number(speedRange.value) : 0;
    active.spine.update(0);
  }
}

function showPose(index: number) {
  if (!active) return;
  destroySpineOnly();
  active.poseIndex = index;
  const pose = active.poses[index];
  const spine = new Spine(pose.data) as SpineDisplay;
  spine.autoUpdate = true;
  app.stage.addChild(spine);
  active.spine = spine;
  playing = pose.data.animations.length > 0;
  populatePoseDependentControls();
  applyCurrentAnimation();
  centerInStage(spine);
  setStatus(`Loaded ${pose.file.name}\n${pose.summary}`);
}

async function loadSpine(files: File[]) {
  const skeletonFiles = findFiles(files, [".skel", ".json"]);
  const atlasFile = findFiles(files, [".atlas"])[0];
  const imageFiles = findFiles(files, [".png"]);

  if (skeletonFiles.length === 0 || !atlasFile || imageFiles.length === 0) {
    setStatus("Missing required files (.skel/.json, .atlas, .png).");
    return;
  }

  setStatus("Loading Spine 3.7 files...");
  destroyActive();

  const urls: string[] = [];
  const atlas = await createAtlas(await readText(atlasFile), imageFiles, urls);
  const { poses, attempts } = await readAllSkeletons(skeletonFiles, atlas);
  active = { atlas, spine: null, urls, poses, poseIndex: 0, zoom: 1 };
  populateControls();
  showPose(0);
  setStatus(`Loaded ${poses.length} pose${poses.length === 1 ? "" : "s"}.\n${attempts.join("\n")}`);
}

const resizeObserver = new ResizeObserver(() => {
  app.resize();
  if (active?.spine) centerInStage(active.spine);
});
resizeObserver.observe(viewerFrame);

browseButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files ?? []);
  if (files.length) loadSpine(files).catch((error) => setStatus(String(error)));
  fileInput.value = "";
});

poseSelect.addEventListener("change", () => showPose(Number(poseSelect.value)));
skinSelect.addEventListener("change", () => {
  if (!active?.spine || !skinSelect.value) return;
  active.spine.skeleton.setSkinByName(skinSelect.value);
  resetSkeletonPose(active.spine);
  applyCurrentAnimation();
  centerInStage(active.spine);
});
animationSelect.addEventListener("change", () => {
  playing = Boolean(animationSelect.value);
  playButton.textContent = playing ? "Pause" : "Play";
  applyCurrentAnimation();
});
playButton.addEventListener("click", () => {
  playing = !playing;
  playButton.textContent = playing ? "Pause" : "Play";
  if (active?.spine) {
    if (playing && !trackLoaded) applyCurrentAnimation();
    else active.spine.state.timeScale = playing ? Number(speedRange.value) : 0;
  }
});
stopButton.addEventListener("click", () => {
  playing = false;
  playButton.textContent = "Play";
  if (active?.spine) {
    resetSkeletonPose(active.spine);
    active.spine.state.timeScale = 0;
    active.zoom = 1;
    zoomRange.value = "1";
    centerInStage(active.spine, active.zoom);
  }
});
speedRange.addEventListener("input", () => {
  if (active?.spine && playing) active.spine.state.timeScale = Number(speedRange.value);
});
zoomRange.addEventListener("input", () => {
  if (!active?.spine) return;
  active.zoom = Number(zoomRange.value);
  centerInStage(active.spine, active.zoom);
});
fitButton.addEventListener("click", () => {
  if (!active?.spine) return;
  active.zoom = 1;
  zoomRange.value = "1";
  centerInStage(active.spine, active.zoom);
});
exportGifButton.addEventListener("click", () => {
  exportCurrentGif().catch((error) => {
    exportingGif = false;
    updateControlState();
    setStatus(`GIF export failed: ${error instanceof Error ? error.message : String(error)}`);
  });
});

async function exportCurrentGif() {
  if (!active?.spine) return;
  const pose = selectedPose();
  const animationName = animationSelect.value;
  if (!pose || !animationName) return;

  exportingGif = true;
  updateControlState();

  const spine = active.spine;
  const previousPlaying = playing;
  const previousAutoUpdate = spine.autoUpdate;
  const previousTimeScale = spine.state.timeScale;
  const fps = clamp(Math.round(Number(gifFpsInput.value) || 24), 1, 60);
  const seconds = clamp(Number(gifSecondsInput.value) || getAnimationDurationSeconds(pose, animationName), 0.5, 20);
  const frameCount = Math.max(1, Math.round(fps * seconds));
  const delay = 1000 / fps;
  const exportWidth = clamp(Math.round(Number(gifWidthInput.value) || 640), 128, 1920);
  const playbackSpeed = Number(speedRange.value) || 1;
  const transparentExport = gifBackgroundSelect.value !== "discord";

  try {
    setStatus(`Rendering GIF frames: 0/${frameCount}`);
    playing = false;
    spine.autoUpdate = false;
    resetSkeletonPose(spine);
    spine.state.setAnimation(0, animationName, true);
    spine.state.timeScale = 1;
    trackLoaded = true;

    const exportBounds = measureAnimationBounds(spine, animationName, frameCount, fps, playbackSpeed);
    resetSkeletonPose(spine);
    spine.state.setAnimation(0, animationName, true);
    spine.state.timeScale = 1;

    let frames: Array<{ rgba: Uint8ClampedArray; width: number; height: number }> = [];
    let width = 0;
    let height = 0;

    for (let frame = 0; frame < frameCount; frame += 1) {
      if (frame > 0) spine.update((1 / fps) * playbackSpeed);
      else spine.update(0);

      const captured = renderTransparentSpineFrame(spine, exportBounds, exportWidth);
      frames.push(captured);
      width = captured.width;
      height = captured.height;

      if (frame % 5 === 0 || frame === frameCount - 1) {
        setStatus(`Rendering GIF frames: ${frame + 1}/${frameCount}`);
        await nextAnimationFrame();
      }
    }

    frames = cropFramesToVisibleAlpha(frames);
    width = frames[0]?.width ?? width;
    height = frames[0]?.height ?? height;
    if (transparentExport) {
      frames = prepareTransparentGifFrames(frames);
    } else {
      frames = applyMatteToFrames(frames, [49, 51, 56]);
    }
    frames = stabilizeDarkGifColors(frames);
    frames = stabilizeTemporalDarkPixels(frames);
    frames = stabilizeLightGifColors(frames);
    frames = stabilizeTemporalLightPixels(frames);

    setStatus("Building shared GIF palette...");
    await nextAnimationFrame();
    const palette = buildSharedGifPalette(frames, transparentExport);
    const gif = GIFEncoder();
    const transparentIndex = 0;

    for (let frame = 0; frame < frames.length; frame += 1) {
      const index = applyPalette(frames[frame].rgba, palette, "rgb565");
      if (transparentExport) {
        applyTransparentGifIndex(index, frames[frame].rgba, palette, transparentIndex);
        gif.writeFrame(
          index,
          width,
          height,
          frame === 0
            ? { palette, delay, repeat: 0, transparent: true, transparentIndex, dispose: 2 }
            : { delay, transparent: true, transparentIndex, dispose: 2 }
        );
      } else {
        gif.writeFrame(index, width, height, frame === 0 ? { palette, delay, repeat: 0 } : { delay });
      }

      if (frame % 5 === 0 || frame === frameCount - 1) {
        setStatus(`Encoding GIF: ${frame + 1}/${frameCount} frames`);
        await nextAnimationFrame();
      }
    }

    gif.finish();
    const bytes = gif.bytesView();
    const gifBytes = new Uint8Array(bytes.length);
    gifBytes.set(bytes);
    const blob = new Blob([gifBytes.buffer as ArrayBuffer], { type: "image/gif" });
    const suffix = transparentExport ? "" : "-discord";
    downloadBlob(blob, `${fileBaseName(pose.file.name)}-${animationName}${suffix}.gif`);
    setStatus(`Exported GIF: ${frameCount} frames, ${fps} FPS, ${Math.round(blob.size / 1024)} KB`);
  } finally {
    spine.autoUpdate = previousAutoUpdate;
    spine.state.timeScale = previousTimeScale;
    playing = previousPlaying;
    applyCurrentAnimation(true);
    playButton.textContent = playing ? "Pause" : "Play";
    if (active?.spine) active.spine.state.timeScale = playing ? Number(speedRange.value) : 0;
    exportingGif = false;
    updateControlState();
  }
}

function measureAnimationBounds(
  spine: SpineDisplay,
  animationName: string,
  frameCount: number,
  fps: number,
  playbackSpeed: number
) {
  let union: PIXI.Rectangle | null = null;

  resetSkeletonPose(spine);
  spine.state.setAnimation(0, animationName, true);
  spine.state.timeScale = 1;

  for (let frame = 0; frame < frameCount; frame += 1) {
    if (frame > 0) spine.update((1 / fps) * playbackSpeed);
    else spine.update(0);

    const bounds = spine.getLocalBounds();
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    if (!union) {
      union = new PIXI.Rectangle(bounds.x, bounds.y, bounds.width, bounds.height);
    } else {
      const minX = Math.min(union.x, bounds.x);
      const minY = Math.min(union.y, bounds.y);
      const maxX = Math.max(union.x + union.width, bounds.x + bounds.width);
      const maxY = Math.max(union.y + union.height, bounds.y + bounds.height);
      union.x = minX;
      union.y = minY;
      union.width = maxX - minX;
      union.height = maxY - minY;
    }
  }

  return union ?? spine.getLocalBounds();
}

function renderTransparentSpineFrame(spine: SpineDisplay, bounds: PIXI.Rectangle, maxWidth: number) {
  const padding = 12;
  const scale = maxWidth / Math.max(1, bounds.width);
  const width = Math.max(1, Math.ceil(bounds.width * scale + padding * 2));
  const height = Math.max(1, Math.ceil(bounds.height * scale + padding * 2));
  const previous = captureSpineTransform(spine);
  const renderTexture = PIXI.RenderTexture.create({
    width,
    height,
    resolution: 1,
    scaleMode: SCALE_MODES.LINEAR,
  });
  renderTexture.baseTexture.clearColor = [0, 0, 0, 0];

  try {
    spine.position.set(padding - bounds.x * scale, padding - bounds.y * scale);
    spine.scale.set(scale);
    spine.pivot.set(0, 0);
    spine.skew.set(0, 0);
    spine.rotation = 0;
    const black = renderSpineFrameWithClear(spine, renderTexture, width, height, [0, 0, 0, 1]);
    const white = renderSpineFrameWithClear(spine, renderTexture, width, height, [1, 1, 1, 1]);
    const rgba = recoverAlphaFromMattePair(black, white);
    return { rgba, width, height };
  } finally {
    restoreSpineTransform(spine, previous);
    renderTexture.destroy(true);
  }
}

function renderSpineFrameWithClear(
  spine: SpineDisplay,
  renderTexture: PIXI.RenderTexture,
  width: number,
  height: number,
  clearColor: [number, number, number, number]
) {
  const renderer = app.renderer as PIXI.Renderer;
  renderer.renderTexture.bind(renderTexture);
  renderer.renderTexture.clear(clearColor);
  renderer.render(spine, { renderTexture, clear: false });
  const canvas = renderer.extract.canvas(renderTexture) as HTMLCanvasElement;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not read GIF export frame.");
  return context.getImageData(0, 0, width, height).data;
}

function recoverAlphaFromMattePair(black: Uint8ClampedArray, white: Uint8ClampedArray) {
  const rgba = new Uint8ClampedArray(black.length);

  for (let offset = 0; offset < black.length; offset += 4) {
    const diffR = white[offset] - black[offset];
    const diffG = white[offset + 1] - black[offset + 1];
    const diffB = white[offset + 2] - black[offset + 2];
    const matteDiff = clamp(Math.max(diffR, diffG, diffB), 0, 255);
    const alpha = clamp(255 - matteDiff, 0, 255);

    if (alpha <= 4) {
      rgba[offset] = 0;
      rgba[offset + 1] = 0;
      rgba[offset + 2] = 0;
      rgba[offset + 3] = 0;
      continue;
    }

    const alphaScale = 255 / alpha;
    rgba[offset] = clamp(Math.round(black[offset] * alphaScale), 0, 255);
    rgba[offset + 1] = clamp(Math.round(black[offset + 1] * alphaScale), 0, 255);
    rgba[offset + 2] = clamp(Math.round(black[offset + 2] * alphaScale), 0, 255);
    rgba[offset + 3] = alpha;
  }

  return rgba;
}

function cropFramesToVisibleAlpha(frames: Array<{ rgba: Uint8ClampedArray; width: number; height: number }>) {
  if (!frames.length) return frames;

  const alphaThreshold = 16;
  const padding = 4;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const frame of frames) {
    for (let y = 0; y < frame.height; y += 1) {
      for (let x = 0; x < frame.width; x += 1) {
        const alpha = frame.rgba[(y * frame.width + x) * 4 + 3];
        if (alpha <= alphaThreshold) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return frames;
  }

  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(frames[0].width - 1, maxX + padding);
  maxY = Math.min(frames[0].height - 1, maxY + padding);

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;

  return frames.map((frame) => {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const sourceStart = ((minY + y) * frame.width + minX) * 4;
      const sourceEnd = sourceStart + width * 4;
      rgba.set(frame.rgba.subarray(sourceStart, sourceEnd), y * width * 4);
    }
    return { rgba, width, height };
  });
}

function applyMatteToFrames(
  frames: Array<{ rgba: Uint8ClampedArray; width: number; height: number }>,
  matteRgb: [number, number, number]
) {
  return frames.map((frame) => {
    const rgba = new Uint8ClampedArray(frame.rgba.length);

    for (let offset = 0; offset < frame.rgba.length; offset += 4) {
      const alpha = frame.rgba[offset + 3] / 255;
      const inverseAlpha = 1 - alpha;
      rgba[offset] = Math.round(frame.rgba[offset] * alpha + matteRgb[0] * inverseAlpha);
      rgba[offset + 1] = Math.round(frame.rgba[offset + 1] * alpha + matteRgb[1] * inverseAlpha);
      rgba[offset + 2] = Math.round(frame.rgba[offset + 2] * alpha + matteRgb[2] * inverseAlpha);
      rgba[offset + 3] = 255;
    }

    return {
      rgba,
      width: frame.width,
      height: frame.height,
    };
  });
}

function prepareTransparentGifFrames(frames: Array<{ rgba: Uint8ClampedArray; width: number; height: number }>) {
  const alphaThreshold = 96;

  return frames.map((frame) => {
    const rgba = new Uint8ClampedArray(frame.rgba.length);

    for (let offset = 0; offset < frame.rgba.length; offset += 4) {
      const alpha = frame.rgba[offset + 3];
      if (alpha < alphaThreshold) {
        rgba[offset] = 0;
        rgba[offset + 1] = 0;
        rgba[offset + 2] = 0;
        rgba[offset + 3] = 0;
      } else {
        rgba[offset] = frame.rgba[offset];
        rgba[offset + 1] = frame.rgba[offset + 1];
        rgba[offset + 2] = frame.rgba[offset + 2];
        rgba[offset + 3] = 255;
      }
    }

    return {
      rgba,
      width: frame.width,
      height: frame.height,
    };
  });
}

function stabilizeDarkGifColors(frames: Array<{ rgba: Uint8ClampedArray; width: number; height: number }>) {
  return frames.map((frame) => {
    const rgba = new Uint8ClampedArray(frame.rgba);

    for (let offset = 0; offset < rgba.length; offset += 4) {
      if (rgba[offset + 3] === 0) continue;

      const r = rgba[offset];
      const g = rgba[offset + 1];
      const b = rgba[offset + 2];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const chroma = max - min;

      if (luma < 92 || (max < 130 && chroma < 48)) {
        const step = luma < 36 ? 12 : 18;
        rgba[offset] = snapChannel(r, step);
        rgba[offset + 1] = snapChannel(g, step);
        rgba[offset + 2] = snapChannel(b, step);
      }
    }

    return {
      rgba,
      width: frame.width,
      height: frame.height,
    };
  });
}

function stabilizeTemporalDarkPixels(frames: Array<{ rgba: Uint8ClampedArray; width: number; height: number }>) {
  if (frames.length < 2) return frames;

  const stabilized = [frames[0]];
  for (let frameIndex = 1; frameIndex < frames.length; frameIndex += 1) {
    const previous = stabilized[frameIndex - 1];
    const current = frames[frameIndex];
    const rgba = new Uint8ClampedArray(current.rgba);

    for (let offset = 0; offset < rgba.length; offset += 4) {
      if (rgba[offset + 3] < 240 || previous.rgba[offset + 3] < 240) continue;

      const r = rgba[offset];
      const g = rgba[offset + 1];
      const b = rgba[offset + 2];
      const pr = previous.rgba[offset];
      const pg = previous.rgba[offset + 1];
      const pb = previous.rgba[offset + 2];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const prevLuma = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
      if (luma >= 120 && prevLuma >= 120) continue;

      const distance = Math.abs(r - pr) + Math.abs(g - pg) + Math.abs(b - pb);
      if (distance > 0 && distance <= 54) {
        rgba[offset] = pr;
        rgba[offset + 1] = pg;
        rgba[offset + 2] = pb;
      }
    }

    stabilized.push({
      rgba,
      width: current.width,
      height: current.height,
    });
  }

  return stabilized;
}

function stabilizeLightGifColors(frames: Array<{ rgba: Uint8ClampedArray; width: number; height: number }>) {
  return frames.map((frame) => {
    const rgba = new Uint8ClampedArray(frame.rgba);

    for (let offset = 0; offset < rgba.length; offset += 4) {
      if (rgba[offset + 3] === 0) continue;

      const r = rgba[offset];
      const g = rgba[offset + 1];
      const b = rgba[offset + 2];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);

      if (luma > 172 && chroma < 76) {
        const step = luma > 226 ? 10 : 14;
        rgba[offset] = snapChannel(r, step);
        rgba[offset + 1] = snapChannel(g, step);
        rgba[offset + 2] = snapChannel(b, step);
      }
    }

    return {
      rgba,
      width: frame.width,
      height: frame.height,
    };
  });
}

function stabilizeTemporalLightPixels(frames: Array<{ rgba: Uint8ClampedArray; width: number; height: number }>) {
  if (frames.length < 2) return frames;

  const stabilized = [frames[0]];
  for (let frameIndex = 1; frameIndex < frames.length; frameIndex += 1) {
    const previous = stabilized[frameIndex - 1];
    const current = frames[frameIndex];
    const rgba = new Uint8ClampedArray(current.rgba);

    for (let offset = 0; offset < rgba.length; offset += 4) {
      if (rgba[offset + 3] < 240 || previous.rgba[offset + 3] < 240) continue;

      const r = rgba[offset];
      const g = rgba[offset + 1];
      const b = rgba[offset + 2];
      const pr = previous.rgba[offset];
      const pg = previous.rgba[offset + 1];
      const pb = previous.rgba[offset + 2];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const prevLuma = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const prevChroma = Math.max(pr, pg, pb) - Math.min(pr, pg, pb);
      if (luma <= 172 || prevLuma <= 172 || chroma >= 86 || prevChroma >= 86) continue;

      const distance = Math.abs(r - pr) + Math.abs(g - pg) + Math.abs(b - pb);
      if (distance > 0 && distance <= 60) {
        rgba[offset] = pr;
        rgba[offset + 1] = pg;
        rgba[offset + 2] = pb;
      }
    }

    stabilized.push({
      rgba,
      width: current.width,
      height: current.height,
    });
  }

  return stabilized;
}

function snapChannel(value: number, step: number) {
  return clamp(Math.round(value / step) * step, 0, 255);
}

function captureSpineTransform(spine: SpineDisplay) {
  return {
    scaleX: spine.scale.x,
    scaleY: spine.scale.y,
    x: spine.position.x,
    y: spine.position.y,
    pivotX: spine.pivot.x,
    pivotY: spine.pivot.y,
    skewX: spine.skew.x,
    skewY: spine.skew.y,
    rotation: spine.rotation,
  };
}

function restoreSpineTransform(spine: SpineDisplay, transform: ReturnType<typeof captureSpineTransform>) {
  spine.scale.set(transform.scaleX, transform.scaleY);
  spine.position.set(transform.x, transform.y);
  spine.pivot.set(transform.pivotX, transform.pivotY);
  spine.skew.set(transform.skewX, transform.skewY);
  spine.rotation = transform.rotation;
}

function buildSharedGifPalette(frames: Array<{ rgba: Uint8ClampedArray }>, transparent: boolean): GifPalette {
  const totalPixels = frames.reduce((sum, frame) => sum + frame.rgba.length / 4, 0);
  const maxSamplePixels = 1000000;
  const stride = Math.max(1, Math.ceil(totalPixels / maxSamplePixels));
  const sample = new Uint8Array(Math.ceil(totalPixels / stride) * 4);
  let writeOffset = 0;
  let pixelIndex = 0;

  for (const frame of frames) {
    const rgba = frame.rgba;
    for (let offset = 0; offset < rgba.length; offset += 4) {
      if (rgba[offset + 3] > 0 && pixelIndex % stride === 0) {
        sample[writeOffset] = rgba[offset];
        sample[writeOffset + 1] = rgba[offset + 1];
        sample[writeOffset + 2] = rgba[offset + 2];
        sample[writeOffset + 3] = rgba[offset + 3];
        writeOffset += 4;
      }
      pixelIndex += 1;
    }
  }

  if (transparent) {
    const palette = writeOffset > 0 ? quantize(sample.subarray(0, writeOffset), 255) : [];
    return [[255, 0, 255], ...palette];
  }

  return quantize(sample.subarray(0, writeOffset), 256);
}

function applyTransparentGifIndex(
  index: Uint8Array,
  rgba: Uint8ClampedArray,
  palette: GifPalette,
  transparentIndex: number
) {
  for (let pixel = 0, offset = 0; offset < rgba.length; pixel += 1, offset += 4) {
    if (rgba[offset + 3] < 96) {
      index[pixel] = transparentIndex;
    } else if (index[pixel] === transparentIndex) {
      index[pixel] = nearestOpaquePaletteIndex(rgba[offset], rgba[offset + 1], rgba[offset + 2], palette, transparentIndex);
    }
  }
}

function nearestOpaquePaletteIndex(r: number, g: number, b: number, palette: GifPalette, transparentIndex: number) {
  let bestIndex = transparentIndex === 0 ? 1 : 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < palette.length; index += 1) {
    if (index === transparentIndex) continue;
    const color = palette[index];
    const dr = r - color[0];
    const dg = g - color[1];
    const db = b - color[2];
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function getAnimationDurationSeconds(pose: LoadedPose, animationName: string) {
  const animation = pose.data.animations.find((item) => item.name === animationName) as { duration?: number } | undefined;
  return animation?.duration && Number.isFinite(animation.duration) ? animation.duration : 3.3;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function fileBaseName(name: string) {
  return normalizeName(name).replace(/\.(skel|json)$/i, "") || "spine";
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName.replace(/[<>:"/\\|?*]+/g, "_");
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function hasFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function showDropOverlay(event: DragEvent) {
  event.preventDefault();
  event.stopPropagation();
  if (!hasFiles(event)) return;
  dropOverlay.classList.add("visible");
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function hideDropOverlay(event?: DragEvent) {
  event?.preventDefault();
  event?.stopPropagation();
  dropOverlay.classList.remove("visible");
}

function handleDrop(event: DragEvent) {
  event.preventDefault();
  event.stopPropagation();
  hideDropOverlay();
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length) loadSpine(files).catch((error) => setStatus(String(error)));
}

for (const target of [window, document, appShell, viewerFrame, app.view as HTMLCanvasElement]) {
  target.addEventListener("dragenter", showDropOverlay as EventListener, true);
  target.addEventListener("dragover", showDropOverlay as EventListener, true);
  target.addEventListener("dragleave", hideDropOverlay as EventListener, true);
  target.addEventListener("drop", handleDrop as EventListener, true);
}
