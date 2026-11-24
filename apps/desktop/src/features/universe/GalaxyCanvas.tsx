import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
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
import {
  createUniverseLayout,
  type ClusterBound,
  type LayoutSimulation,
  type Vec3,
} from "./layout3d";

export type SemanticZoomLevel = 1 | 2 | 3 | 4;

export interface GalaxyCanvasHandle {
  resetCamera: () => void;
  fitAll: () => void;
  focusNode: (nodeId: string) => void;
  focusCluster: (clusterKey: string) => void;
}

interface GalaxyCanvasProps {
  vaultId: string;
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
  selectedNodeId: string | null;
  searchQuery?: string;
  settings?: UniverseSettings;
  isDarkTheme: boolean;
  reducedMotion: boolean;
  onSelectNode: (nodeId: string | null) => void;
  onZoomLevelChange?: (level: SemanticZoomLevel) => void;
  onWebGlUnavailable: (reason: string) => void;
}

export interface OverlayLabel {
  id: string;
  title: string;
  kind: "node" | "cluster";
  x: number;
  y: number;
  isSelected: boolean;
  isHovered: boolean;
  isNeighbor: boolean;
  isMatched: boolean;
  color: string;
  count?: number;
}

const STAR_VERTEX_SHADER = `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aState;

  uniform float uPixelRatio;
  uniform float uSizeScale;
  uniform float uMaxPointSize;

  varying vec3 vColor;
  varying float vSize;
  varying float vState;
  varying float vDepthFade;

  void main() {
    vColor = aColor;
    vSize = aSize;
    vState = aState;

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float dist = max(12.0, -mvPosition.z);
    float stateBoost = aState > 1.25 ? 1.32 : (aState < 0.35 ? 0.76 : 1.0);
    float rawSize = aSize * 3.1 * stateBoost * uSizeScale * (210.0 / dist) * uPixelRatio;
    gl_PointSize = clamp(rawSize, 4.0 * uPixelRatio, uMaxPointSize * uPixelRatio);
    vDepthFade = clamp(1.16 - dist / 1450.0, 0.34, 1.0);

    gl_Position = projectionMatrix * mvPosition;
  }
`;

const STAR_FRAGMENT_SHADER = `
  uniform float uLightMode;
  uniform float uReducedEffects;

  varying vec3 vColor;
  varying float vSize;
  varying float vState;
  varying float vDepthFade;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv) * 2.0;
    if (d > 1.0) discard;

    float dimFactor = vState < 0.35 ? 0.22 : 1.0;

    if (uLightMode < 0.5) {
      float core = smoothstep(0.28, 0.04, d);
      float corona = exp(-d * d * 13.0) * 0.85;
      float halo = exp(-d * d * 4.5) * 0.42;
      float spike = 0.0;
      if (uReducedEffects < 0.5 && (vSize > 1.65 || vState > 1.25)) {
        float hAxis = exp(-abs(uv.y) * 34.0) * exp(-abs(uv.x) * 6.5);
        float vAxis = exp(-abs(uv.x) * 34.0) * exp(-abs(uv.y) * 6.5);
        spike = (hAxis + vAxis) * 0.36;
      }
      vec3 coreColor = mix(vColor, vec3(1.0, 0.99, 0.97), 0.72);
      vec3 rgb = mix(vColor, coreColor, clamp(core + spike * 0.5, 0.0, 1.0));
      float alpha = clamp((core + corona + halo + spike) * dimFactor * vDepthFade, 0.0, 1.0);
      gl_FragColor = vec4(rgb * alpha, alpha);
    } else {
      float disc = smoothstep(0.42, 0.14, d);
      float halo = exp(-d * d * 6.5) * 0.35;
      vec3 coreColor = mix(vColor, vec3(0.08, 0.12, 0.22), 0.18);
      vec3 rgb = mix(vColor, coreColor, disc * 0.5);
      float alpha = clamp((disc * 0.94 + halo) * dimFactor * vDepthFade, 0.0, 1.0);
      gl_FragColor = vec4(rgb, alpha);
    }
  }
`;

const LABEL_BUDGET: Record<LabelDensity, number> = {
  low: 10,
  medium: 22,
  high: 34,
};

function deterministicColorShift(seedStr: string, baseHex: string, target: THREE.Color) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i += 1) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const unit = ((h >>> 0) % 1000) / 1000 - 0.5;
  target.set(baseHex);
  target.offsetHSL(unit * 0.03, unit * 0.06, unit * 0.06);
}

function buildBackgroundStarfield(isDarkTheme: boolean): THREE.Points {
  const count = 620;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color();

  for (let i = 0; i < count; i += 1) {
    // Deterministic Fibonacci sphere shell at distant cosmos perimeter.
    const t = (i + 0.5) / count;
    const phi = Math.acos(1 - 2 * t);
    const theta = i * 2.399963229728653;
    const r = 820 + ((i * 197) % 580);
    positions[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
    positions[i * 3 + 1] = Math.cos(phi) * r * 0.72;
    positions[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r;

    const tint = (i % 5) / 5;
    if (isDarkTheme) {
      c.setHSL(0.58 + tint * 0.08, 0.35, 0.55 + (i % 3) * 0.12);
    } else {
      c.setHSL(0.6 + tint * 0.05, 0.25, 0.55);
    }
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size: isDarkTheme ? 1.8 : 1.5,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: isDarkTheme ? 0.34 : 0.22,
    depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.name = "decorative-starfield";
  pts.frustumCulled = false;
  return pts;
}

export interface LabelProjectionParams {
  nodes: GraphNodeModel[];
  clusterBounds: ClusterBound[];
  positions: Map<string, Vec3>;
  camera: THREE.Camera;
  width: number;
  height: number;
  cameraDistance: number;
  boundingRadius: number;
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  neighborIds: Set<string>;
  searchQuery: string;
  labelDensity: LabelDensity;
  isDarkTheme: boolean;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function boxesOverlap(a: Box, b: Box, pad: number): boolean {
  return !(
    a.right + pad < b.left ||
    a.left - pad > b.right ||
    a.bottom + pad < b.top ||
    a.top - pad > b.bottom
  );
}

/**
 * Computes semantic zoom tier (1..4) and collision-free screen-space labels.
 * Exported so unit tests can deterministically validate priority ordering and overlap rejection.
 */
export function computeVisibleLabels(params: LabelProjectionParams): {
  zoomLevel: SemanticZoomLevel;
  labels: OverlayLabel[];
} {
  const {
    nodes,
    clusterBounds,
    positions,
    camera,
    width,
    height,
    cameraDistance,
    boundingRadius,
    selectedNodeId,
    hoveredNodeId,
    neighborIds,
    searchQuery,
    labelDensity,
    isDarkTheme,
  } = params;

  const safeRadius = Math.max(boundingRadius, 36);
  const ratio = cameraDistance / safeRadius;
  const zoomLevel: SemanticZoomLevel = selectedNodeId
    ? 4
    : ratio <= 0.85
      ? 3
      : ratio <= 1.55
        ? 2
        : 1;

  if (width <= 0 || height <= 0 || nodes.length === 0) {
    return { zoomLevel, labels: [] };
  }

  const palette = isDarkTheme ? CLUSTER_PALETTE : CLUSTER_PALETTE_LIGHT;
  const q = searchQuery.trim().toLowerCase();
  const maxLabels = LABEL_BUDGET[labelDensity];
  const maxArea = width * height * 0.14;
  const proj = new THREE.Vector3();

  interface Candidate {
    label: OverlayLabel;
    priority: number;
    box: Box;
  }

  const candidates: Candidate[] = [];

  // 1. Cluster labels (dominant in Level 1 Overview & Level 2 Galaxy Exploration)
  if (zoomLevel <= 3 && clusterBounds.length > 0) {
    for (const bound of clusterBounds) {
      proj.set(bound.center.x, bound.center.y, bound.center.z).project(camera);
      if (proj.z < -1 || proj.z > 1) continue;
      const sx = Math.round((proj.x * 0.5 + 0.5) * width);
      const sy = Math.round((-proj.y * 0.5 + 0.5) * height);
      if (sx < 60 || sx > width - 60 || sy < 62 || sy > height - 58) continue;

      const textWidth = Math.min(188, Math.max(66, bound.label.length * 7.2 + 34));
      const box: Box = {
        left: sx - textWidth / 2,
        right: sx + textWidth / 2,
        top: sy - 13,
        bottom: sy + 13,
      };
      const basePrio =
        zoomLevel === 1 ? 620 : zoomLevel === 2 ? 460 : 125;
      candidates.push({
        priority: basePrio + Math.min(80, bound.count * 0.5),
        box,
        label: {
          id: `cluster:${bound.key}`,
          title: bound.label,
          kind: "cluster",
          x: sx,
          y: sy,
          isSelected: false,
          isHovered: false,
          isNeighbor: false,
          isMatched: false,
          color: palette[bound.colorIndex % palette.length] ?? "#60a5fa",
          count: bound.count,
        },
      });
    }
  }

  // 2. Star labels gated by semantic zoom & priority
  for (const node of nodes) {
    const isSelected = node.id === selectedNodeId;
    const isHovered = node.id === hoveredNodeId;
    const isNeighbor = neighborIds.has(node.id) && !isSelected;
    const isMatched =
      q.length > 0 &&
      (node.title.toLowerCase().includes(q) ||
        node.relPath.toLowerCase().includes(q));

    // In Level 1 Overview, only surface selected/hovered/search matches or top hubs.
    if (
      zoomLevel === 1 &&
      !isSelected &&
      !isHovered &&
      !isMatched &&
      node.importance < 1.75
    ) {
      continue;
    }

    const p = positions.get(node.id);
    if (!p) continue;
    proj.set(p.x, p.y, p.z).project(camera);
    if (proj.z < -1 || proj.z > 1) continue;
    const sx = Math.round((proj.x * 0.5 + 0.5) * width);
    const sy = Math.round((-proj.y * 0.5 + 0.5) * height);
    if (sx < 24 || sx > width - 80 || sy < 56 || sy > height - 56) continue;

    let priority: number;
    if (isSelected) priority = 1000;
    else if (isHovered) priority = 900;
    else if (isMatched) priority = 760 + node.importance * 20;
    else if (isNeighbor) priority = 680 + node.importance * 20;
    else if (zoomLevel === 1) priority = 220 + node.importance * 40;
    else if (zoomLevel === 2) priority = 280 + node.importance * 45;
    else priority = 340 + node.importance * 50 + (1 - proj.z) * 25;

    const textWidth = Math.min(168, Math.max(48, node.title.length * 6.8 + 18));
    const box: Box = {
      left: sx + 10,
      right: sx + 10 + textWidth,
      top: sy - 11,
      bottom: sy + 11,
    };

    candidates.push({
      priority,
      box,
      label: {
        id: node.id,
        title: node.title,
        kind: "node",
        x: sx,
        y: sy,
        isSelected,
        isHovered,
        isNeighbor,
        isMatched,
        color: palette[node.clusterColorIndex % palette.length] ?? "#60a5fa",
      },
    });
  }

  candidates.sort((a, b) => b.priority - a.priority);

  const accepted: OverlayLabel[] = [];
  const placedBoxes: Box[] = [];
  let usedArea = 0;

  for (const cand of candidates) {
    if (accepted.length >= maxLabels) break;
    const boxArea =
      (cand.box.right - cand.box.left) * (cand.box.bottom - cand.box.top);
    // Always keep selected & hovered stars; apply collision & area budget to others.
    const forceKeep = cand.label.isSelected || cand.label.isHovered;
    if (!forceKeep) {
      if (usedArea + boxArea > maxArea) continue;
      let overlaps = false;
      for (const existing of placedBoxes) {
        if (boxesOverlap(cand.box, existing, 7)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
    }

    accepted.push(cand.label);
    placedBoxes.push(cand.box);
    usedArea += boxArea;
  }

  return { zoomLevel, labels: accepted };
}

export const GalaxyCanvas = forwardRef<GalaxyCanvasHandle, GalaxyCanvasProps>(
  function GalaxyCanvas(
    {
      vaultId,
      nodes,
      edges,
      selectedNodeId,
      searchQuery = "",
      settings = DEFAULT_UNIVERSE_SETTINGS,
      isDarkTheme,
      reducedMotion,
      onSelectNode,
      onZoomLevelChange,
      onWebGlUnavailable,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [labels, setLabels] = useState<OverlayLabel[]>([]);

    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const starPointsRef = useRef<THREE.Points | null>(null);
    const bgStarsRef = useRef<THREE.Points | null>(null);
    const baseLinesRef = useRef<THREE.LineSegments | null>(null);
    const focusLinesRef = useRef<THREE.LineSegments | null>(null);
    const selectionRingRef = useRef<THREE.Mesh | null>(null);
    const hoverRingRef = useRef<THREE.Mesh | null>(null);

    const nodesRef = useRef<GraphNodeModel[]>(nodes);
    const edgesRef = useRef<GraphEdgeModel[]>(edges);
    const nodeIndexByIdRef = useRef<Map<string, number>>(new Map());
    const selectedIdRef = useRef<string | null>(selectedNodeId);
    const searchQueryRef = useRef<string>(searchQuery);
    const settingsRef = useRef<UniverseSettings>(settings);
    const isDarkRef = useRef<boolean>(isDarkTheme);
    const reducedMotionRef = useRef<boolean>(reducedMotion);

    const positionsRef = useRef<Map<string, Vec3>>(new Map());
    const simRef = useRef<LayoutSimulation | null>(null);
    const framedVaultIdRef = useRef<string | null>(null);
    const hoveredIndexRef = useRef<number>(-1);
    const rafIdRef = useRef<number | null>(null);
    const lastZoomLevelRef = useRef<SemanticZoomLevel>(1);

    const flyAnimRef = useRef<{
      startTime: number;
      duration: number;
      fromCam: THREE.Vector3;
      toCam: THREE.Vector3;
      fromLook: THREE.Vector3;
      toLook: THREE.Vector3;
    } | null>(null);

    const onSelectRef = useRef(onSelectNode);
    const onZoomChangeRef = useRef(onZoomLevelChange);
    const onWebGlUnavailableRef = useRef(onWebGlUnavailable);

    useEffect(() => {
      onSelectRef.current = onSelectNode;
      onZoomChangeRef.current = onZoomLevelChange;
      onWebGlUnavailableRef.current = onWebGlUnavailable;
    }, [onSelectNode, onZoomLevelChange, onWebGlUnavailable]);

    useEffect(() => {
      searchQueryRef.current = searchQuery;
      settingsRef.current = settings;
      isDarkRef.current = isDarkTheme;
      reducedMotionRef.current = reducedMotion;
    }, [searchQuery, settings, isDarkTheme, reducedMotion]);

    function scheduleRender() {
      if (document.visibilityState === "hidden") return;
      if (rafIdRef.current === null) {
        rafIdRef.current = window.requestAnimationFrame(tickFrame);
      }
    }

    function getNeighborSet(centerId: string | null, depth: 1 | 2): {
      hop1: Set<string>;
      hop2: Set<string>;
    } {
      const hop1 = new Set<string>();
      const hop2 = new Set<string>();
      if (!centerId) return { hop1, hop2 };

      for (const e of edgesRef.current) {
        if (e.isSelfLoop) continue;
        if (e.source === centerId) hop1.add(e.target);
        if (e.target === centerId) hop1.add(e.source);
      }
      if (depth === 2 && hop1.size > 0) {
        for (const e of edgesRef.current) {
          if (e.isSelfLoop) continue;
          if (hop1.has(e.source) && e.target !== centerId && !hop1.has(e.target)) {
            hop2.add(e.target);
          }
          if (hop1.has(e.target) && e.source !== centerId && !hop1.has(e.source)) {
            hop2.add(e.source);
          }
        }
      }
      return { hop1, hop2 };
    }

    function syncVisualBuffers() {
      const starPts = starPointsRef.current;
      const baseLines = baseLinesRef.current;
      const focusLines = focusLinesRef.current;
      const sim = simRef.current;
      const curNodes = nodesRef.current;
      const curEdges = edgesRef.current;
      if (!starPts || !sim) return;

      const selId = selectedIdRef.current;
      const hovNode =
        hoveredIndexRef.current >= 0
          ? curNodes[hoveredIndexRef.current]
          : undefined;
      const activeFocusId = selId ?? hovNode?.id ?? null;
      const { hop1, hop2 } = getNeighborSet(
        activeFocusId,
        settingsRef.current.focusDepth,
      );

      const posAttr = starPts.geometry.getAttribute(
        "position",
      ) as THREE.BufferAttribute;
      const stateAttr = starPts.geometry.getAttribute(
        "aState",
      ) as THREE.BufferAttribute;
      const posArr = posAttr.array as Float32Array;
      const stateArr = stateAttr.array as Float32Array;

      for (let i = 0; i < curNodes.length; i += 1) {
        const node = curNodes[i]!;
        const p = sim.positions.get(node.id) ?? { x: 0, y: 0, z: 0 };
        posArr[i * 3] = p.x;
        posArr[i * 3 + 1] = p.y;
        posArr[i * 3 + 2] = p.z;

        let stateVal = 1.0;
        if (node.id === selId) {
          stateVal = 1.6;
        } else if (i === hoveredIndexRef.current) {
          stateVal = 1.38;
        } else if (activeFocusId) {
          if (hop1.has(node.id)) stateVal = 1.2;
          else if (hop2.has(node.id)) stateVal = 0.9;
          else stateVal = 0.18;
        }
        stateArr[i] = stateVal;
      }
      posAttr.needsUpdate = true;
      stateAttr.needsUpdate = true;
      starPts.geometry.computeBoundingSphere();

      if (selectionRingRef.current) {
        const selPos = selId ? sim.positions.get(selId) : undefined;
        if (selPos) {
          selectionRingRef.current.visible = true;
          selectionRingRef.current.position.set(selPos.x, selPos.y, selPos.z);
        } else {
          selectionRingRef.current.visible = false;
        }
      }

      if (hoverRingRef.current) {
        const hovPos =
          hovNode && hovNode.id !== selId
            ? sim.positions.get(hovNode.id)
            : undefined;
        if (hovPos) {
          hoverRingRef.current.visible = true;
          hoverRingRef.current.position.set(hovPos.x, hovPos.y, hovPos.z);
        } else {
          hoverRingRef.current.visible = false;
        }
      }

      const palette = isDarkRef.current
        ? CLUSTER_PALETTE
        : CLUSTER_PALETTE_LIGHT;

      if (baseLines) {
        const nonSelf = curEdges.filter((e) => !e.isSelfLoop);
        const linePos = baseLines.geometry.getAttribute(
          "position",
        ) as THREE.BufferAttribute;
        const lineCol = baseLines.geometry.getAttribute(
          "color",
        ) as THREE.BufferAttribute;
        const pArr = linePos.array as Float32Array;
        const cArr = lineCol.array as Float32Array;
        const nodeIdx = nodeIndexByIdRef.current;
        const ca = new THREE.Color();
        const cb = new THREE.Color();

        let pPtr = 0;
        let cPtr = 0;
        for (const edge of nonSelf) {
          const pa = sim.positions.get(edge.source);
          const pb = sim.positions.get(edge.target);
          if (!pa || !pb) {
            for (let k = 0; k < 6; k += 1) {
              pArr[pPtr++] = 0;
              cArr[cPtr++] = 0;
            }
            continue;
          }
          pArr[pPtr++] = pa.x;
          pArr[pPtr++] = pa.y;
          pArr[pPtr++] = pa.z;
          pArr[pPtr++] = pb.x;
          pArr[pPtr++] = pb.y;
          pArr[pPtr++] = pb.z;

          const na = curNodes[nodeIdx.get(edge.source) ?? 0];
          const nb = curNodes[nodeIdx.get(edge.target) ?? 0];
          ca.set(
            palette[(na?.clusterColorIndex ?? 0) % palette.length] ?? "#60a5fa",
          );
          cb.set(
            palette[(nb?.clusterColorIndex ?? 0) % palette.length] ?? "#60a5fa",
          );
          cArr[cPtr++] = ca.r;
          cArr[cPtr++] = ca.g;
          cArr[cPtr++] = ca.b;
          cArr[cPtr++] = cb.r;
          cArr[cPtr++] = cb.g;
          cArr[cPtr++] = cb.b;
        }
        linePos.needsUpdate = true;
        lineCol.needsUpdate = true;
        baseLines.geometry.computeBoundingSphere();

        const baseMat = baseLines.material as THREE.LineBasicMaterial;
        baseMat.opacity = activeFocusId
          ? Math.min(0.08, settingsRef.current.connectionOpacity * 0.25)
          : settingsRef.current.connectionOpacity;
      }

      // Highlighted semantic focus edges (outgoing = cyan/blue, incoming = amber, 2-hop = slate/violet)
      if (focusLines) {
        if (!activeFocusId) {
          focusLines.visible = false;
        } else {
          const focusVerts: number[] = [];
          const focusCols: number[] = [];
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
            if (edge.isSelfLoop) continue;
            const pa = sim.positions.get(edge.source);
            const pb = sim.positions.get(edge.target);
            if (!pa || !pb) continue;

            let col: THREE.Color | null = null;
            if (edge.source === activeFocusId) {
              col = outCol;
            } else if (edge.target === activeFocusId) {
              col = inCol;
            } else if (
              settingsRef.current.focusDepth === 2 &&
              ((hop1.has(edge.source) && hop2.has(edge.target)) ||
                (hop1.has(edge.target) && hop2.has(edge.source)))
            ) {
              col = hop2Col;
            }

            if (col) {
              focusVerts.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
              focusCols.push(col.r, col.g, col.b, col.r, col.g, col.b);
            }
          }

          focusLines.geometry.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(focusVerts, 3),
          );
          focusLines.geometry.setAttribute(
            "color",
            new THREE.Float32BufferAttribute(focusCols, 3),
          );
          focusLines.geometry.computeBoundingSphere();
          focusLines.visible = focusVerts.length > 0;
        }
      }
    }

    function projectOverlayLabels() {
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      const container = containerRef.current;
      const sim = simRef.current;
      if (!camera || !controls || !container || !sim) {
        setLabels([]);
        return;
      }

      const selId = selectedIdRef.current;
      const hovId =
        hoveredIndexRef.current >= 0
          ? (nodesRef.current[hoveredIndexRef.current]?.id ?? null)
          : null;
      const { hop1 } = getNeighborSet(selId, 1);

      const camDist = camera.position.distanceTo(controls.target);
      const { zoomLevel, labels: nextLabels } = computeVisibleLabels({
        nodes: nodesRef.current,
        clusterBounds: sim.clusterBounds,
        positions: sim.positions,
        camera,
        width: container.clientWidth,
        height: container.clientHeight,
        cameraDistance: camDist,
        boundingRadius: sim.boundingRadius,
        selectedNodeId: selId,
        hoveredNodeId: hovId,
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

    function fitPoints(points: Vec3[], instant = false) {
      if (points.length === 0) {
        startCameraMove(
          new THREE.Vector3(0, 75, 150),
          new THREE.Vector3(0, 0, 0),
          instant,
        );
        return;
      }

      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.z < minZ) minZ = p.z;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
        if (p.z > maxZ) maxZ = p.z;
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const cz = (minZ + maxZ) / 2;
      const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 38);
      const dist = span * 0.98;

      const lookVec = new THREE.Vector3(cx, cy, cz);
      const camVec = new THREE.Vector3(
        cx + dist * 0.22,
        cy + dist * 0.42,
        cz + dist * 0.88,
      );
      startCameraMove(camVec, lookVec, instant);
    }

    function tickFrame() {
      rafIdRef.current = null;
      if (document.visibilityState === "hidden") return;

      const renderer = rendererRef.current;
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      const sim = simRef.current;
      if (!renderer || !scene || !camera || !controls) return;

      let keepAnimating = false;

      if (sim && !sim.settled) {
        const active = sim.step();
        syncVisualBuffers();
        if (active) keepAnimating = true;
      }

      if (flyAnimRef.current) {
        const anim = flyAnimRef.current;
        const t = Math.min(
          1,
          (performance.now() - anim.startTime) / anim.duration,
        );
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

      // Billboard selection/hover reticles so rings always face the camera cleanly.
      if (selectionRingRef.current && selectionRingRef.current.visible) {
        selectionRingRef.current.quaternion.copy(camera.quaternion);
      }
      if (hoverRingRef.current && hoverRingRef.current.visible) {
        hoverRingRef.current.quaternion.copy(camera.quaternion);
      }

      renderer.render(scene, camera);
      projectOverlayLabels();

      if (keepAnimating) {
        scheduleRender();
      }
    }

    useImperativeHandle(
      ref,
      () => ({
        resetCamera() {
          fitPoints(Array.from(positionsRef.current.values()));
        },
        fitAll() {
          fitPoints(Array.from(positionsRef.current.values()));
        },
        focusNode(nodeId: string) {
          const pos = positionsRef.current.get(nodeId);
          if (!pos) return;
          const lookVec = new THREE.Vector3(pos.x, pos.y, pos.z);
          const camVec = new THREE.Vector3(
            pos.x + 22,
            pos.y + 18,
            pos.z + 46,
          );
          startCameraMove(camVec, lookVec);
        },
        focusCluster(clusterKey: string) {
          const pts: Vec3[] = [];
          for (const node of nodesRef.current) {
            if (node.clusterKey === clusterKey) {
              const p = positionsRef.current.get(node.id);
              if (p) pts.push(p);
            }
          }
          if (pts.length > 0) fitPoints(pts);
        },
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );

    // Mount WebGLRenderer + OrbitControls + listeners once.
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
      const camera = new THREE.PerspectiveCamera(46, width / height, 0.5, 4200);
      camera.position.set(28, 82, 165);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = !reducedMotionRef.current;
      controls.dampingFactor = 0.085;
      controls.zoomToCursor = true;
      controls.minDistance = 12;
      controls.maxDistance = 1800;

      const selRingGeo = new THREE.RingGeometry(2.6, 3.25, 32);
      const selRingMat = new THREE.MeshBasicMaterial({
        color: isDarkRef.current ? 0x60a5fa : 0x2563eb,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      });
      const selRing = new THREE.Mesh(selRingGeo, selRingMat);
      selRing.visible = false;
      scene.add(selRing);

      const hovRingGeo = new THREE.RingGeometry(2.1, 2.55, 24);
      const hovRingMat = new THREE.MeshBasicMaterial({
        color: isDarkRef.current ? 0xe2e8f0 : 0x334155,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      });
      const hovRing = new THREE.Mesh(hovRingGeo, hovRingMat);
      hovRing.visible = false;
      scene.add(hovRing);

      const bgStars = buildBackgroundStarfield(isDarkRef.current);
      bgStars.visible = !settingsRef.current.reducedEffects;
      scene.add(bgStars);

      const focusGeo = new THREE.BufferGeometry();
      const focusMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: isDarkRef.current ? 0.85 : 0.78,
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
      selectionRingRef.current = selRing;
      hoverRingRef.current = hovRing;
      bgStarsRef.current = bgStars;
      focusLinesRef.current = focusLines;

      const onControlsChange = () => {
        scheduleRender();
      };
      controls.addEventListener("change", onControlsChange);

      const projVec = new THREE.Vector3();
      let downX = 0;
      let downY = 0;

      const pickNodeIndex = (clientX: number, clientY: number): number => {
        const sim = simRef.current;
        const curNodes = nodesRef.current;
        if (!sim || curNodes.length === 0) return -1;
        const rect = renderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return -1;

        const px = clientX - rect.left;
        const py = clientY - rect.top;
        const hitRadiusSq = 15 * 15;
        let bestIdx = -1;
        let bestScore = Infinity;

        for (let i = 0; i < curNodes.length; i += 1) {
          const node = curNodes[i]!;
          const p = sim.positions.get(node.id);
          if (!p) continue;
          projVec.set(p.x, p.y, p.z).project(camera);
          if (projVec.z < -1 || projVec.z > 1) continue;
          const sx = (projVec.x * 0.5 + 0.5) * rect.width;
          const sy = (-projVec.y * 0.5 + 0.5) * rect.height;
          const distSq = (sx - px) * (sx - px) + (sy - py) * (sy - py);
          const radiusScale = Math.max(1, node.importance * 0.75);
          if (distSq <= hitRadiusSq * radiusScale) {
            const score = distSq + projVec.z * 8;
            if (score < bestScore) {
              bestScore = score;
              bestIdx = i;
            }
          }
        }
        return bestIdx;
      };

      const onPointerDown = (ev: PointerEvent) => {
        downX = ev.clientX;
        downY = ev.clientY;
        flyAnimRef.current = null;
      };

      const onWheel = () => {
        flyAnimRef.current = null;
      };

      const onPointerMove = (ev: PointerEvent) => {
        const picked = pickNodeIndex(ev.clientX, ev.clientY);
        if (picked !== hoveredIndexRef.current) {
          hoveredIndexRef.current = picked;
          renderer.domElement.style.cursor = picked >= 0 ? "pointer" : "grab";
          syncVisualBuffers();
          scheduleRender();
        }
      };

      const onPointerUp = (ev: PointerEvent) => {
        const moved = Math.hypot(ev.clientX - downX, ev.clientY - downY);
        if (moved > 5) return;
        const picked = pickNodeIndex(ev.clientX, ev.clientY);
        const targetNode = picked >= 0 ? nodesRef.current[picked] : undefined;
        onSelectRef.current(targetNode ? targetNode.id : null);
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
        scheduleRender();
      });
      resizeObserver.observe(container);

      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      renderer.domElement.addEventListener("wheel", onWheel, { passive: true });
      renderer.domElement.addEventListener("pointermove", onPointerMove);
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
        renderer.domElement.removeEventListener("pointerup", onPointerUp);
        renderer.domElement.removeEventListener(
          "webglcontextlost",
          onContextLost,
        );
        document.removeEventListener("visibilitychange", onVisibilityChange);

        if (starPointsRef.current) {
          scene.remove(starPointsRef.current);
          starPointsRef.current.geometry.dispose();
          (starPointsRef.current.material as THREE.Material).dispose();
          starPointsRef.current = null;
        }
        if (bgStarsRef.current) {
          scene.remove(bgStarsRef.current);
          bgStarsRef.current.geometry.dispose();
          (bgStarsRef.current.material as THREE.Material).dispose();
          bgStarsRef.current = null;
        }
        if (baseLinesRef.current) {
          scene.remove(baseLinesRef.current);
          baseLinesRef.current.geometry.dispose();
          (baseLinesRef.current.material as THREE.Material).dispose();
          baseLinesRef.current = null;
        }
        if (focusLinesRef.current) {
          scene.remove(focusLinesRef.current);
          focusLinesRef.current.geometry.dispose();
          (focusLinesRef.current.material as THREE.Material).dispose();
          focusLinesRef.current = null;
        }
        selRingGeo.dispose();
        selRingMat.dispose();
        hovRingGeo.dispose();
        hovRingMat.dispose();
        controls.dispose();
        renderer.dispose();
        if (renderer.domElement.parentNode === container) {
          container.removeChild(renderer.domElement);
        }

        sceneRef.current = null;
        cameraRef.current = null;
        controlsRef.current = null;
        rendererRef.current = null;
        selectionRingRef.current = null;
        hoverRingRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Synchronize theme, reducedMotion, and visual settings without destroying WebGL context.
    useEffect(() => {
      const scene = sceneRef.current;
      const controls = controlsRef.current;
      const ring = selectionRingRef.current;
      const hRing = hoverRingRef.current;
      if (!scene) return;

      if (ring) {
        (ring.material as THREE.MeshBasicMaterial).color.setHex(
          isDarkTheme ? 0x60a5fa : 0x2563eb,
        );
      }
      if (hRing) {
        (hRing.material as THREE.MeshBasicMaterial).color.setHex(
          isDarkTheme ? 0xe2e8f0 : 0x334155,
        );
      }
      if (controls) {
        controls.enableDamping = !reducedMotion;
      }
      if (bgStarsRef.current) {
        bgStarsRef.current.visible = !settings.reducedEffects;
        const mat = bgStarsRef.current.material as THREE.PointsMaterial;
        mat.opacity = isDarkTheme ? 0.34 : 0.22;
      }
      if (starPointsRef.current) {
        const mat = starPointsRef.current.material as THREE.ShaderMaterial;
        mat.uniforms.uSizeScale!.value = settings.starSize;
        mat.uniforms.uLightMode!.value = isDarkTheme ? 0.0 : 1.0;
        mat.uniforms.uReducedEffects!.value = settings.reducedEffects ? 1.0 : 0.0;
        mat.blending = isDarkTheme
          ? THREE.AdditiveBlending
          : THREE.NormalBlending;
        mat.needsUpdate = true;

        // Recompute node colors for dark/light palette contrast.
        const colAttr = starPointsRef.current.geometry.getAttribute(
          "aColor",
        ) as THREE.BufferAttribute;
        const cArr = colAttr.array as Float32Array;
        const palette = isDarkTheme ? CLUSTER_PALETTE : CLUSTER_PALETTE_LIGHT;
        const tmpColor = new THREE.Color();
        nodesRef.current.forEach((node, idx) => {
          const hex =
            palette[node.clusterColorIndex % palette.length] ?? "#60a5fa";
          deterministicColorShift(node.id, hex, tmpColor);
          cArr[idx * 3] = tmpColor.r;
          cArr[idx * 3 + 1] = tmpColor.g;
          cArr[idx * 3 + 2] = tmpColor.b;
        });
        colAttr.needsUpdate = true;
      }
      if (focusLinesRef.current) {
        (focusLinesRef.current.material as THREE.LineBasicMaterial).opacity =
          isDarkTheme ? 0.85 : 0.78;
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
      settings.focusDepth,
      settings.reducedEffects,
      searchQuery,
    ]);

    // Synchronize normalized graph nodes/edges + clusterSpacing into layout & GPU point/line buffers.
    useEffect(() => {
      const scene = sceneRef.current;
      if (!scene) return;

      const vaultChanged = framedVaultIdRef.current !== vaultId;
      if (vaultChanged) {
        positionsRef.current = new Map();
      }

      nodesRef.current = nodes;
      edgesRef.current = edges;
      nodeIndexByIdRef.current = new Map(nodes.map((n, idx) => [n.id, idx]));
      hoveredIndexRef.current = -1;

      if (starPointsRef.current) {
        scene.remove(starPointsRef.current);
        starPointsRef.current.geometry.dispose();
        (starPointsRef.current.material as THREE.Material).dispose();
        starPointsRef.current = null;
      }
      if (baseLinesRef.current) {
        scene.remove(baseLinesRef.current);
        baseLinesRef.current.geometry.dispose();
        (baseLinesRef.current.material as THREE.Material).dispose();
        baseLinesRef.current = null;
      }

      const sim = createUniverseLayout(
        nodes,
        edges,
        positionsRef.current,
        reducedMotion,
        settings.clusterSpacing,
      );
      simRef.current = sim;
      positionsRef.current = sim.positions;

      if (nodes.length > 0) {
        const starGeo = new THREE.BufferGeometry();
        const posArr = new Float32Array(nodes.length * 3);
        const colArr = new Float32Array(nodes.length * 3);
        const sizeArr = new Float32Array(nodes.length);
        const stateArr = new Float32Array(nodes.length);
        const palette = isDarkRef.current
          ? CLUSTER_PALETTE
          : CLUSTER_PALETTE_LIGHT;
        const color = new THREE.Color();

        nodes.forEach((node, idx) => {
          const hex =
            palette[node.clusterColorIndex % palette.length] ?? "#60a5fa";
          deterministicColorShift(node.id, hex, color);
          colArr[idx * 3] = color.r;
          colArr[idx * 3 + 1] = color.g;
          colArr[idx * 3 + 2] = color.b;
          sizeArr[idx] = node.importance;
          stateArr[idx] = 1.0;
        });

        starGeo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
        starGeo.setAttribute("aColor", new THREE.BufferAttribute(colArr, 3));
        starGeo.setAttribute("aSize", new THREE.BufferAttribute(sizeArr, 1));
        starGeo.setAttribute("aState", new THREE.BufferAttribute(stateArr, 1));

        const starMat = new THREE.ShaderMaterial({
          vertexShader: STAR_VERTEX_SHADER,
          fragmentShader: STAR_FRAGMENT_SHADER,
          uniforms: {
            uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
            uSizeScale: { value: settingsRef.current.starSize },
            uLightMode: { value: isDarkRef.current ? 0.0 : 1.0 },
            uReducedEffects: {
              value: settingsRef.current.reducedEffects ? 1.0 : 0.0,
            },
            uMaxPointSize: { value: 44.0 },
          },
          transparent: true,
          depthWrite: false,
          blending: isDarkRef.current
            ? THREE.AdditiveBlending
            : THREE.NormalBlending,
        });

        const points = new THREE.Points(starGeo, starMat);
        points.frustumCulled = false;
        scene.add(points);
        starPointsRef.current = points;
      }

      const nonSelf = edges.filter((e) => !e.isSelfLoop);
      if (nonSelf.length > 0) {
        const lineGeo = new THREE.BufferGeometry();
        const vertices = new Float32Array(nonSelf.length * 6);
        const colors = new Float32Array(nonSelf.length * 6);
        lineGeo.setAttribute(
          "position",
          new THREE.BufferAttribute(vertices, 3),
        );
        lineGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        const lineMat = new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: settingsRef.current.connectionOpacity,
          depthWrite: false,
        });
        const lineSegments = new THREE.LineSegments(lineGeo, lineMat);
        lineSegments.frustumCulled = false;
        scene.add(lineSegments);
        baseLinesRef.current = lineSegments;
      }

      syncVisualBuffers();
      if (vaultChanged && nodes.length > 0) {
        framedVaultIdRef.current = vaultId;
        fitPoints(Array.from(sim.positions.values()), true);
      } else {
        scheduleRender();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vaultId, nodes, edges, reducedMotion, settings.clusterSpacing]);

    // Update selection emphasis cleanly without re-creating geometry or layout.
    useEffect(() => {
      selectedIdRef.current = selectedNodeId;
      syncVisualBuffers();
      scheduleRender();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedNodeId]);

    return (
      <div
        className={`pb-universe-canvas-wrap ${isDarkTheme ? "is-dark" : "is-light"}`}
        ref={containerRef}
        aria-label="3D Knowledge Universe Canvas"
      >
        <div className="pb-universe-labels" aria-hidden="true">
          {labels.map((lbl) => (
            <div
              key={lbl.id}
              className={`pb-universe-label ${
                lbl.kind === "cluster" ? "is-cluster" : ""
              } ${lbl.isSelected ? "is-selected" : ""} ${
                lbl.isHovered ? "is-hovered" : ""
              } ${lbl.isNeighbor ? "is-neighbor" : ""} ${
                lbl.isMatched ? "is-matched" : ""
              }`}
              style={{
                transform:
                  lbl.kind === "cluster"
                    ? `translate(calc(${lbl.x}px - 50%), calc(${lbl.y}px - 50%))`
                    : `translate(${lbl.x + 10}px, ${lbl.y - 10}px)`,
              }}
            >
              <span
                className="pb-universe-label-dot"
                style={{ backgroundColor: lbl.color }}
              />
              <span className="pb-universe-label-text">{lbl.title}</span>
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
