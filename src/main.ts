import "./style.css";
import * as PIXI from "pixi.js";
import { BaseTexture, MIPMAP_MODES, SCALE_MODES, Texture } from "pixi.js";
import { TextureAtlas } from "@pixi-spine/base";
import { AtlasAttachmentLoader, SkeletonData, SkeletonJson, Spine } from "@pixi-spine/runtime-3.7";
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
const zoomRange = document.getElementById("zoomRange") as HTMLInputElement;
const fitButton = document.getElementById("fitButton") as HTMLButtonElement;

PIXI.settings.SCALE_MODE = SCALE_MODES.LINEAR;
PIXI.settings.MIPMAP_TEXTURES = MIPMAP_MODES.ON;

const app = new PIXI.Application({
  resizeTo: viewerFrame,
  backgroundColor: 0x111111,
  antialias: true,
  autoDensity: true,
  resolution: Math.min(window.devicePixelRatio || 1, 3),
});
viewerFrame.appendChild(app.view as HTMLCanvasElement);

let active: LoadedSpine | null = null;
let playing = false;
let trackLoaded = false;
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
  poseSelect.disabled = !hasPose || (active?.poses.length ?? 0) < 2;
  skinSelect.disabled = !hasPose || (pose?.data.skins.length ?? 0) < 2;
  animationSelect.disabled = !hasPose || (pose?.data.animations.length ?? 0) === 0;
  playButton.disabled = animationSelect.disabled;
  stopButton.disabled = animationSelect.disabled;
  speedRange.disabled = animationSelect.disabled;
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
