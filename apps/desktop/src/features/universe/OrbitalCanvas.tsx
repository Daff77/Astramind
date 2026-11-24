import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Pin } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { LabelDensity, UniverseSettings } from "../../lib/contracts";
import {
  CLUSTER_PALETTE,
  CLUSTER_PALETTE_LIGHT,
  DEFAULT_UNIVERSE_SETTINGS,
  type GraphEdgeModel,
  type GraphNodeModel,
} from "./graphModel";
import type { SemanticZoomLevel } from "./GalaxyCanvas";
import type { Vec3 } from "./layout3d";
import {
  createOrbitalLayout,
  evaluateOrbitalPosition,
  getOrbitalFolderKey,
  type OrbitalLayoutResult,
  type OrbitalSystemNode,
} from "./orbitalLayout";

export interface OrbitalCanvasHandle {
  resetCamera: () => void;
  fitAll: () => void;
  focusNode: (nodeId: string) => void;
  focusSystem: (systemKey: string) => void;
  focusParentSystem: () => void;
}

interface OrbitalCanvasProps {
  vaultId: string;
  vaultName: string;
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
  selectedNodeId: string | null;
  focusedSystemKey: string | null;
  searchQuery?: string;
  settings?: UniverseSettings;
  isDarkTheme: boolean;
  reducedMotion: boolean;
  onSelectNode: (nodeId: string | null) => void;
  onFocusSystemKey?: (systemKey: string | null) => void;
  onZoomLevelChange?: (level: SemanticZoomLevel) => void;
  onWebGlUnavailable: (reason: string) => void;
}

export interface OrbitalOverlayLabel {
  id: string;
  title: string;
  kind: "planet" | "system" | "core";
  x: number;
  y: number;
  isSelected: boolean;
  isHovered: boolean;
  isNeighbor: boolean;
  isMatched: boolean;
  isPinned: boolean;
  color: string;
  count?: number;
  alignLeft?: boolean;
}

const VAULT_CORE_VERTEX = `
  varying vec3 vNormalWorld;
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;

  void main() {
    vLocalPos = normal;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormalWorld = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const VAULT_CORE_FRAGMENT = `
  uniform float uLightMode;
  uniform float uReducedEffects;

  varying vec3 vNormalWorld;
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;

  void main() {
    vec3 N = normalize(vNormalWorld);
    vec3 V = normalize(cameraPosition - vWorldPos);
    float face = max(dot(N, V), 0.0);
    float granules = sin(dot(vLocalPos, vec3(53.0, 21.0, 37.0)))
      * sin(dot(vLocalPos, vec3(17.0, -59.0, 43.0)));
    float current = sin(dot(vLocalPos, vec3(8.0, 14.0, 5.0))
      + 2.4 * sin(dot(vLocalPos, vec3(13.0, -5.0, 10.0))));
    float heat = 0.35 + face * 0.35
      + (current * 0.13 + granules * 0.045) * (1.0 - uReducedEffects);
    vec3 copper = vec3(0.42, 0.105, 0.020);
    vec3 gold = vec3(1.0, 0.68, 0.30);
    vec3 surface = mix(copper, gold, clamp(heat, 0.0, 1.0));
    float limb = pow(1.0 - face, 5.0);
    surface += vec3(0.20, 0.060, 0.008) * limb * (1.0 - uLightMode);
    gl_FragColor = vec4(surface, 1.0);
    #include <colorspace_fragment>
  }
`;

const PLANET_VERTEX = `
  attribute vec3 aColor;
  attribute float aSeed;
  attribute float aState;

  varying vec3 vColor;
  varying float vSeed;
  varying float vState;
  varying vec3 vWorldPos;
  varying vec3 vNormalWorld;
  varying vec3 vLocalPos;

  void main() {
    vColor = aColor;
    vSeed = aSeed;
    vState = aState;
    vLocalPos = position;

    vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vNormalWorld = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);

    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const PLANET_FRAGMENT = `
  uniform float uLightMode;
  uniform float uReducedEffects;

  varying vec3 vColor;
  varying float vSeed;
  varying float vState;
  varying vec3 vWorldPos;
  varying vec3 vNormalWorld;
  varying vec3 vLocalPos;

  void main() {
    vec3 N = normalize(vNormalWorld);
    vec3 V = normalize(cameraPosition - vWorldPos);
    // Heliocentric light emanates softly from the central Vault Core at (0, 0, 0).
    float radialLen = length(vWorldPos);
    vec3 L = radialLen > 0.001 ? normalize(-vWorldPos) : normalize(vec3(0.3, 0.8, 0.5));

    float facingSun = dot(N, L);
    float diffuse = max(facingSun, 0.0);
    float terminator = smoothstep(-0.18, 0.58, facingSun);
    vec3 surface = vColor;
    float ambient = mix(0.18, 0.31, uLightMode);

    if (uReducedEffects < 0.5) {
      float warp = sin(dot(vLocalPos.xyz, vec3(6.0, 3.0, 8.0)) + vSeed * 9.0);
      float band = sin(vLocalPos.y * (9.0 + vSeed * 8.0) + warp * 0.66);
      float finer = sin(dot(vLocalPos, vec3(21.0, -12.0, 19.0)) + warp);
      surface *= 0.95 + 0.11 * band + 0.042 * finer;
    }

    vec3 shaded = surface * ambient + surface * vec3(1.0, 0.88, 0.71)
      * (diffuse * 0.62 + terminator * 0.18);
    if (uReducedEffects < 0.5) {
      float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.5);
      shaded += mix(surface, vec3(0.37, 0.44, 0.54), 0.4)
        * fresnel * (0.035 + terminator * 0.15);
    }
    if (vState > 1.45) {
      shaded = mix(shaded, vec3(0.71, 0.65, 0.53), 0.16);
    } else if (vState < 0.35) {
      vec3 bgMix = mix(vec3(0.005, 0.007, 0.012), vec3(0.55, 0.60, 0.66), uLightMode);
      shaded = mix(shaded, bgMix, 0.52);
    }

    float alpha = vState < 0.35 ? 0.58 : 1.0;
    gl_FragColor = vec4(shaded, alpha);
    #include <colorspace_fragment>
  }
`;

const HALO_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CORE_GLOW_FRAGMENT = `
  varying vec2 vUv;
  void main() {
    float radius = length(vUv - 0.5) * 2.0;
    float intensity = exp(-radius * 6.0) * (1.0 - smoothstep(0.54, 1.0, radius));
    gl_FragColor = vec4(0.93, 0.52, 0.18, intensity * 0.44);
  }
`;

const HALO_FRAGMENT = `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;

  void main() {
    vec2 p = vUv - vec2(0.5);
    float d = length(p) * 2.0;
    if (d > 1.0) discard;
    float halo = exp(-d * d * 4.8) * (1.0 - smoothstep(0.7, 1.0, d));
    float ring = smoothstep(0.56, 0.61, d) * (1.0 - smoothstep(0.64, 0.69, d)) * 0.85;
    float alpha = clamp((halo * 0.65 + ring) * uOpacity, 0.0, 1.0);
    gl_FragColor = vec4(uColor, alpha);
  }
`;

const LABEL_BUDGET: Record<LabelDensity, number> = {
  low: 10,
  medium: 22,
  high: 34,
};

function deterministicHashUnit(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

function tintPlanetColor(
  nodeId: string,
  baseHex: string,
  target: THREE.Color,
) {
  const unit = deterministicHashUnit(nodeId) - 0.5;
  target.set(baseHex);
  target.offsetHSL(unit * 0.05, -0.17 + unit * 0.10, unit * 0.10);
}

function buildOrbitalStarfield(isDarkTheme: boolean): THREE.Points {
  const count = 600;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color();

  for (let i = 0; i < count; i += 1) {
    const t = (i + 0.5) / count;
    const phi = Math.acos(1 - 2 * t);
    const theta = i * 2.399963229728653;
    const r = 950 + ((i * 211) % 680);
    positions[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
    positions[i * 3 + 1] = Math.cos(phi) * r * 0.78;
    positions[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r;

    if (isDarkTheme) {
      c.setHSL(0.58 + (i % 5) * 0.02, 0.26, 0.58 + (i % 3) * 0.1);
    } else {
      c.setHSL(0.6, 0.2, 0.52);
    }
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size: isDarkTheme ? 1.65 : 1.4,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: isDarkTheme ? 0.3 : 0.18,
    depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.name = "orbital-decorative-starfield";
  pts.frustumCulled = false;
  return pts;
}

interface ScreenBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function boxesOverlap(a: ScreenBox, b: ScreenBox, pad: number): boolean {
  return !(
    a.right + pad < b.left ||
    a.left - pad > b.right ||
    a.bottom + pad < b.top ||
    a.top - pad > b.bottom
  );
}

export interface OrbitalLabelParams {
  nodes: GraphNodeModel[];
  systems: OrbitalSystemNode[];
  positions: Map<string, Vec3>;
  camera: THREE.Camera;
  width: number;
  height: number;
  cameraDistance: number;
  boundingRadius: number;
  coreRadius?: number;
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  focusedSystemKey: string | null;
  neighborIds: Set<string>;
  searchQuery: string;
  labelDensity: LabelDensity;
  isDarkTheme: boolean;
}

/**
 * Pure semantic zoom + screen-space AABB collision-free label placement for Orbital mode.
 * Prioritizes selected, hovered, search matches, neighbors, pinned notes, and hierarchical systems.
 */
export function computeOrbitalLabels(params: OrbitalLabelParams): {
  zoomLevel: SemanticZoomLevel;
  labels: OrbitalOverlayLabel[];
} {
  const {
    nodes,
    systems,
    positions,
    camera,
    width,
    height,
    cameraDistance,
    boundingRadius,
    coreRadius = 0,
    selectedNodeId,
    hoveredNodeId,
    focusedSystemKey,
    neighborIds,
    searchQuery,
    labelDensity,
    isDarkTheme,
  } = params;

  const safeRadius = Math.max(boundingRadius, 40);
  const ratio = cameraDistance / safeRadius;
  const zoomLevel: SemanticZoomLevel = selectedNodeId
    ? 4
    : ratio <= 0.72
      ? 3
      : focusedSystemKey || ratio <= 1.38
        ? 2
        : 1;

  if (width <= 0 || height <= 0) {
    return { zoomLevel, labels: [] };
  }

  const palette = isDarkTheme ? CLUSTER_PALETTE : CLUSTER_PALETTE_LIGHT;
  const q = searchQuery.trim().toLowerCase();
  const maxLabels = LABEL_BUDGET[labelDensity];
  const maxArea = width * height * 0.14;
  const proj = new THREE.Vector3();

  interface Candidate {
    label: OrbitalOverlayLabel;
    priority: number;
    box: ScreenBox;
  }

  const candidates: Candidate[] = [];

  // 1. Central Vault Core & Orbital System Labels (Folders/Subfolders)
  for (const sys of systems) {
    const isCore = sys.depth === 0;
    const isFocusedSys = focusedSystemKey === sys.key;
    if (zoomLevel === 1 && sys.depth > 1 && !isFocusedSys) continue;
    if (zoomLevel === 2 && sys.depth > 2 && !isFocusedSys) continue;
    if (zoomLevel >= 3 && !isCore && !isFocusedSys && sys.depth === 1 && ratio < 0.45) {
      // Allow depth-2/3 sub-orbit names when zoomed deep inside a folder.
      continue;
    }

    proj.set(sys.center.x, sys.center.y, sys.center.z).project(camera);
    if (proj.z < -1 || proj.z > 1) continue;
    const sx = Math.round((proj.x * 0.5 + 0.5) * width);
    const corePixels = coreRadius * camera.projectionMatrix.elements[5]! * height
      / Math.max(2 * camera.position.length(), 1);
    const labelOffset = isCore ? Math.min(64, corePixels + 18) : 0;
    const sy = Math.round((-proj.y * 0.5 + 0.5) * height + labelOffset);
    const w = Math.min(176, Math.max(68, sys.label.length * 8 + 40));
    if (sx - w / 2 < 8 || sx + w / 2 > width - 8 || sy < 56 || sy > height - 56) continue;
    const box: ScreenBox = {
      left: sx - w / 2,
      right: sx + w / 2,
      top: sy - 13,
      bottom: sy + 13,
    };

    let prio = isCore
      ? 720
      : sys.depth === 1
        ? zoomLevel === 1
          ? 640
          : 440
        : sys.depth === 2
          ? zoomLevel === 2
            ? 490
            : 260
          : 220;
    if (isFocusedSys) prio += 180;
    prio += Math.min(60, sys.noteCount * 0.4);

    candidates.push({
      priority: prio,
      box,
      label: {
        id: `sys:${sys.key}`,
        title: sys.label,
        kind: isCore ? "core" : "system",
        x: sx,
        y: sy,
        isSelected: isFocusedSys,
        isHovered: false,
        isNeighbor: false,
        isMatched: false,
        isPinned: false,
        color: isCore
          ? isDarkTheme
            ? "#f5d796"
            : "#9b6b18"
          : (palette[sys.colorIndex % palette.length] ?? "#6fa8f6"),
        count: sys.noteCount,
      },
    });
  }

  // 2. Planet Labels gated by semantic zoom & relevance
  for (const node of nodes) {
    const isSelected = node.id === selectedNodeId;
    const isHovered = node.id === hoveredNodeId;
    const isNeighbor = neighborIds.has(node.id) && !isSelected;
    const isMatched =
      q.length > 0 &&
      (node.title.toLowerCase().includes(q) ||
        node.relPath.toLowerCase().includes(q));

    const isRelevant = isSelected || isHovered || isMatched || isNeighbor;
    if (zoomLevel === 1 && !isRelevant && !node.pinned) continue;
    if (zoomLevel === 2 && !isRelevant && !node.pinned && node.importance < 1.55) continue;
    if (focusedSystemKey && !isRelevant && !node.pinned) {
      const folderKey = getOrbitalFolderKey(node.folderSegments);
      if (folderKey !== focusedSystemKey && !folderKey.startsWith(`${focusedSystemKey}/`)) continue;
    }

    const p = positions.get(node.id);
    if (!p) continue;
    proj.set(p.x, p.y, p.z).project(camera);
    if (proj.z < -1 || proj.z > 1) continue;
    const sx = Math.round((proj.x * 0.5 + 0.5) * width);
    const sy = Math.round((-proj.y * 0.5 + 0.5) * height);
    if (sx < 8 || sx > width - 8 || sy < 56 || sy > height - 56) continue;

    let priority: number;
    if (isSelected) priority = 1000;
    else if (isHovered) priority = 900;
    else if (isMatched) priority = 780 + node.importance * 20;
    else if (isNeighbor) priority = 690 + node.importance * 20;
    else if (node.pinned) priority = 540 + node.importance * 20;
    else if (zoomLevel <= 2) priority = 250 + node.importance * 40;
    else priority = 340 + node.importance * 45 + (1 - proj.z) * 20;

    const textW = Math.min(176, Math.max(48, node.title.length * 8 + (node.pinned ? 40 : 24)));
    const alignLeft = sx + 10 + textW > width - 8;
    if (alignLeft && sx - 10 - textW < 8) continue;
    const box: ScreenBox = {
      left: alignLeft ? sx - 10 - textW : sx + 10,
      right: alignLeft ? sx - 10 : sx + 10 + textW,
      top: sy - 11,
      bottom: sy + 11,
    };

    candidates.push({
      priority,
      box,
      label: {
        id: node.id,
        title: node.title,
        kind: "planet",
        x: sx,
        y: sy,
        isSelected,
        isHovered,
        isNeighbor,
        isMatched,
        isPinned: node.pinned,
        alignLeft,
        color: palette[node.clusterColorIndex % palette.length] ?? "#6fa8f6",
      },
    });
  }

  candidates.sort((a, b) => b.priority - a.priority || a.label.id.localeCompare(b.label.id));

  const accepted: OrbitalOverlayLabel[] = [];
  const placedBoxes: ScreenBox[] = [];
  let usedArea = 0;

  for (const cand of candidates) {
    if (accepted.length >= maxLabels) break;
    const boxArea =
      (cand.box.right - cand.box.left) * (cand.box.bottom - cand.box.top);
    if (!cand.label.isSelected && usedArea + boxArea > maxArea) continue;
    if (placedBoxes.some((existing) => boxesOverlap(cand.box, existing, 8))) continue;

    accepted.push(cand.label);
    placedBoxes.push(cand.box);
    usedArea += boxArea;
  }

  return { zoomLevel, labels: accepted };
}

export const OrbitalCanvas = forwardRef<OrbitalCanvasHandle, OrbitalCanvasProps>(
  function OrbitalCanvas(
    {
      vaultId,
      vaultName,
      nodes,
      edges,
      selectedNodeId,
      focusedSystemKey,
      searchQuery = "",
      settings = DEFAULT_UNIVERSE_SETTINGS,
      isDarkTheme,
      reducedMotion,
      onSelectNode,
      onFocusSystemKey,
      onZoomLevelChange,
      onWebGlUnavailable,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [labels, setLabels] = useState<OrbitalOverlayLabel[]>([]);

    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

    const coreMeshRef = useRef<THREE.Mesh | null>(null);
    const coreGlowRef = useRef<THREE.Mesh | null>(null);
    const planetMeshRef = useRef<THREE.InstancedMesh | null>(null);
    const pinnedRingMeshRef = useRef<THREE.InstancedMesh | null>(null);
    const hubMeshRef = useRef<THREE.InstancedMesh | null>(null);
    const orbitLinesRef = useRef<THREE.LineSegments | null>(null);
    const baseEdgeLinesRef = useRef<THREE.LineSegments | null>(null);
    const focusEdgeLinesRef = useRef<THREE.LineSegments | null>(null);
    const selHaloMeshRef = useRef<THREE.Mesh | null>(null);
    const hovHaloMeshRef = useRef<THREE.Mesh | null>(null);
    const bgStarsRef = useRef<THREE.Points | null>(null);

    const layoutRef = useRef<OrbitalLayoutResult | null>(null);
    const livePositionsRef = useRef<Map<string, Vec3>>(new Map());
    const nodesRef = useRef<GraphNodeModel[]>(nodes);
    const edgesRef = useRef<GraphEdgeModel[]>([]);
    const overviewEdgeCountRef = useRef(0);
    const adjacencyRef = useRef(new Map<string, Set<string>>());
    const nodeIndexByIdRef = useRef<Map<string, number>>(new Map());
    const hubSystemsRef = useRef<OrbitalSystemNode[]>([]);

    const selectedIdRef = useRef<string | null>(selectedNodeId);
    const focusedSystemRef = useRef<string | null>(focusedSystemKey);
    const searchQueryRef = useRef<string>(searchQuery);
    const settingsRef = useRef<UniverseSettings>(settings);
    const isDarkRef = useRef<boolean>(isDarkTheme);
    const reducedMotionRef = useRef<boolean>(reducedMotion);

    const framedVaultIdRef = useRef<string | null>(null);
    const frameVaultOnResizeRef = useRef(true);
    const hoveredIndexRef = useRef<number>(-1);
    const rafIdRef = useRef<number | null>(null);
    const lastZoomLevelRef = useRef<SemanticZoomLevel>(1);
    const orbitTimeRef = useRef<number>(0);
    const lastTickPerfRef = useRef<number>(0);
    const lastLabelPerfRef = useRef<number>(0);

    const flyAnimRef = useRef<{
      startTime: number;
      duration: number;
      fromCam: THREE.Vector3;
      toCam: THREE.Vector3;
      fromLook: THREE.Vector3;
      toLook: THREE.Vector3;
    } | null>(null);

    const onSelectRef = useRef(onSelectNode);
    const onFocusSysRef = useRef(onFocusSystemKey);
    const onZoomChangeRef = useRef(onZoomLevelChange);
    const onWebGlUnavailableRef = useRef(onWebGlUnavailable);

    useEffect(() => {
      onSelectRef.current = onSelectNode;
      onFocusSysRef.current = onFocusSystemKey;
      onZoomChangeRef.current = onZoomLevelChange;
      onWebGlUnavailableRef.current = onWebGlUnavailable;
    }, [onSelectNode, onFocusSystemKey, onZoomLevelChange, onWebGlUnavailable]);

    useEffect(() => {
      focusedSystemRef.current = focusedSystemKey;
      searchQueryRef.current = searchQuery;
      settingsRef.current = settings;
      isDarkRef.current = isDarkTheme;
      reducedMotionRef.current = reducedMotion;
    }, [
      focusedSystemKey,
      searchQuery,
      settings,
      isDarkTheme,
      reducedMotion,
    ]);

    function scheduleRender() {
      if (document.visibilityState === "hidden") return;
      if (rafIdRef.current === null) {
        rafIdRef.current = window.requestAnimationFrame(tickFrame);
      }
    }

    function getNeighborSets(centerId: string | null, depth: 1 | 2) {
      const hop1 = (centerId ? adjacencyRef.current.get(centerId) : undefined) ?? new Set<string>();
      const hop2 = new Set<string>();
      if (!centerId) return { hop1, hop2 };

      if (depth === 2) {
        for (const id of hop1) {
          const adjacent = adjacencyRef.current.get(id);
          if (!adjacent) continue;
          for (const other of adjacent) {
            if (other !== centerId && !hop1.has(other)) hop2.add(other);
          }
        }
      }
      return { hop1, hop2 };
    }

    function syncVisualBuffers(positionOnly = false) {
      const layout = layoutRef.current;
      const planetMesh = planetMeshRef.current;
      const pinnedMesh = pinnedRingMeshRef.current;
      const baseEdges = baseEdgeLinesRef.current;
      const focusEdges = focusEdgeLinesRef.current;
      const curNodes = nodesRef.current;
      const curEdges = edgesRef.current;
      if (!layout) return;

      const selId = selectedIdRef.current;
      const hovNode =
        hoveredIndexRef.current >= 0
          ? curNodes[hoveredIndexRef.current]
          : undefined;
      const activeFocusId = selId ?? hovNode?.id ?? null;
      const { hop1, hop2 } = getNeighborSets(
        activeFocusId,
        settingsRef.current.focusDepth,
      );

      // Update dynamic planet positions when orbital motion is enabled.
      const motionActive =
        settingsRef.current.orbitalMotion &&
        !reducedMotionRef.current &&
        !settingsRef.current.reducedEffects;

      const dummyMat = new THREE.Matrix4();
      const dummyPos = new THREE.Vector3();
      const dummyQuat = new THREE.Quaternion();
      const dummyScale = new THREE.Vector3();
      const ringQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(Math.PI * 0.42, 0.25, 0.12),
      );
      const sizeScale = settingsRef.current.starSize;

      let pinnedIdx = 0;

      if (planetMesh && curNodes.length > 0) {
        const stateAttr = planetMesh.geometry.getAttribute(
          "aState",
        ) as THREE.InstancedBufferAttribute;
        const stateArr = stateAttr.array as Float32Array;

        for (let i = 0; i < curNodes.length; i += 1) {
          const node = curNodes[i]!;
          const param = layout.orbitalParams.get(node.id);
          const pos =
            motionActive && param
              ? evaluateOrbitalPosition(param, orbitTimeRef.current)
              : (layout.positions.get(node.id) ?? { x: 0, y: 0, z: 0 });
          livePositionsRef.current.set(node.id, pos);

          const baseR = layout.planetRadii.get(node.id) ?? 1.0;
          const isSel = node.id === selId;
          const isHov = i === hoveredIndexRef.current;
          const s =
            baseR * sizeScale * (isSel ? 1.28 : isHov ? 1.15 : 1.0);

          dummyPos.set(pos.x, pos.y, pos.z);
          dummyScale.set(s, s, s);
          dummyMat.compose(dummyPos, dummyQuat, dummyScale);
          planetMesh.setMatrixAt(i, dummyMat);

          let stateVal = 1.0;
          if (isSel) stateVal = 1.6;
          else if (isHov) stateVal = 1.35;
          else if (activeFocusId) {
            if (hop1.has(node.id)) stateVal = 1.2;
            else if (hop2.has(node.id)) stateVal = 0.9;
            else stateVal = 0.2;
          }
          if (!positionOnly) stateArr[i] = stateVal;

          if (pinnedMesh && node.pinned) {
            dummyScale.set(s * 1.15, s * 1.15, s * 1.15);
            dummyMat.compose(dummyPos, ringQuat, dummyScale);
            pinnedMesh.setMatrixAt(pinnedIdx, dummyMat);
            pinnedIdx += 1;
          }
        }
        planetMesh.instanceMatrix.needsUpdate = true;
        if (!positionOnly) stateAttr.needsUpdate = true;

        if (pinnedMesh && pinnedIdx > 0) {
          pinnedMesh.instanceMatrix.needsUpdate = true;
        }
      }

      if (selHaloMeshRef.current) {
        const selPos = selId ? livePositionsRef.current.get(selId) : undefined;
        const selR = selId ? (layout.planetRadii.get(selId) ?? 1.2) : 1.2;
        if (selPos) {
          selHaloMeshRef.current.visible = true;
          selHaloMeshRef.current.position.set(selPos.x, selPos.y, selPos.z);
          const haloSize = selR * sizeScale * 4.4;
          selHaloMeshRef.current.scale.set(haloSize, haloSize, 1);
        } else {
          selHaloMeshRef.current.visible = false;
        }
      }

      if (hovHaloMeshRef.current) {
        const hovPos =
          hovNode && hovNode.id !== selId
            ? livePositionsRef.current.get(hovNode.id)
            : undefined;
        const hovR = hovNode
          ? (layout.planetRadii.get(hovNode.id) ?? 1.1)
          : 1.1;
        if (hovPos) {
          hovHaloMeshRef.current.visible = true;
          hovHaloMeshRef.current.position.set(hovPos.x, hovPos.y, hovPos.z);
          const haloSize = hovR * sizeScale * 3.6;
          hovHaloMeshRef.current.scale.set(haloSize, haloSize, 1);
        } else {
          hovHaloMeshRef.current.visible = false;
        }
      }

      const palette = isDarkRef.current
        ? CLUSTER_PALETTE
        : CLUSTER_PALETTE_LIGHT;

      if (baseEdges) {
        const posAttr = baseEdges.geometry.getAttribute(
          "position",
        ) as THREE.BufferAttribute;
        const colAttr = baseEdges.geometry.getAttribute(
          "color",
        ) as THREE.BufferAttribute;
        const pArr = posAttr.array as Float32Array;
        const cArr = colAttr.array as Float32Array;
        const nodeIdx = nodeIndexByIdRef.current;
        const ca = new THREE.Color();
        const cb = new THREE.Color();

        let pPtr = 0;
        for (const edge of curEdges) {
          const pa = livePositionsRef.current.get(edge.source);
          const pb = livePositionsRef.current.get(edge.target);
          if (!pa || !pb) {
            pArr.fill(0, pPtr, pPtr + 6);
            if (!positionOnly) cArr.fill(0, pPtr, pPtr + 6);
            pPtr += 6;
            continue;
          }
          const start = pPtr;
          pArr[pPtr++] = pa.x;
          pArr[pPtr++] = pa.y;
          pArr[pPtr++] = pa.z;
          pArr[pPtr++] = pb.x;
          pArr[pPtr++] = pb.y;
          pArr[pPtr++] = pb.z;

          if (!positionOnly) {
            const na = curNodes[nodeIdx.get(edge.source) ?? 0];
            const nb = curNodes[nodeIdx.get(edge.target) ?? 0];
            ca.set(palette[(na?.clusterColorIndex ?? 0) % palette.length] ?? "#6fa8f6");
            cb.set(palette[(nb?.clusterColorIndex ?? 0) % palette.length] ?? "#6fa8f6");
            ca.toArray(cArr, start);
            cb.toArray(cArr, start + 3);
          }
        }
        posAttr.needsUpdate = true;
        if (!positionOnly) colAttr.needsUpdate = true;
      }

      if (focusEdges) {
        if (!activeFocusId || curEdges.length === 0) {
          focusEdges.visible = false;
        } else {
          const positions = focusEdges.geometry.getAttribute("position") as THREE.BufferAttribute;
          const colors = focusEdges.geometry.getAttribute("color") as THREE.BufferAttribute;
          let count = 0;
          const outCol = new THREE.Color(
            isDarkRef.current ? 0x38bdf8 : 0x2563eb,
          );
          const inCol = new THREE.Color(
            isDarkRef.current ? 0xf59e0b : 0xd97706,
          );
          const hop2Col = new THREE.Color(
            isDarkRef.current ? 0x818cf8 : 0x6366f1,
          );

          for (const edge of curEdges) {
            const pa = livePositionsRef.current.get(edge.source);
            const pb = livePositionsRef.current.get(edge.target);
            if (!pa || !pb) continue;

            let col: THREE.Color | null = null;
            if (edge.source === activeFocusId) col = outCol;
            else if (edge.target === activeFocusId) col = inCol;
            else if (
              settingsRef.current.focusDepth === 2 &&
              ((hop1.has(edge.source) && hop2.has(edge.target)) ||
                (hop1.has(edge.target) && hop2.has(edge.source)))
            ) {
              col = hop2Col;
            }

            if (col) {
              positions.setXYZ(count, pa.x, pa.y, pa.z);
              positions.setXYZ(count + 1, pb.x, pb.y, pb.z);
              if (!positionOnly) {
                colors.setXYZ(count, col.r, col.g, col.b);
                colors.setXYZ(count + 1, col.r, col.g, col.b);
              }
              count += 2;
            }
          }

          focusEdges.geometry.setDrawRange(0, count);
          if (count > 0) {
            positions.clearUpdateRanges();
            positions.addUpdateRange(0, count * 3);
            positions.needsUpdate = true;
            if (!positionOnly) {
              colors.clearUpdateRanges();
              colors.addUpdateRange(0, count * 3);
              colors.needsUpdate = true;
            }
          }
          focusEdges.visible = count > 0;
        }
      }
    }

    function projectLabels() {
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      const container = containerRef.current;
      const layout = layoutRef.current;
      if (!camera || !controls || !container || !layout) {
        setLabels([]);
        return;
      }

      const selId = selectedIdRef.current;
      const hovId =
        hoveredIndexRef.current >= 0
          ? (nodesRef.current[hoveredIndexRef.current]?.id ?? null)
          : null;
      const { hop1 } = getNeighborSets(selId, 1);

      const camDist = camera.position.distanceTo(controls.target);
      const { zoomLevel, labels: nextLabels } = computeOrbitalLabels({
        nodes: nodesRef.current,
        systems: layout.systems,
        positions: livePositionsRef.current,
        camera,
        width: container.clientWidth,
        height: container.clientHeight,
        cameraDistance: camDist,
        boundingRadius: layout.boundingRadius,
        coreRadius: layout.vaultCoreRadius,
        selectedNodeId: selId,
        hoveredNodeId: hovId,
        focusedSystemKey: focusedSystemRef.current,
        neighborIds: hop1,
        searchQuery: searchQueryRef.current,
        labelDensity: settingsRef.current.labelDensity,
        isDarkTheme: isDarkRef.current,
      });

      if (zoomLevel !== lastZoomLevelRef.current) {
        lastZoomLevelRef.current = zoomLevel;
        onZoomChangeRef.current?.(zoomLevel);
      }

      setLabels((prev) => {
        if (
          prev.length === nextLabels.length &&
          prev.every((p, idx) => {
            const n = nextLabels[idx]!;
            return (
              p.id === n.id &&
              p.title === n.title &&
              p.color === n.color &&
              p.count === n.count &&
              p.alignLeft === n.alignLeft &&
              p.isMatched === n.isMatched &&
              p.isNeighbor === n.isNeighbor &&
              p.isPinned === n.isPinned &&
              p.isSelected === n.isSelected &&
              p.isHovered === n.isHovered &&
              Math.abs(p.x - n.x) < 1.5 &&
              Math.abs(p.y - n.y) < 1.5
            );
          })
        ) {
          return prev;
        }
        return nextLabels;
      });
    }

    function startCameraMove(
      toCam: THREE.Vector3,
      toLook: THREE.Vector3,
      instant = false,
    ) {
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!camera || !controls) return;

      if (instant || reducedMotionRef.current) {
        flyAnimRef.current = null;
        camera.position.copy(toCam);
        controls.target.copy(toLook);
        controls.update();
        scheduleRender();
        return;
      }

      flyAnimRef.current = {
        startTime: performance.now(),
        duration: 460,
        fromCam: camera.position.clone(),
        toCam: toCam.clone(),
        fromLook: controls.target.clone(),
        toLook: toLook.clone(),
      };
      scheduleRender();
    }

    function frameOrbit(center: Vec3, radius: number, instant = false) {
      const camera = cameraRef.current;
      if (!camera) return;

      const verticalHalfAngle = THREE.MathUtils.degToRad(camera.fov / 2);
      const horizontalHalfAngle = Math.atan(Math.tan(verticalHalfAngle) * camera.aspect);
      const frameAngle = Math.min(verticalHalfAngle, horizontalHalfAngle) * 0.84;
      const distance = Math.max(24, radius / Math.sin(frameAngle));
      const look = new THREE.Vector3(center.x, center.y, center.z);
      const position = new THREE.Vector3(0.17, 0.71, 0.68).setLength(distance).add(look);
      frameVaultOnResizeRef.current = false;
      startCameraMove(position, look, instant);
    }

    function frameVault(instant = false) {
      const layout = layoutRef.current;
      const camera = cameraRef.current;
      if (!layout || !camera) return;
      frameVaultOnResizeRef.current = true;

      const direction = new THREE.Vector3(0.17, 0.71, 0.68).normalize();
      const right = new THREE.Vector3(0, 1, 0).cross(direction).normalize();
      const up = new THREE.Vector3().crossVectors(direction, right);
      const points = Array.from(layout.positions.values());
      for (const ring of layout.rings) {
        for (let segment = 0; segment < 16; segment += 1) {
          points.push(evaluateOrbitalPosition({
            hubCenter: ring.center,
            orbitRadius: ring.radius,
            baseAngle: segment * Math.PI / 8,
            angularSpeed: 0,
            tiltX: ring.tiltX,
            tiltZ: ring.tiltZ,
            yOffset: 0,
          }, 0));
        }
      }
      const core = layout.vaultCoreRadius;
      points.push(
        { x: -core, y: -core, z: -core },
        { x: core, y: core, z: core },
      );
      const sample = new THREE.Vector3();
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const point of points) {
        sample.set(point.x, point.y, point.z);
        const x = sample.dot(right);
        const y = sample.dot(up);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const look = right.clone().multiplyScalar(centerX).addScaledVector(up, centerY);
      const vertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const fitHalfWidth = vertical * camera.aspect * 0.80;
      const fitHalfHeight = vertical * 0.74;
      const margin = Math.max(4, settingsRef.current.starSize * 3);
      let distance = 30;
      for (const point of points) {
        sample.set(point.x, point.y, point.z);
        const x = Math.abs(sample.dot(right) - centerX) + margin;
        const y = Math.abs(sample.dot(up) - centerY) + margin;
        distance = Math.max(distance, sample.dot(direction) + Math.max(x / fitHalfWidth, y / fitHalfHeight));
      }
      startCameraMove(look.clone().addScaledVector(direction, distance), look, instant);
    }

    function frameSystem(systemKey: string, instant = false) {
      const layout = layoutRef.current;
      if (!layout) return;
      const sys = layout.systemByKey.get(systemKey);
      if (!sys) return;
      if (sys.depth === 0) {
        frameVault(instant);
        return;
      }
      frameOrbit(sys.center, sys.systemRadius, instant);
    }

    function tickFrame() {
      rafIdRef.current = null;
      if (document.visibilityState === "hidden") return;

      const renderer = rendererRef.current;
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!renderer || !scene || !camera || !controls) return;

      const now = performance.now();
      const dt = lastTickPerfRef.current > 0
        ? Math.min(0.05, Math.max(0, (now - lastTickPerfRef.current) / 1000))
        : 0;
      lastTickPerfRef.current = now;

      let keepAnimating = false;

      if (
        settingsRef.current.orbitalMotion &&
        !reducedMotionRef.current &&
        !settingsRef.current.reducedEffects &&
        nodesRef.current.length > 0
      ) {
        orbitTimeRef.current += dt;
        syncVisualBuffers(true);
        keepAnimating = true;
      }

      if (flyAnimRef.current) {
        const anim = flyAnimRef.current;
        const t = Math.min(1, (now - anim.startTime) / anim.duration);
        const eased = 1 - Math.pow(1 - t, 3);
        camera.position.lerpVectors(anim.fromCam, anim.toCam, eased);
        controls.target.lerpVectors(anim.fromLook, anim.toLook, eased);
        if (t >= 1) {
          camera.position.copy(anim.toCam);
          controls.target.copy(anim.toLook);
          flyAnimRef.current = null;
        } else {
          keepAnimating = true;
        }
      }

      const controlsMoved = controls.update();
      if (controlsMoved) keepAnimating = true;
      if (coreGlowRef.current?.visible) {
        coreGlowRef.current.quaternion.copy(camera.quaternion);
      }

      if (selHaloMeshRef.current && selHaloMeshRef.current.visible) {
        selHaloMeshRef.current.quaternion.copy(camera.quaternion);
      }
      if (hovHaloMeshRef.current && hovHaloMeshRef.current.visible) {
        hovHaloMeshRef.current.quaternion.copy(camera.quaternion);
      }

      if (!keepAnimating || now - lastLabelPerfRef.current >= 32) {
        lastLabelPerfRef.current = now;
        camera.updateMatrixWorld();
        projectLabels();
      }
      const filaments = baseEdgeLinesRef.current;
      if (filaments) {
        const base = settingsRef.current.connectionOpacity;
        const focused = selectedIdRef.current !== null || hoveredIndexRef.current >= 0;
        const zoom = lastZoomLevelRef.current;
        const material = filaments.material as THREE.LineBasicMaterial;
        material.opacity = base * (focused ? 0.09 : zoom === 1 ? 0.17 : zoom === 2 ? 0.30 : 0.55);
        filaments.geometry.setDrawRange(0, 2 * (
          zoom === 1 ? overviewEdgeCountRef.current : edgesRef.current.length
        ));
      }
      renderer.render(scene, camera);

      if (keepAnimating) {
        scheduleRender();
      } else {
        lastTickPerfRef.current = 0;
      }
    }

    useImperativeHandle(
      ref,
      () => ({
        resetCamera() {
          onFocusSysRef.current?.(null);
          frameVault();
        },
        fitAll() {
          frameVault();
        },
        focusNode(nodeId: string) {
          const pos = livePositionsRef.current.get(nodeId);
          if (!pos) return;
          const radius = layoutRef.current?.planetRadii.get(nodeId) ?? 1;
          frameOrbit(pos, radius * settingsRef.current.starSize * 4.5);
        },
        focusSystem(systemKey: string) {
          onFocusSysRef.current?.(systemKey === "(vault)" ? null : systemKey);
          frameSystem(systemKey);
        },
        focusParentSystem() {
          const layout = layoutRef.current;
          if (!layout) return;
          const currentSysKey = focusedSystemRef.current;
          if (currentSysKey) {
            const cur = layout.systemByKey.get(currentSysKey);
            const parentKey = cur?.parentKey ?? "(vault)";
            onFocusSysRef.current?.(parentKey === "(vault)" ? null : parentKey);
            frameSystem(parentKey);
            return;
          }
          const selId = selectedIdRef.current;
          if (selId) {
            const node = nodesRef.current.find((n) => n.id === selId);
            const targetKey = getOrbitalFolderKey(node?.folderSegments.slice(0, 1) ?? []);
            onFocusSysRef.current?.(targetKey === "(vault)" ? null : targetKey);
            frameSystem(targetKey);
            return;
          }
          frameVault();
        },
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );

    // Mount WebGLRenderer + OrbitControls + static halos/starfield once.
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      let renderer: THREE.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
          powerPreference: "high-performance",
        });
      } catch (err) {
        onWebGlUnavailableRef.current(
          err instanceof Error
            ? `WebGL initialization unavailable: ${err.message}`
            : "WebGL initialization unavailable on this graphics adapter.",
        );
        return;
      }

      const width = Math.max(container.clientWidth, 320);
      const height = Math.max(container.clientHeight, 240);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      renderer.domElement.style.display = "block";
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      container.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(45, width / height, 0.5, 4800);
      camera.position.set(24, 96, 175);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = !reducedMotionRef.current;
      controls.dampingFactor = 0.085;
      controls.zoomToCursor = true;
      controls.minDistance = 8;
      controls.maxDistance = 2400;

      const bgStars = buildOrbitalStarfield(isDarkRef.current);
      bgStars.visible =
        settingsRef.current.showBackgroundStars &&
        !settingsRef.current.reducedEffects;
      scene.add(bgStars);

      const coreGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
        vertexShader: HALO_VERTEX,
        fragmentShader: CORE_GLOW_FRAGMENT,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      coreGlow.visible = isDarkRef.current && !settingsRef.current.reducedEffects;
      scene.add(coreGlow);
      coreGlowRef.current = coreGlow;

      const selHaloGeo = new THREE.PlaneGeometry(1, 1);
      const selHaloMat = new THREE.ShaderMaterial({
        vertexShader: HALO_VERTEX,
        fragmentShader: HALO_FRAGMENT,
        uniforms: {
          uColor: {
            value: new THREE.Color(isDarkRef.current ? 0x60a5fa : 0x2563eb),
          },
          uOpacity: { value: 0.92 },
        },
        transparent: true,
        depthWrite: false,
      });
      const selHalo = new THREE.Mesh(selHaloGeo, selHaloMat);
      selHalo.visible = false;
      scene.add(selHalo);

      const hovHaloGeo = new THREE.PlaneGeometry(1, 1);
      const hovHaloMat = new THREE.ShaderMaterial({
        vertexShader: HALO_VERTEX,
        fragmentShader: HALO_FRAGMENT,
        uniforms: {
          uColor: {
            value: new THREE.Color(isDarkRef.current ? 0xe2e8f0 : 0x334155),
          },
          uOpacity: { value: 0.55 },
        },
        transparent: true,
        depthWrite: false,
      });
      const hovHalo = new THREE.Mesh(hovHaloGeo, hovHaloMat);
      hovHalo.visible = false;
      scene.add(hovHalo);

      const focusGeo = new THREE.BufferGeometry();
      const focusMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: isDarkRef.current ? 0.88 : 0.8,
        depthWrite: false,
      });
      const focusLines = new THREE.LineSegments(focusGeo, focusMat);
      focusLines.visible = false;
      focusLines.frustumCulled = false;
      scene.add(focusLines);

      sceneRef.current = scene;
      cameraRef.current = camera;
      controlsRef.current = controls;
      rendererRef.current = renderer;
      bgStarsRef.current = bgStars;
      selHaloMeshRef.current = selHalo;
      hovHaloMeshRef.current = hovHalo;
      focusEdgeLinesRef.current = focusLines;

      const onControlsChange = () => {
        scheduleRender();
      };
      controls.addEventListener("change", onControlsChange);

      const raycaster = new THREE.Raycaster();
      const pointerNdc = new THREE.Vector2();
      const projVec = new THREE.Vector3();
      let downX = 0;
      let downY = 0;

      const pickPlanetIndex = (clientX: number, clientY: number, exact = false): number => {
        const rect = renderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return -1;

        // First try exact 3D mesh raycast for large close planets.
        const planetMesh = planetMeshRef.current;
        if (exact && planetMesh && nodesRef.current.length > 0) {
          pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
          pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(pointerNdc, camera);
          const hits = raycaster.intersectObject(planetMesh, false);
          if (hits[0] && typeof hits[0].instanceId === "number") {
            return hits[0].instanceId;
          }
        }

        // Fall back to generous 14px screen-space proximity picking for distant planets.
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        const hitRadiusSq = 14 * 14;
        let bestIdx = -1;
        let bestScore = Infinity;

        for (let i = 0; i < nodesRef.current.length; i += 1) {
          const node = nodesRef.current[i]!;
          const p = livePositionsRef.current.get(node.id);
          if (!p) continue;
          projVec.set(p.x, p.y, p.z).project(camera);
          if (projVec.z < -1 || projVec.z > 1) continue;
          const sx = (projVec.x * 0.5 + 0.5) * rect.width;
          const sy = (-projVec.y * 0.5 + 0.5) * rect.height;
          const distSq = (sx - px) * (sx - px) + (sy - py) * (sy - py);
          if (distSq <= hitRadiusSq) {
            const score = distSq + projVec.z * 8;
            if (score < bestScore) {
              bestScore = score;
              bestIdx = i;
            }
          }
        }
        return bestIdx;
      };

      const pickHubSystem = (
        clientX: number,
        clientY: number,
      ): OrbitalSystemNode | null => {
        const hubMesh = hubMeshRef.current;
        if (!hubMesh || hubSystemsRef.current.length === 0) return null;
        const rect = renderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointerNdc, camera);
        const hits = raycaster.intersectObject(hubMesh, false);
        const hit = hits[0];
        if (hit && typeof hit.instanceId === "number") {
          return hubSystemsRef.current[hit.instanceId] ?? null;
        }
        return null;
      };

      const onPointerDown = (ev: PointerEvent) => {
        downX = ev.clientX;
        downY = ev.clientY;
        frameVaultOnResizeRef.current = false;
        flyAnimRef.current = null;
      };

      const onWheel = () => {
        frameVaultOnResizeRef.current = false;
        flyAnimRef.current = null;
      };

      const onPointerMove = (ev: PointerEvent) => {
        if (ev.buttons !== 0) return;
        const picked = pickPlanetIndex(ev.clientX, ev.clientY);
        if (picked !== hoveredIndexRef.current) {
          hoveredIndexRef.current = picked;
          renderer.domElement.style.cursor = picked >= 0 ? "pointer" : "grab";
          syncVisualBuffers();
          scheduleRender();
        } else if (picked < 0) {
          const hub = pickHubSystem(ev.clientX, ev.clientY);
          renderer.domElement.style.cursor = hub ? "pointer" : "grab";
        }
      };

      const onPointerLeave = () => {
        if (hoveredIndexRef.current === -1) return;
        hoveredIndexRef.current = -1;
        renderer.domElement.style.cursor = "grab";
        syncVisualBuffers();
        scheduleRender();
      };

      const onPointerUp = (ev: PointerEvent) => {
        if (ev.button !== 0) return;
        const moved = Math.hypot(ev.clientX - downX, ev.clientY - downY);
        if (moved > 5) return;
        const pickedPlanet = pickPlanetIndex(ev.clientX, ev.clientY, true);
        if (pickedPlanet >= 0) {
          const targetNode = nodesRef.current[pickedPlanet];
          onSelectRef.current(targetNode ? targetNode.id : null);
          return;
        }
        const hub = pickHubSystem(ev.clientX, ev.clientY);
        if (hub) {
          onFocusSysRef.current?.(hub.key);
          frameSystem(hub.key);
          return;
        }
        onSelectRef.current(null);
      };

      const onContextLost = (ev: Event) => {
        ev.preventDefault();
        if (rafIdRef.current !== null) {
          window.cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        onWebGlUnavailableRef.current(
          "WebGL rendering context was lost. Switched to accessible list view.",
        );
      };

      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden") {
          lastTickPerfRef.current = 0;
          if (rafIdRef.current !== null) {
            window.cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
          }
        } else {
          scheduleRender();
        }
      };

      const resizeObserver = new ResizeObserver(() => {
        const w = Math.max(container.clientWidth, 1);
        const h = Math.max(container.clientHeight, 1);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        if (frameVaultOnResizeRef.current) frameVault(true);
        scheduleRender();
      });
      resizeObserver.observe(container);

      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      renderer.domElement.addEventListener("wheel", onWheel, { passive: true });
      renderer.domElement.addEventListener("pointermove", onPointerMove);
      renderer.domElement.addEventListener("pointerleave", onPointerLeave);
      renderer.domElement.addEventListener("pointerup", onPointerUp);
      renderer.domElement.addEventListener("webglcontextlost", onContextLost);
      document.addEventListener("visibilitychange", onVisibilityChange);

      return () => {
        if (rafIdRef.current !== null) {
          window.cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        resizeObserver.disconnect();
        controls.removeEventListener("change", onControlsChange);
        renderer.domElement.removeEventListener("pointerdown", onPointerDown);
        renderer.domElement.removeEventListener("wheel", onWheel);
        renderer.domElement.removeEventListener("pointermove", onPointerMove);
        renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
        renderer.domElement.removeEventListener("pointerup", onPointerUp);
        renderer.domElement.removeEventListener(
          "webglcontextlost",
          onContextLost,
        );
        document.removeEventListener("visibilitychange", onVisibilityChange);

        const disposeMesh = (obj: THREE.Object3D | null) => {
          if (!obj) return;
          scene.remove(obj);
          if ("geometry" in obj && obj.geometry instanceof THREE.BufferGeometry) {
            obj.geometry.dispose();
          }
          if ("material" in obj && obj.material instanceof THREE.Material) {
            obj.material.dispose();
          }
          if (obj instanceof THREE.InstancedMesh) {
            obj.dispose();
          }
        };

        disposeMesh(coreMeshRef.current);
        disposeMesh(coreGlowRef.current);
        disposeMesh(planetMeshRef.current);
        disposeMesh(pinnedRingMeshRef.current);
        disposeMesh(hubMeshRef.current);
        disposeMesh(orbitLinesRef.current);
        disposeMesh(baseEdgeLinesRef.current);
        disposeMesh(focusEdgeLinesRef.current);
        disposeMesh(bgStarsRef.current);
        disposeMesh(selHaloMeshRef.current);
        disposeMesh(hovHaloMeshRef.current);

        controls.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        if (renderer.domElement.parentNode === container) {
          container.removeChild(renderer.domElement);
        }

        sceneRef.current = null;
        cameraRef.current = null;
        controlsRef.current = null;
        rendererRef.current = null;
        coreMeshRef.current = null;
        coreGlowRef.current = null;
        planetMeshRef.current = null;
        pinnedRingMeshRef.current = null;
        hubMeshRef.current = null;
        orbitLinesRef.current = null;
        baseEdgeLinesRef.current = null;
        focusEdgeLinesRef.current = null;
        selHaloMeshRef.current = null;
        hovHaloMeshRef.current = null;
        bgStarsRef.current = null;
        framedVaultIdRef.current = null;
        lastTickPerfRef.current = 0;
        lastLabelPerfRef.current = 0;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Synchronize theme, reducedMotion, and rendering uniforms without tearing down WebGL.
    useEffect(() => {
      const scene = sceneRef.current;
      const controls = controlsRef.current;
      if (!scene) return;

      if (controls) {
        controls.enableDamping = !reducedMotion;
      }
      if (bgStarsRef.current) {
        bgStarsRef.current.visible =
          settings.showBackgroundStars && !settings.reducedEffects;
        (bgStarsRef.current.material as THREE.PointsMaterial).opacity =
          isDarkTheme ? 0.3 : 0.18;
      }
      if (coreGlowRef.current) {
        coreGlowRef.current.visible = isDarkTheme && !settings.reducedEffects;
      }
      if (coreMeshRef.current) {
        const mat = coreMeshRef.current.material as THREE.ShaderMaterial;
        mat.uniforms.uLightMode!.value = isDarkTheme ? 0.0 : 1.0;
        mat.uniforms.uReducedEffects!.value = settings.reducedEffects ? 1.0 : 0.0;
      }
      if (planetMeshRef.current) {
        const mat = planetMeshRef.current.material as THREE.ShaderMaterial;
        mat.uniforms.uLightMode!.value = isDarkTheme ? 0.0 : 1.0;
        mat.uniforms.uReducedEffects!.value = settings.reducedEffects ? 1.0 : 0.0;

        const colAttr = planetMeshRef.current.geometry.getAttribute(
          "aColor",
        ) as THREE.InstancedBufferAttribute;
        const cArr = colAttr.array as Float32Array;
        const palette = isDarkTheme ? CLUSTER_PALETTE : CLUSTER_PALETTE_LIGHT;
        const tmpColor = new THREE.Color();
        nodesRef.current.forEach((node, idx) => {
          const hex =
            palette[node.clusterColorIndex % palette.length] ?? "#6fa8f6";
          tintPlanetColor(node.id, hex, tmpColor);
          cArr[idx * 3] = tmpColor.r;
          cArr[idx * 3 + 1] = tmpColor.g;
          cArr[idx * 3 + 2] = tmpColor.b;
        });
        colAttr.needsUpdate = true;
      }
      if (orbitLinesRef.current && layoutRef.current) {
        (orbitLinesRef.current.material as THREE.LineBasicMaterial).opacity =
          isDarkTheme ? 0.18 : 0.24;
        const ringColAttr = orbitLinesRef.current.geometry.getAttribute(
          "color",
        ) as THREE.BufferAttribute;
        const rcArr = ringColAttr.array as Float32Array;
        const palette = isDarkTheme ? CLUSTER_PALETTE : CLUSTER_PALETTE_LIGHT;
        const rc = new THREE.Color();
        let rcPtr = 0;
        for (const ring of layoutRef.current.rings) {
          rc.set(palette[ring.colorIndex % palette.length] ?? "#6fa8f6");
          const shade = ring.isBelt ? 0.55 : 0.85;
          const rCol = rc.r * shade;
          const gCol = rc.g * shade;
          const bCol = rc.b * shade;
          for (let s = 0; s < 64; s += 1) {
            rcArr[rcPtr++] = rCol;
            rcArr[rcPtr++] = gCol;
            rcArr[rcPtr++] = bCol;
            rcArr[rcPtr++] = rCol;
            rcArr[rcPtr++] = gCol;
            rcArr[rcPtr++] = bCol;
          }
        }
        ringColAttr.needsUpdate = true;
      }
      if (hubMeshRef.current && hubSystemsRef.current.length > 0) {
        const hubMesh = hubMeshRef.current;
        (hubMesh.material as THREE.MeshBasicMaterial).opacity = isDarkTheme
          ? 0.55
          : 0.45;
        const palette = isDarkTheme ? CLUSTER_PALETTE : CLUSTER_PALETTE_LIGHT;
        const hc = new THREE.Color();
        hubSystemsRef.current.forEach((sys, idx) => {
          hc.set(palette[sys.colorIndex % palette.length] ?? "#6fa8f6");
          hubMesh.setColorAt(idx, hc);
        });
        if (hubMesh.instanceColor) hubMesh.instanceColor.needsUpdate = true;
      }
      if (pinnedRingMeshRef.current) {
        (pinnedRingMeshRef.current.material as THREE.MeshBasicMaterial).color.setHex(
          isDarkTheme ? 0xfbbf24 : 0xb45309,
        );
      }
      if (selHaloMeshRef.current) {
        const mat = selHaloMeshRef.current.material as THREE.ShaderMaterial;
        (mat.uniforms.uColor!.value as THREE.Color).setHex(
          isDarkTheme ? 0x60a5fa : 0x2563eb,
        );
      }
      if (hovHaloMeshRef.current) {
        const mat = hovHaloMeshRef.current.material as THREE.ShaderMaterial;
        (mat.uniforms.uColor!.value as THREE.Color).setHex(
          isDarkTheme ? 0xe2e8f0 : 0x334155,
        );
      }
      if (focusEdgeLinesRef.current) {
        (
          focusEdgeLinesRef.current.material as THREE.LineBasicMaterial
        ).opacity = isDarkTheme ? 0.88 : 0.8;
      }

      syncVisualBuffers();
      scheduleRender();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      isDarkTheme,
      reducedMotion,
      settings.starSize,
      settings.connectionOpacity,
      settings.labelDensity,
      settings.showBackgroundStars,
      settings.orbitalMotion,
      settings.focusDepth,
      settings.reducedEffects,
      searchQuery,
    ]);

    // Build orbital hierarchy + GPU instanced meshes & ring buffers when graph or orbitSpacing changes.
    useEffect(() => {
      const scene = sceneRef.current;
      if (!scene) return;

      const vaultChanged = framedVaultIdRef.current !== vaultId;
      nodesRef.current = nodes;
      const nonSelf = edges.filter((edge) => !edge.isSelfLoop);
      if (nonSelf.length <= 180) {
        edgesRef.current = nonSelf;
        overviewEdgeCountRef.current = nonSelf.length;
      } else {
        const folderKeys = new Map(nodes.map((node) => [node.id, node.folderPath]));
        const local: GraphEdgeModel[] = [];
        const crossOrbit: GraphEdgeModel[] = [];
        for (const edge of nonSelf) {
          const bucket = folderKeys.get(edge.source) === folderKeys.get(edge.target) ? local : crossOrbit;
          bucket.push(edge);
        }
        const byStableRank = (a: GraphEdgeModel, b: GraphEdgeModel) =>
          deterministicHashUnit(a.key) - deterministicHashUnit(b.key) || a.key.localeCompare(b.key);
        const overview = [...local.sort(byStableRank).slice(0, 110), ...crossOrbit.sort(byStableRank).slice(0, 45)];
        const included = new Set(overview);
        edgesRef.current = [...overview, ...nonSelf.filter((edge) => !included.has(edge))];
        overviewEdgeCountRef.current = overview.length;
      }
      const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
      for (const edge of nonSelf) {
        adjacency.get(edge.source)?.add(edge.target);
        adjacency.get(edge.target)?.add(edge.source);
      }
      adjacencyRef.current = adjacency;
      nodeIndexByIdRef.current = new Map(nodes.map((n, idx) => [n.id, idx]));
      hoveredIndexRef.current = -1;

      const removeAndDispose = (obj: THREE.Object3D | null) => {
        if (!obj) return;
        scene.remove(obj);
        if ("geometry" in obj && obj.geometry instanceof THREE.BufferGeometry) {
          obj.geometry.dispose();
        }
        if ("material" in obj && obj.material instanceof THREE.Material) {
          obj.material.dispose();
        }
        if (obj instanceof THREE.InstancedMesh) {
          obj.dispose();
        }
      };

      removeAndDispose(coreMeshRef.current);
      coreMeshRef.current = null;
      removeAndDispose(planetMeshRef.current);
      planetMeshRef.current = null;
      removeAndDispose(pinnedRingMeshRef.current);
      pinnedRingMeshRef.current = null;
      removeAndDispose(hubMeshRef.current);
      hubMeshRef.current = null;
      removeAndDispose(orbitLinesRef.current);
      orbitLinesRef.current = null;
      removeAndDispose(baseEdgeLinesRef.current);
      baseEdgeLinesRef.current = null;

      const layout = createOrbitalLayout(nodes, edges, {
        vaultLabel: vaultName,
        orbitSpacing: settings.clusterSpacing,
      });
      layoutRef.current = layout;
      livePositionsRef.current = new Map(layout.positions);
      if (focusEdgeLinesRef.current) {
        const geo = focusEdgeLinesRef.current.geometry;
        // Layout changes may alter capacity. Release old GPU attributes before replacing them.
        geo.dispose();
        for (const name of ["position", "color"]) {
          geo.setAttribute(name, new THREE.BufferAttribute(new Float32Array(nonSelf.length * 6), 3).setUsage(THREE.DynamicDrawUsage));
        }
        geo.setDrawRange(0, 0);
      }
      if (controlsRef.current) {
        controlsRef.current.maxDistance = Math.max(
          2400,
          layout.boundingRadius * 4.5,
        );
      }
      if (cameraRef.current) {
        cameraRef.current.far = Math.max(4800, layout.boundingRadius * 7);
        cameraRef.current.updateProjectionMatrix();
      }

      // 1. Central Vault Core (non-pickable, decorative celestial body)
      const coreGeo = new THREE.SphereGeometry(layout.vaultCoreRadius, 36, 24);
      const coreMat = new THREE.ShaderMaterial({
        vertexShader: VAULT_CORE_VERTEX,
        fragmentShader: VAULT_CORE_FRAGMENT,
        uniforms: {
          uLightMode: { value: isDarkRef.current ? 0.0 : 1.0 },
          uReducedEffects: {
            value: settingsRef.current.reducedEffects ? 1.0 : 0.0,
          },
        },
      });
      const coreMesh = new THREE.Mesh(coreGeo, coreMat);
      scene.add(coreMesh);
      coreMeshRef.current = coreMesh;
      coreGlowRef.current?.scale.setScalar(layout.vaultCoreRadius * 7.5);

      // 2. Orbital system hub barycenters (depth >= 1)
      const subHubs = layout.systems.filter((s) => s.depth >= 1);
      hubSystemsRef.current = subHubs;
      if (subHubs.length > 0) {
        const hubGeo = new THREE.SphereGeometry(1.45, 16, 12);
        const hubMat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: isDarkRef.current ? 0.55 : 0.45,
          depthWrite: false,
        });
        const hubMesh = new THREE.InstancedMesh(hubGeo, hubMat, subHubs.length);
        const m = new THREE.Matrix4();
        const c = new THREE.Color();
        const palette = isDarkRef.current
          ? CLUSTER_PALETTE
          : CLUSTER_PALETTE_LIGHT;

        subHubs.forEach((sys, idx) => {
          const s = sys.depth === 1 ? 1.25 : 0.85;
          m.makeScale(s, s, s);
          m.setPosition(sys.center.x, sys.center.y, sys.center.z);
          hubMesh.setMatrixAt(idx, m);
          c.set(palette[sys.colorIndex % palette.length] ?? "#6fa8f6");
          hubMesh.setColorAt(idx, c);
        });
        hubMesh.instanceMatrix.needsUpdate = true;
        if (hubMesh.instanceColor) hubMesh.instanceColor.needsUpdate = true;
        hubMesh.computeBoundingSphere();
        scene.add(hubMesh);
        hubMeshRef.current = hubMesh;
      }

      // 3. Batched thin orbital rings (system orbits + note belts)
      if (layout.rings.length > 0) {
        const segsPerRing = 64;
        const totalSegs = layout.rings.length * segsPerRing;
        const ringVerts = new Float32Array(totalSegs * 6);
        const ringCols = new Float32Array(totalSegs * 6);
        const palette = isDarkRef.current
          ? CLUSTER_PALETTE
          : CLUSTER_PALETTE_LIGHT;
        const c = new THREE.Color();
        let vPtr = 0;
        let cPtr = 0;

        for (const ring of layout.rings) {
          c.set(palette[ring.colorIndex % palette.length] ?? "#6fa8f6");
          const shade = ring.isBelt ? 0.55 : 0.85;
          const rCol = c.r * shade;
          const gCol = c.g * shade;
          const bCol = c.b * shade;

          for (let s = 0; s < segsPerRing; s += 1) {
            const a0 = (s / segsPerRing) * Math.PI * 2;
            const a1 = ((s + 1) / segsPerRing) * Math.PI * 2;
            const p0 = evaluateOrbitalPosition(
              {
                hubCenter: ring.center,
                orbitRadius: ring.radius,
                baseAngle: a0,
                angularSpeed: 0,
                tiltX: ring.tiltX,
                tiltZ: ring.tiltZ,
                yOffset: 0,
              },
              0,
            );
            const p1 = evaluateOrbitalPosition(
              {
                hubCenter: ring.center,
                orbitRadius: ring.radius,
                baseAngle: a1,
                angularSpeed: 0,
                tiltX: ring.tiltX,
                tiltZ: ring.tiltZ,
                yOffset: 0,
              },
              0,
            );
            ringVerts[vPtr++] = p0.x;
            ringVerts[vPtr++] = p0.y;
            ringVerts[vPtr++] = p0.z;
            ringVerts[vPtr++] = p1.x;
            ringVerts[vPtr++] = p1.y;
            ringVerts[vPtr++] = p1.z;

            ringCols[cPtr++] = rCol;
            ringCols[cPtr++] = gCol;
            ringCols[cPtr++] = bCol;
            ringCols[cPtr++] = rCol;
            ringCols[cPtr++] = gCol;
            ringCols[cPtr++] = bCol;
          }
        }

        const ringGeo = new THREE.BufferGeometry();
        ringGeo.setAttribute(
          "position",
          new THREE.BufferAttribute(ringVerts, 3),
        );
        ringGeo.setAttribute("color", new THREE.BufferAttribute(ringCols, 3));
        const ringMat = new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: isDarkRef.current ? 0.18 : 0.24,
          depthWrite: false,
        });
        const ringLines = new THREE.LineSegments(ringGeo, ringMat);
        ringLines.frustumCulled = false;
        scene.add(ringLines);
        orbitLinesRef.current = ringLines;
      }

      // 4. Instanced spherical planets + pinned rings
      if (nodes.length > 0) {
        const dense = nodes.length >= 750;
        const sphereGeo = new THREE.SphereGeometry(1, dense ? 12 : 24, dense ? 8 : 16);
        const colArr = new Float32Array(nodes.length * 3);
        const seedArr = new Float32Array(nodes.length);
        const stateArr = new Float32Array(nodes.length);
        const palette = isDarkRef.current
          ? CLUSTER_PALETTE
          : CLUSTER_PALETTE_LIGHT;
        const c = new THREE.Color();

        let pinnedCount = 0;
        nodes.forEach((node, idx) => {
          const hex =
            palette[node.clusterColorIndex % palette.length] ?? "#6fa8f6";
          tintPlanetColor(node.id, hex, c);
          colArr[idx * 3] = c.r;
          colArr[idx * 3 + 1] = c.g;
          colArr[idx * 3 + 2] = c.b;
          seedArr[idx] = deterministicHashUnit(node.id);
          stateArr[idx] = 1.0;
          if (node.pinned) pinnedCount += 1;
        });

        sphereGeo.setAttribute(
          "aColor",
          new THREE.InstancedBufferAttribute(colArr, 3),
        );
        sphereGeo.setAttribute(
          "aSeed",
          new THREE.InstancedBufferAttribute(seedArr, 1),
        );
        sphereGeo.setAttribute(
          "aState",
          new THREE.InstancedBufferAttribute(stateArr, 1).setUsage(THREE.DynamicDrawUsage),
        );

        const planetMat = new THREE.ShaderMaterial({
          vertexShader: PLANET_VERTEX,
          fragmentShader: PLANET_FRAGMENT,
          uniforms: {
            uLightMode: { value: isDarkRef.current ? 0.0 : 1.0 },
            uReducedEffects: {
              value: settingsRef.current.reducedEffects ? 1.0 : 0.0,
            },
          },
          transparent: true,
        });

        const planetMesh = new THREE.InstancedMesh(
          sphereGeo,
          planetMat,
          nodes.length,
        );
        planetMesh.frustumCulled = false;
        planetMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        planetMesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), layout.boundingRadius + 16);
        scene.add(planetMesh);
        planetMeshRef.current = planetMesh;

        if (pinnedCount > 0) {
          const pinGeo = new THREE.RingGeometry(1.42, 1.7, 28);
          const pinMat = new THREE.MeshBasicMaterial({
            color: isDarkRef.current ? 0xfbbf24 : 0xb45309,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.72,
            depthWrite: false,
          });
          const pinMesh = new THREE.InstancedMesh(
            pinGeo,
            pinMat,
            pinnedCount,
          );
          pinMesh.frustumCulled = false;
          pinMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          scene.add(pinMesh);
          pinnedRingMeshRef.current = pinMesh;
        }
      }

      // 5. Resolved wikilink connection filaments
      if (nonSelf.length > 0) {
        const edgeGeo = new THREE.BufferGeometry();
        edgeGeo.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(nonSelf.length * 6), 3).setUsage(THREE.DynamicDrawUsage),
        );
        edgeGeo.setAttribute(
          "color",
          new THREE.BufferAttribute(new Float32Array(nonSelf.length * 6), 3),
        );
        const edgeMat = new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: settingsRef.current.connectionOpacity,
          depthWrite: false,
        });
        const edgeLines = new THREE.LineSegments(edgeGeo, edgeMat);
        edgeLines.frustumCulled = false;
        scene.add(edgeLines);
        baseEdgeLinesRef.current = edgeLines;
      }

      syncVisualBuffers();
      if (vaultChanged) {
        framedVaultIdRef.current = vaultId;
        frameVault(true);
      } else {
        scheduleRender();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vaultId, vaultName, nodes, edges, settings.clusterSpacing]);

    // Update selection & system focus cleanly without rebuilding geometry.
    useEffect(() => {
      selectedIdRef.current = selectedNodeId;
      syncVisualBuffers();
      scheduleRender();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedNodeId, focusedSystemKey]);

    return (
      <div
        className={`pb-universe-canvas-wrap pb-universe-orbital-canvas ${isDarkTheme ? "is-dark" : "is-light"}`}
        ref={containerRef}
        aria-label="3D Orbital Knowledge Universe Canvas"
      >
        <div className="pb-universe-labels" aria-hidden="true">
          {labels.map((lbl) => (
            <div
              key={lbl.id}
              className={`pb-universe-label ${
                lbl.kind === "system" || lbl.kind === "core"
                  ? "is-cluster"
                  : ""
              } ${lbl.kind === "core" ? "is-vault-core" : ""} ${
                lbl.isSelected ? "is-selected" : ""
              } ${lbl.isHovered ? "is-hovered" : ""} ${
                lbl.isNeighbor ? "is-neighbor" : ""
              } ${lbl.isMatched ? "is-matched" : ""}`}
              style={{
                transform:
                  lbl.kind === "system" || lbl.kind === "core"
                    ? `translate(calc(${lbl.x}px - 50%), calc(${lbl.y}px - 50%))`
                    : lbl.alignLeft
                      ? `translate(calc(${lbl.x - 10}px - 100%), ${lbl.y - 10}px)`
                      : `translate(${lbl.x + 10}px, ${lbl.y - 10}px)`,
              }}
            >
              <span
                className="pb-universe-label-dot"
                style={{ backgroundColor: lbl.color }}
              />
              <span className="pb-universe-label-text">{lbl.title}</span>
              {lbl.isPinned ? (
                <span className="pb-universe-label-pin" title="Pinned">
                  <Pin size={10} />
                </span>
              ) : null}
              {typeof lbl.count === "number" ? (
                <span className="pb-universe-label-count">{lbl.count}</span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    );
  },
);
