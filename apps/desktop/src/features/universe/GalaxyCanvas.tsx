import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  CLUSTER_PALETTE,
  type GraphEdgeModel,
  type GraphNodeModel,
} from "./graphModel";
import { createUniverseLayout, type LayoutSimulation, type Vec3 } from "./layout3d";

export interface GalaxyCanvasHandle {
  resetCamera: () => void;
  fitAll: () => void;
  focusNode: (nodeId: string) => void;
  focusCluster: (clusterKey: string) => void;
}

interface GalaxyCanvasProps {
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
  selectedNodeId: string | null;
  isDarkTheme: boolean;
  reducedMotion: boolean;
  onSelectNode: (nodeId: string | null) => void;
  onWebGlUnavailable: (reason: string) => void;
}

interface OverlayLabel {
  id: string;
  title: string;
  x: number;
  y: number;
  isSelected: boolean;
}

const MAX_OVERLAY_LABELS = 24;

export const GalaxyCanvas = forwardRef<GalaxyCanvasHandle, GalaxyCanvasProps>(
  function GalaxyCanvas(
    {
      nodes,
      edges,
      selectedNodeId,
      isDarkTheme,
      reducedMotion,
      onSelectNode,
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
    const starMeshRef = useRef<THREE.InstancedMesh | null>(null);
    const lineMeshRef = useRef<THREE.LineSegments | null>(null);
    const selectionRingRef = useRef<THREE.Mesh | null>(null);

    const nodesRef = useRef<GraphNodeModel[]>(nodes);
    const edgesRef = useRef<GraphEdgeModel[]>(edges);
    const selectedIdRef = useRef<string | null>(selectedNodeId);
    const positionsRef = useRef<Map<string, Vec3>>(new Map());
    const simRef = useRef<LayoutSimulation | null>(null);
    const hoveredIndexRef = useRef<number>(-1);
    const rafIdRef = useRef<number | null>(null);
    const needsRenderRef = useRef<boolean>(false);
    const flyTargetRef = useRef<{
      cam: THREE.Vector3;
      look: THREE.Vector3;
    } | null>(null);
    const onSelectRef = useRef(onSelectNode);
    const onWebGlUnavailableRef = useRef(onWebGlUnavailable);

    useEffect(() => {
      onSelectRef.current = onSelectNode;
      onWebGlUnavailableRef.current = onWebGlUnavailable;
    }, [onSelectNode, onWebGlUnavailable]);

    function scheduleRender() {
      if (document.visibilityState === "hidden") return;
      needsRenderRef.current = true;
      if (rafIdRef.current === null) {
        rafIdRef.current = window.requestAnimationFrame(tickFrame);
      }
    }

    function updateInstancedTransformsAndLines() {
      const starMesh = starMeshRef.current;
      const lineMesh = lineMeshRef.current;
      const sim = simRef.current;
      const curNodes = nodesRef.current;
      const curEdges = edgesRef.current;
      if (!starMesh || !sim) return;

      const dummyMatrix = new THREE.Matrix4();
      const dummyPos = new THREE.Vector3();
      const dummyQuat = new THREE.Quaternion();
      const dummyScale = new THREE.Vector3();
      const selId = selectedIdRef.current;

      curNodes.forEach((node, idx) => {
        const p = sim.positions.get(node.id) ?? { x: 0, y: 0, z: 0 };
        const isSelected = node.id === selId;
        const isHovered = idx === hoveredIndexRef.current;
        const s =
          node.importance *
          (isSelected ? 1.45 : isHovered ? 1.25 : 1);
        dummyPos.set(p.x, p.y, p.z);
        dummyScale.set(s, s, s);
        dummyMatrix.compose(dummyPos, dummyQuat, dummyScale);
        starMesh.setMatrixAt(idx, dummyMatrix);
      });
      starMesh.instanceMatrix.needsUpdate = true;
      starMesh.computeBoundingSphere();

      if (selectionRingRef.current) {
        const selPos = selId ? sim.positions.get(selId) : undefined;
        if (selPos) {
          selectionRingRef.current.visible = true;
          selectionRingRef.current.position.set(selPos.x, selPos.y, selPos.z);
        } else {
          selectionRingRef.current.visible = false;
        }
      }

      if (lineMesh) {
        const nonSelf = curEdges.filter((e) => !e.isSelfLoop);
        const posAttr = lineMesh.geometry.getAttribute(
          "position",
        ) as THREE.BufferAttribute;
        const arr = posAttr.array as Float32Array;
        let ptr = 0;
        for (const edge of nonSelf) {
          const pa = sim.positions.get(edge.source);
          const pb = sim.positions.get(edge.target);
          if (!pa || !pb) {
            arr[ptr++] = 0;
            arr[ptr++] = 0;
            arr[ptr++] = 0;
            arr[ptr++] = 0;
            arr[ptr++] = 0;
            arr[ptr++] = 0;
            continue;
          }
          arr[ptr++] = pa.x;
          arr[ptr++] = pa.y;
          arr[ptr++] = pa.z;
          arr[ptr++] = pb.x;
          arr[ptr++] = pb.y;
          arr[ptr++] = pb.z;
        }
        posAttr.needsUpdate = true;
        lineMesh.geometry.computeBoundingSphere();
      }
    }

    function projectOverlayLabels() {
      const camera = cameraRef.current;
      const container = containerRef.current;
      const sim = simRef.current;
      const curNodes = nodesRef.current;
      if (!camera || !container || !sim || curNodes.length === 0) {
        setLabels([]);
        return;
      }

      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width <= 0 || height <= 0) return;

      const selId = selectedIdRef.current;
      const neighborIds = new Set<string>();
      if (selId) {
        neighborIds.add(selId);
        for (const edge of edgesRef.current) {
          if (edge.source === selId) neighborIds.add(edge.target);
          if (edge.target === selId) neighborIds.add(edge.source);
        }
      }

      // Priority: selected -> neighbors -> top importance hubs, bounded to MAX_OVERLAY_LABELS.
      const prioritized = [...curNodes].sort((a, b) => {
        const aSel = a.id === selId ? 2 : neighborIds.has(a.id) ? 1 : 0;
        const bSel = b.id === selId ? 2 : neighborIds.has(b.id) ? 1 : 0;
        if (aSel !== bSel) return bSel - aSel;
        return b.importance - a.importance || a.title.localeCompare(b.title);
      });

      const nextLabels: OverlayLabel[] = [];
      const proj = new THREE.Vector3();

      for (const node of prioritized) {
        if (nextLabels.length >= MAX_OVERLAY_LABELS) break;
        const p = sim.positions.get(node.id);
        if (!p) continue;
        proj.set(p.x, p.y, p.z).project(camera);
        if (proj.z < -1 || proj.z > 1) continue;
        const sx = (proj.x * 0.5 + 0.5) * width;
        const sy = (-proj.y * 0.5 + 0.5) * height;
        if (sx < 12 || sx > width - 12 || sy < 12 || sy > height - 12) continue;
        nextLabels.push({
          id: node.id,
          title: node.title,
          x: Math.round(sx),
          y: Math.round(sy),
          isSelected: node.id === selId,
        });
      }

      setLabels(nextLabels);
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
        updateInstancedTransformsAndLines();
        if (active) keepAnimating = true;
      }

      if (flyTargetRef.current) {
        const { cam, look } = flyTargetRef.current;
        camera.position.lerp(cam, 0.18);
        controls.target.lerp(look, 0.18);
        if (
          camera.position.distanceTo(cam) < 0.8 &&
          controls.target.distanceTo(look) < 0.8
        ) {
          camera.position.copy(cam);
          controls.target.copy(look);
          flyTargetRef.current = null;
        } else {
          keepAnimating = true;
        }
      }

      const controlsMoved = controls.update();
      if (controlsMoved) keepAnimating = true;

      renderer.render(scene, camera);
      projectOverlayLabels();
      needsRenderRef.current = false;

      if (keepAnimating) {
        scheduleRender();
      }
    }

    function fitPoints(points: Vec3[]) {
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!camera || !controls) return;

      if (points.length === 0) {
        camera.position.set(0, 140, 240);
        controls.target.set(0, 0, 0);
        controls.update();
        scheduleRender();
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
      const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 45);
      const dist = span * 1.15;

      const lookVec = new THREE.Vector3(cx, cy, cz);
      const camVec = new THREE.Vector3(cx, cy + dist * 0.45, cz + dist);
      if (reducedMotion) {
        flyTargetRef.current = null;
        camera.position.copy(camVec);
        controls.target.copy(lookVec);
        controls.update();
      } else {
        flyTargetRef.current = { cam: camVec, look: lookVec };
      }
      scheduleRender();
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
          const camera = cameraRef.current;
          const controls = controlsRef.current;
          if (!pos || !camera || !controls) return;
          const lookVec = new THREE.Vector3(pos.x, pos.y, pos.z);
          const camVec = new THREE.Vector3(pos.x + 28, pos.y + 24, pos.z + 58);
          if (reducedMotion) {
            flyTargetRef.current = null;
            camera.position.copy(camVec);
            controls.target.copy(lookVec);
            controls.update();
          } else {
            flyTargetRef.current = { cam: camVec, look: lookVec };
          }
          scheduleRender();
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
      [reducedMotion],
    );

    // Mount WebGLRenderer + OrbitControls + listeners once.
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      let renderer: THREE.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({
          antialias: true,
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
      const camera = new THREE.PerspectiveCamera(48, width / height, 0.5, 4000);
      camera.position.set(0, 140, 240);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = !reducedMotion;
      controls.dampingFactor = 0.08;
      controls.minDistance = 14;
      controls.maxDistance = 1600;

      const ringGeo = new THREE.RingGeometry(2.8, 3.6, 24);
      const ringMat = new THREE.MeshBasicMaterial({
        color: isDarkTheme ? 0x60a5fa : 0x2563eb,
        side: THREE.DoubleSide,
      });
      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      ringMesh.rotation.x = -Math.PI / 2;
      ringMesh.visible = false;
      scene.add(ringMesh);

      sceneRef.current = scene;
      cameraRef.current = camera;
      controlsRef.current = controls;
      rendererRef.current = renderer;
      selectionRingRef.current = ringMesh;

      const onControlsChange = () => {
        scheduleRender();
      };
      controls.addEventListener("change", onControlsChange);

      const raycaster = new THREE.Raycaster();
      const pointerNdc = new THREE.Vector2();
      let downX = 0;
      let downY = 0;

      const pickNodeIndex = (clientX: number, clientY: number): number => {
        const starMesh = starMeshRef.current;
        if (!starMesh || nodesRef.current.length === 0) return -1;
        const rect = renderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return -1;
        pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointerNdc, camera);
        const hits = raycaster.intersectObject(starMesh, false);
        const hit = hits[0];
        return hit && typeof hit.instanceId === "number" ? hit.instanceId : -1;
      };

      const onPointerDown = (ev: PointerEvent) => {
        downX = ev.clientX;
        downY = ev.clientY;
        flyTargetRef.current = null;
      };

      const onPointerMove = (ev: PointerEvent) => {
        const picked = pickNodeIndex(ev.clientX, ev.clientY);
        if (picked !== hoveredIndexRef.current) {
          hoveredIndexRef.current = picked;
          renderer.domElement.style.cursor = picked >= 0 ? "pointer" : "grab";
          updateInstancedTransformsAndLines();
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
        renderer.domElement.removeEventListener("pointermove", onPointerMove);
        renderer.domElement.removeEventListener("pointerup", onPointerUp);
        renderer.domElement.removeEventListener(
          "webglcontextlost",
          onContextLost,
        );
        document.removeEventListener("visibilitychange", onVisibilityChange);

        if (starMeshRef.current) {
          scene.remove(starMeshRef.current);
          starMeshRef.current.geometry.dispose();
          (starMeshRef.current.material as THREE.Material).dispose();
          starMeshRef.current.dispose();
          starMeshRef.current = null;
        }
        if (lineMeshRef.current) {
          scene.remove(lineMeshRef.current);
          lineMeshRef.current.geometry.dispose();
          (lineMeshRef.current.material as THREE.Material).dispose();
          lineMeshRef.current = null;
        }
        ringGeo.dispose();
        ringMat.dispose();
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
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Synchronize theme & reducedMotion dynamically without destroying WebGL context.
    useEffect(() => {
      const scene = sceneRef.current;
      const controls = controlsRef.current;
      const ring = selectionRingRef.current;
      if (!scene) return;
      scene.background = new THREE.Color(isDarkTheme ? 0x0b0e14 : 0xedf1f7);
      if (ring) {
        (ring.material as THREE.MeshBasicMaterial).color.setHex(
          isDarkTheme ? 0x60a5fa : 0x2563eb,
        );
      }
      if (controls) {
        controls.enableDamping = !reducedMotion;
      }
      if (lineMeshRef.current) {
        const mat = lineMeshRef.current.material as THREE.LineBasicMaterial;
        mat.color.setHex(isDarkTheme ? 0x475569 : 0x94a3b8);
        mat.opacity = isDarkTheme ? 0.38 : 0.45;
      }
      scheduleRender();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isDarkTheme, reducedMotion]);

    // Synchronize normalized graph nodes/edges into InstancedMesh + LineSegments + layout.
    useEffect(() => {
      const scene = sceneRef.current;
      if (!scene) return;

      nodesRef.current = nodes;
      edgesRef.current = edges;
      hoveredIndexRef.current = -1;

      if (starMeshRef.current) {
        scene.remove(starMeshRef.current);
        starMeshRef.current.geometry.dispose();
        (starMeshRef.current.material as THREE.Material).dispose();
        starMeshRef.current.dispose();
        starMeshRef.current = null;
      }
      if (lineMeshRef.current) {
        scene.remove(lineMeshRef.current);
        lineMeshRef.current.geometry.dispose();
        (lineMeshRef.current.material as THREE.Material).dispose();
        lineMeshRef.current = null;
      }

      const sim = createUniverseLayout(
        nodes,
        edges,
        positionsRef.current,
        reducedMotion,
      );
      simRef.current = sim;
      positionsRef.current = sim.positions;

      if (nodes.length > 0) {
        const sphereGeo = new THREE.SphereGeometry(1.7, 14, 10);
        const sphereMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const instanced = new THREE.InstancedMesh(
          sphereGeo,
          sphereMat,
          nodes.length,
        );
        const color = new THREE.Color();
        nodes.forEach((node, idx) => {
          const hex =
            CLUSTER_PALETTE[node.clusterColorIndex % CLUSTER_PALETTE.length] ??
            "#4f8ef7";
          color.set(hex);
          instanced.setColorAt(idx, color);
        });
        if (instanced.instanceColor) {
          instanced.instanceColor.needsUpdate = true;
        }
        scene.add(instanced);
        starMeshRef.current = instanced;
      }

      const nonSelf = edges.filter((e) => !e.isSelfLoop);
      if (nonSelf.length > 0) {
        const lineGeo = new THREE.BufferGeometry();
        const vertices = new Float32Array(nonSelf.length * 6);
        lineGeo.setAttribute(
          "position",
          new THREE.BufferAttribute(vertices, 3),
        );
        const lineMat = new THREE.LineBasicMaterial({
          color: isDarkTheme ? 0x475569 : 0x94a3b8,
          transparent: true,
          opacity: isDarkTheme ? 0.38 : 0.45,
        });
        const lineSegments = new THREE.LineSegments(lineGeo, lineMat);
        scene.add(lineSegments);
        lineMeshRef.current = lineSegments;
      }

      updateInstancedTransformsAndLines();
      scheduleRender();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodes, edges, reducedMotion]);

    // Update selection emphasis cleanly without re-creating geometry or simulation.
    useEffect(() => {
      selectedIdRef.current = selectedNodeId;
      updateInstancedTransformsAndLines();
      scheduleRender();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedNodeId]);

    return (
      <div
        className="pb-universe-canvas-wrap"
        ref={containerRef}
        aria-label="3D Knowledge Universe Canvas"
      >
        <div className="pb-universe-labels" aria-hidden="true">
          {labels.map((lbl) => (
            <div
              key={lbl.id}
              className={`pb-universe-label ${lbl.isSelected ? "is-selected" : ""}`}
              style={{ transform: `translate(${lbl.x}px, ${lbl.y}px)` }}
            >
              {lbl.title}
            </div>
          ))}
        </div>
      </div>
    );
  },
);
