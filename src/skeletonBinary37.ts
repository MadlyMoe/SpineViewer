import {
  AttachmentType,
  BinaryInput,
  Color,
  PositionMode,
  RotateMode,
  TextureAtlas,
  TransformMode,
} from "@pixi-spine/base";
import {
  Animation,
  AtlasAttachmentLoader,
  AttachmentTimeline,
  BoneData,
  ColorTimeline,
  CurveTimeline,
  DeformTimeline,
  DrawOrderTimeline,
  Event,
  EventData,
  EventTimeline,
  IkConstraintData,
  IkConstraintTimeline,
  PathConstraintMixTimeline,
  PathConstraintPositionTimeline,
  PathConstraintSpacingTimeline,
  PathConstraintData,
  RotateTimeline,
  ScaleTimeline,
  SkeletonData,
  ShearTimeline,
  Skin,
  SlotData,
  SpacingMode,
  TransformConstraintData,
  TransformConstraintTimeline,
  TranslateTimeline,
  TwoColorTimeline,
} from "@pixi-spine/runtime-3.7";
import { BLEND_MODES } from "pixi.js";

type AttachmentLoader = InstanceType<typeof AtlasAttachmentLoader>;
type BinaryAttachment = NonNullable<ReturnType<AttachmentLoader["newRegionAttachment"]>> | NonNullable<ReturnType<AttachmentLoader["newMeshAttachment"]>> | NonNullable<ReturnType<AttachmentLoader["newBoundingBoxAttachment"]>> | NonNullable<ReturnType<AttachmentLoader["newPathAttachment"]>> | NonNullable<ReturnType<AttachmentLoader["newPointAttachment"]>> | NonNullable<ReturnType<AttachmentLoader["newClippingAttachment"]>>;
type LinkedMesh = {
  mesh: ReturnType<AttachmentLoader["newMeshAttachment"]>;
  skinName: string | null;
  slotIndex: number;
  parent: string;
};

const ATTACHMENT_TYPES = [
  AttachmentType.Region,
  AttachmentType.BoundingBox,
  AttachmentType.Mesh,
  AttachmentType.LinkedMesh,
  AttachmentType.Path,
  AttachmentType.Point,
  AttachmentType.Clipping,
];
const BLEND_MODE_VALUES = [BLEND_MODES.NORMAL, BLEND_MODES.ADD, BLEND_MODES.MULTIPLY, BLEND_MODES.SCREEN];
const POSITION_MODE_VALUES = [PositionMode.Fixed, PositionMode.Percent];
const SPACING_MODE_VALUES = [SpacingMode.Length, SpacingMode.Fixed, SpacingMode.Percent];
const ROTATE_MODE_VALUES = [RotateMode.Tangent, RotateMode.Chain, RotateMode.ChainScale];
const TRANSFORM_MODE_VALUES = [
  TransformMode.Normal,
  TransformMode.OnlyTranslation,
  TransformMode.NoRotationOrReflection,
  TransformMode.NoScale,
  TransformMode.NoScaleOrReflection,
];
const BONE_ROTATE = 0;
const BONE_TRANSLATE = 1;
const BONE_SCALE = 2;
const BONE_SHEAR = 3;
const SLOT_ATTACHMENT = 0;
const SLOT_COLOR = 1;
const SLOT_TWO_COLOR = 2;
const PATH_POSITION = 0;
const PATH_SPACING = 1;
const PATH_MIX = 2;
const CURVE_STEPPED = 1;
const CURVE_BEZIER = 2;

export class SkeletonBinary37 {
  scale = 1;
  private attachmentLoader: AttachmentLoader;
  private linkedMeshes: LinkedMesh[] = [];

  constructor(atlas: TextureAtlas) {
    this.attachmentLoader = new AtlasAttachmentLoader(atlas);
  }

  readSkeletonData(binary: Uint8Array) {
    const input = new BinaryInput(binary);
    const skeletonData = new SkeletonData();
    const scale = this.scale;

    skeletonData.hash = input.readString() || "";
    skeletonData.version = input.readString() || "";
    skeletonData.width = input.readFloat();
    skeletonData.height = input.readFloat();

    const nonessential = input.readBoolean();
    if (nonessential) {
      skeletonData.fps = input.readFloat();
      skeletonData.imagesPath = input.readString() || "";
      input.readString();
    }

    for (let i = 0, n = input.readInt(true); i < n; i++) {
      const name = input.readString();
      if (!name) throw new Error("Bone name missing.");
      const parent = i === 0 ? null : skeletonData.bones[input.readInt(true)];
      const data = new BoneData(i, name, parent as BoneData);
      data.rotation = input.readFloat();
      data.x = input.readFloat() * scale;
      data.y = input.readFloat() * scale;
      data.scaleX = input.readFloat();
      data.scaleY = input.readFloat();
      data.shearX = input.readFloat();
      data.shearY = input.readFloat();
      data.length = input.readFloat() * scale;
      data.transformMode = TRANSFORM_MODE_VALUES[input.readInt(true)];
      if (nonessential) {
        const color = input.readInt32();
        const target = (data as unknown as { color?: Color }).color;
        if (target) Color.rgba8888ToColor(target, color);
      }
      skeletonData.bones.push(data);
    }

    for (let i = 0, n = input.readInt(true); i < n; i++) {
      const slotName = input.readString();
      if (!slotName) throw new Error("Slot name missing.");
      const boneData = skeletonData.bones[input.readInt(true)];
      const data = new SlotData(i, slotName, boneData);
      Color.rgba8888ToColor(data.color, input.readInt32());
      const darkColor = input.readInt32();
      if (darkColor !== -1) {
        data.darkColor = new Color();
        Color.rgb888ToColor(data.darkColor, darkColor);
      }
      data.attachmentName = input.readString() || "";
      data.blendMode = BLEND_MODE_VALUES[input.readInt(true)];
      skeletonData.slots.push(data);
    }

    this.readIkConstraints(input, skeletonData);
    this.readTransformConstraints(input, skeletonData);
    this.readPathConstraints(input, skeletonData);

    const defaultSkin = this.readSkin(input, skeletonData, "default", nonessential);
    if (defaultSkin) {
      skeletonData.defaultSkin = defaultSkin;
      skeletonData.skins.push(defaultSkin);
    }

    for (let i = 0, n = input.readInt(true); i < n; i++) {
      const skinName = input.readString();
      if (!skinName) throw new Error("Skin name missing.");
      const skin = this.readSkin(input, skeletonData, skinName, nonessential);
      if (skin) skeletonData.skins.push(skin);
    }

    for (const linkedMesh of this.linkedMeshes) {
      const skin = linkedMesh.skinName ? skeletonData.findSkin(linkedMesh.skinName) : skeletonData.defaultSkin;
      if (!skin) throw new Error(`Skin not found: ${linkedMesh.skinName}`);
      const parent = skin.getAttachment(linkedMesh.slotIndex, linkedMesh.parent);
      if (!parent) throw new Error(`Parent mesh not found: ${linkedMesh.parent}`);
      linkedMesh.mesh.setParentMesh(parent as typeof linkedMesh.mesh);
    }
    this.linkedMeshes = [];

    for (let i = 0, n = input.readInt(true); i < n; i++) {
      const name = input.readString();
      if (!name) throw new Error("Event name missing.");
      const data = new EventData(name);
      data.intValue = input.readInt(false);
      data.floatValue = input.readFloat();
      data.stringValue = input.readString() || "";
      const audioPath = input.readString();
      data.audioPath = audioPath as string;
      if (audioPath !== null) {
        data.volume = input.readFloat();
        data.balance = input.readFloat();
      }
      skeletonData.events.push(data);
    }

    for (let i = 0, n = input.readInt(true); i < n; i++) {
      const name = input.readString();
      if (!name) throw new Error("Animation name missing.");
      this.readAnimation(input, name, skeletonData);
    }

    (skeletonData as unknown as { binaryAnimationsParsed: boolean }).binaryAnimationsParsed = true;
    return skeletonData;
  }

  private readIkConstraints(input: BinaryInput, skeletonData: SkeletonData) {
    for (let i = 0, n = input.readInt(true); i < n; i++) {
      const name = input.readString();
      if (!name) throw new Error("IK constraint name missing.");
      const data = new IkConstraintData(name);
      data.order = input.readInt(true);
      for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) data.bones.push(skeletonData.bones[input.readInt(true)]);
      data.target = skeletonData.bones[input.readInt(true)];
      data.mix = input.readFloat();
      data.bendDirection = input.readByte();
      data.compress = input.readBoolean();
      data.stretch = input.readBoolean();
      data.uniform = input.readBoolean();
      skeletonData.ikConstraints.push(data);
    }
  }

  private readTransformConstraints(input: BinaryInput, skeletonData: SkeletonData) {
    const scale = this.scale;
    for (let i = 0, n = input.readInt(true); i < n; i++) {
      const name = input.readString();
      if (!name) throw new Error("Transform constraint name missing.");
      const data = new TransformConstraintData(name);
      data.order = input.readInt(true);
      for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) data.bones.push(skeletonData.bones[input.readInt(true)]);
      data.target = skeletonData.bones[input.readInt(true)];
      data.local = input.readBoolean();
      data.relative = input.readBoolean();
      data.offsetRotation = input.readFloat();
      data.offsetX = input.readFloat() * scale;
      data.offsetY = input.readFloat() * scale;
      data.offsetScaleX = input.readFloat();
      data.offsetScaleY = input.readFloat();
      data.offsetShearY = input.readFloat();
      data.rotateMix = input.readFloat();
      data.translateMix = input.readFloat();
      data.scaleMix = input.readFloat();
      data.shearMix = input.readFloat();
      skeletonData.transformConstraints.push(data);
    }
  }

  private readPathConstraints(input: BinaryInput, skeletonData: SkeletonData) {
    const scale = this.scale;
    for (let i = 0, n = input.readInt(true); i < n; i++) {
      const name = input.readString();
      if (!name) throw new Error("Path constraint name missing.");
      const data = new PathConstraintData(name);
      data.order = input.readInt(true);
      for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) data.bones.push(skeletonData.bones[input.readInt(true)]);
      data.target = skeletonData.slots[input.readInt(true)];
      data.positionMode = POSITION_MODE_VALUES[input.readInt(true)];
      data.spacingMode = SPACING_MODE_VALUES[input.readInt(true)];
      data.rotateMode = ROTATE_MODE_VALUES[input.readInt(true)];
      data.offsetRotation = input.readFloat();
      data.position = input.readFloat();
      if (data.positionMode === PositionMode.Fixed) data.position *= scale;
      data.spacing = input.readFloat();
      if (data.spacingMode === SpacingMode.Length || data.spacingMode === SpacingMode.Fixed) data.spacing *= scale;
      data.rotateMix = input.readFloat();
      data.translateMix = input.readFloat();
      skeletonData.pathConstraints.push(data);
    }
  }

  private readSkin(input: BinaryInput, skeletonData: SkeletonData, skinName: string, nonessential: boolean) {
    const slotCount = input.readInt(true);
    if (slotCount === 0) return null;

    const skin = new Skin(skinName);
    for (let i = 0; i < slotCount; i++) {
      const slotIndex = input.readInt(true);
      for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) {
        const name = input.readString();
        if (!name) throw new Error("Attachment name missing.");
        const attachment = this.readAttachment(input, skeletonData, skin, slotIndex, name, nonessential);
        if (attachment) skin.addAttachment(slotIndex, name, attachment);
      }
    }
    return skin;
  }

  private readAttachment(
    input: BinaryInput,
    skeletonData: SkeletonData,
    skin: Skin,
    slotIndex: number,
    attachmentName: string,
    nonessential: boolean
  ): BinaryAttachment | null {
    const scale = this.scale;
    let name = input.readString() || attachmentName;
    const type = ATTACHMENT_TYPES[input.readByte()];

    if (type === AttachmentType.Region) {
      let path = input.readString() || name;
      const rotation = input.readFloat();
      const x = input.readFloat();
      const y = input.readFloat();
      const scaleX = input.readFloat();
      const scaleY = input.readFloat();
      const width = input.readFloat();
      const height = input.readFloat();
      const color = input.readInt32();
      const region = this.attachmentLoader.newRegionAttachment(skin, name, path);
      if (!region) return null;
      region.path = path;
      region.setRegion(region.region);
      region.x = x * scale;
      region.y = y * scale;
      region.scaleX = scaleX;
      region.scaleY = scaleY;
      region.rotation = rotation;
      region.width = width * scale;
      region.height = height * scale;
      Color.rgba8888ToColor(region.color, color);
      region.updateOffset();
      return region;
    }

    if (type === AttachmentType.BoundingBox) {
      const vertexCount = input.readInt(true);
      const vertices = this.readVertices(input, vertexCount);
      const color = nonessential ? input.readInt32() : 0;
      const box = this.attachmentLoader.newBoundingBoxAttachment(skin, name);
      if (!box) return null;
      box.worldVerticesLength = vertexCount << 1;
      box.vertices = vertices.vertices;
      box.bones = vertices.bones as number[];
      if (nonessential) Color.rgba8888ToColor(box.color, color);
      return box;
    }

    if (type === AttachmentType.Mesh) {
      let path = input.readString() || name;
      const color = input.readInt32();
      const vertexCount = input.readInt(true);
      const uvs = this.readFloatArray(input, vertexCount << 1, 1);
      const triangles = this.readShortArray(input);
      const vertices = this.readVertices(input, vertexCount);
      const hullLength = input.readInt(true);
      let edges: number[] | null = null;
      let width = 0;
      let height = 0;
      if (nonessential) {
        edges = this.readShortArray(input);
        width = input.readFloat();
        height = input.readFloat();
      }
      const mesh = this.attachmentLoader.newMeshAttachment(skin, name, path);
      if (!mesh) return null;
      mesh.path = path;
      Color.rgba8888ToColor(mesh.color, color);
      mesh.bones = vertices.bones as number[];
      mesh.vertices = vertices.vertices;
      mesh.worldVerticesLength = vertexCount << 1;
      mesh.triangles = triangles;
      mesh.regionUVs = new Float32Array(uvs);
      mesh.hullLength = hullLength << 1;
      if (nonessential) {
        (mesh as unknown as { edges: number[] | null }).edges = edges;
        (mesh as unknown as { width: number; height: number }).width = width * scale;
        (mesh as unknown as { width: number; height: number }).height = height * scale;
      }
      return mesh;
    }

    if (type === AttachmentType.LinkedMesh) {
      let path = input.readString() || name;
      const color = input.readInt32();
      const skinName = input.readString();
      const parent = input.readString();
      const inheritDeform = input.readBoolean();
      let width = 0;
      let height = 0;
      if (nonessential) {
        width = input.readFloat();
        height = input.readFloat();
      }
      if (!parent) throw new Error("Linked mesh parent missing.");
      const mesh = this.attachmentLoader.newMeshAttachment(skin, name, path);
      if (!mesh) return null;
      mesh.path = path;
      Color.rgba8888ToColor(mesh.color, color);
      mesh.inheritDeform = inheritDeform;
      if (nonessential) {
        (mesh as unknown as { width: number; height: number }).width = width * scale;
        (mesh as unknown as { width: number; height: number }).height = height * scale;
      }
      this.linkedMeshes.push({ mesh, skinName, slotIndex, parent });
      return mesh;
    }

    if (type === AttachmentType.Path) {
      const closed = input.readBoolean();
      const constantSpeed = input.readBoolean();
      const vertexCount = input.readInt(true);
      const vertices = this.readVertices(input, vertexCount);
      const lengths = Array.from({ length: vertexCount / 3 }, () => input.readFloat() * scale);
      const color = nonessential ? input.readInt32() : 0;
      const path = this.attachmentLoader.newPathAttachment(skin, name);
      if (!path) return null;
      path.closed = closed;
      path.constantSpeed = constantSpeed;
      path.worldVerticesLength = vertexCount << 1;
      path.vertices = vertices.vertices;
      path.bones = vertices.bones as number[];
      path.lengths = lengths;
      if (nonessential) Color.rgba8888ToColor(path.color, color);
      return path;
    }

    if (type === AttachmentType.Point) {
      const rotation = input.readFloat();
      const x = input.readFloat();
      const y = input.readFloat();
      const color = nonessential ? input.readInt32() : 0;
      const point = this.attachmentLoader.newPointAttachment(skin, name);
      if (!point) return null;
      point.x = x * scale;
      point.y = y * scale;
      point.rotation = rotation;
      if (nonessential) Color.rgba8888ToColor(point.color, color);
      return point;
    }

    if (type === AttachmentType.Clipping) {
      const endSlotIndex = input.readInt(true);
      const vertexCount = input.readInt(true);
      const vertices = this.readVertices(input, vertexCount);
      const color = nonessential ? input.readInt32() : 0;
      const clip = this.attachmentLoader.newClippingAttachment(skin, name);
      if (!clip) return null;
      clip.endSlot = skeletonData.slots[endSlotIndex];
      clip.worldVerticesLength = vertexCount << 1;
      clip.vertices = vertices.vertices;
      clip.bones = vertices.bones as number[];
      if (nonessential) Color.rgba8888ToColor(clip.color, color);
      return clip;
    }

    return null;
  }

  private readVertices(input: BinaryInput, vertexCount: number) {
    const verticesLength = vertexCount << 1;
    if (!input.readBoolean()) {
      return { bones: null, vertices: this.readFloatArray(input, verticesLength, this.scale) };
    }

    const weights: number[] = [];
    const bones: number[] = [];
    for (let i = 0; i < vertexCount; i++) {
      const boneCount = input.readInt(true);
      bones.push(boneCount);
      for (let ii = 0; ii < boneCount; ii++) {
        bones.push(input.readInt(true));
        weights.push(input.readFloat() * this.scale);
        weights.push(input.readFloat() * this.scale);
        weights.push(input.readFloat());
      }
    }
    return { bones, vertices: weights };
  }

  private readFloatArray(input: BinaryInput, length: number, scale: number) {
    const values = new Array<number>(length);
    for (let i = 0; i < length; i++) values[i] = input.readFloat() * scale;
    return values;
  }

  private readShortArray(input: BinaryInput) {
    const length = input.readInt(true);
    const values = new Array<number>(length);
    for (let i = 0; i < length; i++) values[i] = input.readShort();
    return values;
  }

  private readAnimation(input: BinaryInput, name: string, skeletonData: SkeletonData) {
    const timelines: unknown[] = [];
    const scale = this.scale;
    let duration = 0;
    const tempColor1 = new Color();
    const tempColor2 = new Color();

    for (let i = 0, n = input.readInt(true); i < n; i++) {
      const slotIndex = input.readInt(true);
      for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) {
        const timelineType = input.readByte();
        const frameCount = input.readInt(true);
        if (timelineType === SLOT_ATTACHMENT) {
          const timeline = new AttachmentTimeline(frameCount);
          timeline.slotIndex = slotIndex;
          for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
            const time = input.readFloat();
            timeline.setFrame(frameIndex, time, input.readString() as never);
            duration = Math.max(duration, time);
          }
          timelines.push(timeline);
        } else if (timelineType === SLOT_COLOR) {
          const timeline = new ColorTimeline(frameCount);
          timeline.slotIndex = slotIndex;
          for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
            const time = input.readFloat();
            Color.rgba8888ToColor(tempColor1, input.readInt32());
            timeline.setFrame(frameIndex, time, tempColor1.r, tempColor1.g, tempColor1.b, tempColor1.a);
            if (frameIndex < frameCount - 1) this.readCurve(input, frameIndex, timeline);
            duration = Math.max(duration, time);
          }
          timelines.push(timeline);
        } else if (timelineType === SLOT_TWO_COLOR) {
          const timeline = new TwoColorTimeline(frameCount);
          timeline.slotIndex = slotIndex;
          for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
            const time = input.readFloat();
            Color.rgba8888ToColor(tempColor1, input.readInt32());
            Color.rgb888ToColor(tempColor2, input.readInt32());
            timeline.setFrame(frameIndex, time, tempColor1.r, tempColor1.g, tempColor1.b, tempColor1.a, tempColor2.r, tempColor2.g, tempColor2.b);
            if (frameIndex < frameCount - 1) this.readCurve(input, frameIndex, timeline);
            duration = Math.max(duration, time);
          }
          timelines.push(timeline);
        }
      }
    }

    for (let i = 0, n = input.readInt(true); i < n; i++) {
      const boneIndex = input.readInt(true);
      for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) {
        const timelineType = input.readByte();
        const frameCount = input.readInt(true);
        if (timelineType === BONE_ROTATE) {
          const timeline = new RotateTimeline(frameCount);
          timeline.boneIndex = boneIndex;
          for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
            const time = input.readFloat();
            timeline.setFrame(frameIndex, time, input.readFloat());
            if (frameIndex < frameCount - 1) this.readCurve(input, frameIndex, timeline);
            duration = Math.max(duration, time);
          }
          timelines.push(timeline);
        } else if (timelineType === BONE_TRANSLATE || timelineType === BONE_SCALE || timelineType === BONE_SHEAR) {
          const timeline =
            timelineType === BONE_SCALE
              ? new ScaleTimeline(frameCount)
              : timelineType === BONE_SHEAR
                ? new ShearTimeline(frameCount)
                : new TranslateTimeline(frameCount);
          const timelineScale = timelineType === BONE_TRANSLATE ? scale : 1;
          timeline.boneIndex = boneIndex;
          for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
            const time = input.readFloat();
            timeline.setFrame(frameIndex, time, input.readFloat() * timelineScale, input.readFloat() * timelineScale);
            if (frameIndex < frameCount - 1) this.readCurve(input, frameIndex, timeline);
            duration = Math.max(duration, time);
          }
          timelines.push(timeline);
        }
      }
    }

    for (let i = 0, n = input.readInt(true); i < n; i++) {
      const index = input.readInt(true);
      const frameCount = input.readInt(true);
      const timeline = new IkConstraintTimeline(frameCount);
      timeline.ikConstraintIndex = index;
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
        const time = input.readFloat();
        timeline.setFrame(frameIndex, time, input.readFloat(), input.readByte(), input.readBoolean(), input.readBoolean());
        if (frameIndex < frameCount - 1) this.readCurve(input, frameIndex, timeline);
        duration = Math.max(duration, time);
      }
      timelines.push(timeline);
    }

    for (let i = 0, n = input.readInt(true); i < n; i++) {
      const index = input.readInt(true);
      const frameCount = input.readInt(true);
      const timeline = new TransformConstraintTimeline(frameCount);
      timeline.transformConstraintIndex = index;
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
        const time = input.readFloat();
        timeline.setFrame(frameIndex, time, input.readFloat(), input.readFloat(), input.readFloat(), input.readFloat());
        if (frameIndex < frameCount - 1) this.readCurve(input, frameIndex, timeline);
        duration = Math.max(duration, time);
      }
      timelines.push(timeline);
    }

    for (let i = 0, n = input.readInt(true); i < n; i++) {
      const index = input.readInt(true);
      const data = skeletonData.pathConstraints[index];
      for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) {
        const timelineType = input.readByte();
        const frameCount = input.readInt(true);
        if (timelineType === PATH_POSITION || timelineType === PATH_SPACING) {
          const timeline =
            timelineType === PATH_SPACING
              ? new PathConstraintSpacingTimeline(frameCount)
              : new PathConstraintPositionTimeline(frameCount);
          let timelineScale = 1;
          if (timelineType === PATH_SPACING && (data.spacingMode === SpacingMode.Length || data.spacingMode === SpacingMode.Fixed)) timelineScale = scale;
          if (timelineType === PATH_POSITION && data.positionMode === PositionMode.Fixed) timelineScale = scale;
          timeline.pathConstraintIndex = index;
          for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
            const time = input.readFloat();
            timeline.setFrame(frameIndex, time, input.readFloat() * timelineScale);
            if (frameIndex < frameCount - 1) this.readCurve(input, frameIndex, timeline);
            duration = Math.max(duration, time);
          }
          timelines.push(timeline);
        } else if (timelineType === PATH_MIX) {
          const timeline = new PathConstraintMixTimeline(frameCount);
          timeline.pathConstraintIndex = index;
          for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
            const time = input.readFloat();
            timeline.setFrame(frameIndex, time, input.readFloat(), input.readFloat());
            if (frameIndex < frameCount - 1) this.readCurve(input, frameIndex, timeline);
            duration = Math.max(duration, time);
          }
          timelines.push(timeline);
        }
      }
    }

    for (let i = 0, n = input.readInt(true); i < n; i++) {
      const skin = skeletonData.skins[input.readInt(true)];
      for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) {
        const slotIndex = input.readInt(true);
        for (let iii = 0, nnn = input.readInt(true); iii < nnn; iii++) {
          const attachmentName = input.readString() || "";
          const attachment = skin.getAttachment(slotIndex, attachmentName) as unknown as { bones?: number[]; vertices: number[] };
          if (!attachment) throw new Error(`Deform attachment not found: ${attachmentName}`);
          const weighted = attachment.bones != null;
          const vertices = attachment.vertices;
          const deformLength = weighted ? Math.floor(vertices.length / 3) * 2 : vertices.length;
          const frameCount = input.readInt(true);
          const timeline = new DeformTimeline(frameCount);
          timeline.slotIndex = slotIndex;
          timeline.attachment = attachment as never;

          for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
            const time = input.readFloat();
            let deform: number[];
            let end = input.readInt(true);
            if (end === 0) {
              deform = weighted ? new Array(deformLength).fill(0) : vertices.slice();
            } else {
              deform = new Array(deformLength).fill(0);
              const start = input.readInt(true);
              end += start;
              for (let v = start; v < end; v++) deform[v] = input.readFloat() * scale;
              if (!weighted) {
                for (let v = 0; v < deform.length; v++) deform[v] += vertices[v];
              }
            }
            timeline.setFrame(frameIndex, time, deform);
            if (frameIndex < frameCount - 1) this.readCurve(input, frameIndex, timeline);
            duration = Math.max(duration, time);
          }
          timelines.push(timeline);
        }
      }
    }

    const drawOrderCount = input.readInt(true);
    if (drawOrderCount > 0) {
      const timeline = new DrawOrderTimeline(drawOrderCount);
      const slotCount = skeletonData.slots.length;
      for (let i = 0; i < drawOrderCount; i++) {
        const time = input.readFloat();
        const offsetCount = input.readInt(true);
        const drawOrder = new Array<number>(slotCount).fill(-1);
        const unchanged = new Array<number>(slotCount - offsetCount);
        let originalIndex = 0;
        let unchangedIndex = 0;
        for (let ii = 0; ii < offsetCount; ii++) {
          const slotIndex = input.readInt(true);
          while (originalIndex !== slotIndex) unchanged[unchangedIndex++] = originalIndex++;
          drawOrder[originalIndex + input.readInt(true)] = originalIndex++;
        }
        while (originalIndex < slotCount) unchanged[unchangedIndex++] = originalIndex++;
        for (let ii = slotCount - 1; ii >= 0; ii--) {
          if (drawOrder[ii] === -1) drawOrder[ii] = unchanged[--unchangedIndex];
        }
        timeline.setFrame(i, time, drawOrder);
        duration = Math.max(duration, time);
      }
      timelines.push(timeline);
    }

    const eventCount = input.readInt(true);
    if (eventCount > 0) {
      const timeline = new EventTimeline(eventCount);
      for (let i = 0; i < eventCount; i++) {
        const time = input.readFloat();
        const eventData = skeletonData.events[input.readInt(true)];
        const event = new Event(time, eventData);
        event.intValue = input.readInt(false);
        event.floatValue = input.readFloat();
        event.stringValue = input.readBoolean() ? input.readString() || "" : eventData.stringValue;
        if (eventData.audioPath !== null) {
          event.volume = input.readFloat();
          event.balance = input.readFloat();
        }
        timeline.setFrame(i, event);
        duration = Math.max(duration, time);
      }
      timelines.push(timeline);
    }

    skeletonData.animations.push(new Animation(name, timelines as never, duration));
  }

  private readCurve(input: BinaryInput, frameIndex: number, timeline: CurveTimeline) {
    const type = input.readByte();
    if (type === CURVE_STEPPED) timeline.setStepped(frameIndex);
    else if (type === CURVE_BEZIER) timeline.setCurve(frameIndex, input.readFloat(), input.readFloat(), input.readFloat(), input.readFloat());
  }
}
