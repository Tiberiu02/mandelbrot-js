import React, { useEffect, useRef, useCallback, useState } from "react";
import { MandelbrotRenderer } from "./rendering";
import config from "./config";

interface TileData {
  L: number;
  x: number;
  y: number;
  key: string;
  fractalSize: number;
  canvas: HTMLCanvasElement;
}

interface ViewState {
  x: number;
  y: number;
  scale: number;
}

interface Point {
  x: number;
  y: number;
}

function iterationsAtLevel(level: number): number {
  return Math.min(
    config.mandelbrot.MAX_ITERS,
    Math.floor(
      config.mandelbrot.BASE_ITERS +
        Math.max(0, level) * config.mandelbrot.ITERS_PER_LEVEL,
    ),
  );
}

// --- REACT COMPONENT ---

export default function MandelbrotExplorer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const debugTextRef = useRef<HTMLDivElement>(null);

  const tileCache = useRef<Map<string, TileData>>(new Map());
  const view = useRef<ViewState>({ x: -0.5, y: 0, scale: 100 });
  const activePointers = useRef<Map<number, Point>>(new Map());
  const loopRef = useRef<number>(0);

  const rendererRef = useRef<MandelbrotRenderer | null>(null);
  const isRenderingRef = useRef<boolean>(false);

  // --- DYNAMIC FPS SCALING ---
  const tilesPerFrameRef = useRef<number>(config.tile.INITIAL_TILES_PER_FRAME);
  const lastFrameTimeRef = useRef<number>(0);
  const wasLastIntensiveRef = useRef<boolean>(false);
  const emaDurationRef = useRef<number>(1000 / 60);

  const [showInstructions, setShowInstructions] = useState(true);

  // Hide instructions after 10 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      setShowInstructions(false);
    }, 10000);
    return () => clearTimeout(timer);
  }, []);

  // --- ENFORCE COORDINATE AND ZOOM LIMITS ---
  const enforceLimits = useCallback(() => {
    if (!containerRef.current) return;
    const { width, height } = containerRef.current.getBoundingClientRect();

    // 1. Clamp Scale (Zoom Limits)
    const {
      MIN_SCALE,
      MAX_SCALE,
      BOUNDS_MIN_X,
      BOUNDS_MAX_X,
      BOUNDS_MIN_Y,
      BOUNDS_MAX_Y,
    } = config.limits;

    view.current.scale = Math.max(
      MIN_SCALE,
      Math.min(MAX_SCALE, view.current.scale),
    );

    // 2. Clamp Coordinates (Pan Limits)
    const worldWidth = width / view.current.scale;
    const worldHeight = height / view.current.scale;

    const maxAllowedX = BOUNDS_MAX_X - worldWidth / 2;
    const minAllowedX = BOUNDS_MIN_X + worldWidth / 2;
    const maxAllowedY = BOUNDS_MAX_Y - worldHeight / 2;
    const minAllowedY = BOUNDS_MIN_Y + worldHeight / 2;

    // Handle X Bounds
    if (minAllowedX > maxAllowedX) {
      // Screen is wider than allowed world bounds at this scale - lock to center
      view.current.x = (BOUNDS_MIN_X + BOUNDS_MAX_X) / 2;
    } else {
      view.current.x = Math.max(
        minAllowedX,
        Math.min(maxAllowedX, view.current.x),
      );
    }

    // Handle Y Bounds
    if (minAllowedY > maxAllowedY) {
      // Screen is taller than allowed world bounds at this scale - lock to center
      view.current.y = (BOUNDS_MIN_Y + BOUNDS_MAX_Y) / 2;
    } else {
      view.current.y = Math.max(
        minAllowedY,
        Math.min(maxAllowedY, view.current.y),
      );
    }
  }, []);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(loopRef.current);
    };
  }, []);

  const renderFrame = useCallback(
    (time: number) => {
      if (!containerRef.current || !mainCanvasRef.current) return;

      const canvas = mainCanvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const { width, height } = containerRef.current.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const physicalSize = Math.floor(config.tile.TILE_SIZE * dpr);

      let screenWasResized = false;
      if (
        canvas.width !== Math.floor(width * dpr) ||
        canvas.height !== Math.floor(height * dpr)
      ) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        screenWasResized = true;
      }

      // Automatically enforce coordinate limits if the screen changed dimensions
      if (screenWasResized) enforceLimits();

      const { x: vx, y: vy, scale } = view.current;

      const worldBounds = {
        left: vx - width / 2 / scale,
        right: vx + width / 2 / scale,
        top: vy - height / 2 / scale,
        bottom: vy + height / 2 / scale,
      };

      const targetL = Math.floor(Math.log2(scale / config.tile.TILE_SIZE));
      const currentTilesPerFrame = tilesPerFrameRef.current;
      let isCurrentFrameIntensive = false;

      // 1. Render missing tiles using WebGL Instance Batching
      if (!isRenderingRef.current) {
        const missing = [];

        for (let L = targetL - 4; L <= targetL + 4; L++) {
          if (missing.length >= currentTilesPerFrame) {
            break;
          }

          const fSize = Math.pow(2, -L);
          const minX = Math.floor(worldBounds.left / fSize);
          const maxX = Math.floor(worldBounds.right / fSize);
          const minY = Math.floor(worldBounds.top / fSize);
          const maxY = Math.floor(worldBounds.bottom / fSize);

          for (let tx = minX; tx <= maxX; tx++) {
            for (let ty = minY; ty <= maxY; ty++) {
              const key = `${L}_${tx}_${ty}`;
              if (!tileCache.current.has(key)) {
                missing.push({ L, x: tx, y: ty, key, fSize });
              }
            }
          }
        }

        if (missing.length > 0) {
          missing.sort((a, b) => {
            const distA = Math.hypot(
              (a.x + 0.5) * a.fSize - vx,
              (a.y + 0.5) * a.fSize - vy,
            );
            const distB = Math.hypot(
              (b.x + 0.5) * b.fSize - vx,
              (b.y + 0.5) * b.fSize - vy,
            );
            return a.L - b.L || distA - distB;
          });

          const targets = missing.slice(0, currentTilesPerFrame);

          if (targets.length >= currentTilesPerFrame) {
            isCurrentFrameIntensive = true;
          }

          if (
            !rendererRef.current ||
            rendererRef.current.physicalSize !== physicalSize
          ) {
            rendererRef.current = new MandelbrotRenderer(
              physicalSize,
              config.tile.MAX_TILES_PER_FRAME,
            );
          }

          // --- Execute Batched Draw Call ---
          rendererRef.current.renderBatch(
            targets.map((target) => ({
              fx: target.x * target.fSize,
              fy: target.y * target.fSize,
              size: target.fSize,
              iters: iterationsAtLevel(target.L),
              useDouble: scale > 1e7,
            })),
          );

          // --- Distribute Rendered Data to Tiles ---
          for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            const tileCanvas = document.createElement("canvas");
            tileCanvas.width = physicalSize;
            tileCanvas.height = physicalSize;
            const tileCtx = tileCanvas.getContext("2d");

            if (tileCtx) {
              // Find its position in the WebGL instance grid
              const col = i % rendererRef.current.tilesPerRow;
              const row = Math.floor(i / rendererRef.current.tilesPerRow);
              const sx = col * physicalSize;
              const sy = row * physicalSize;

              // Splice exactly this tile out of the master canvas map
              tileCtx.drawImage(
                rendererRef.current.canvas,
                sx,
                sy,
                physicalSize,
                physicalSize,
                0,
                0,
                physicalSize,
                physicalSize,
              );

              // Interpolate parent tile imagery for LOD continuity
              for (let dL = 1; dL <= 4; dL++) {
                const pL = target.L - dL;
                const divisor = Math.pow(2, dL);
                const px = Math.floor(target.x / divisor);
                const py = Math.floor(target.y / divisor);
                const pKey = `${pL}_${px}_${py}`;

                const parentTile = tileCache.current.get(pKey);
                if (parentTile) {
                  const pCtx = parentTile.canvas.getContext("2d");
                  if (pCtx) {
                    const rx = target.x - px * divisor;
                    const ry = target.y - py * divisor;
                    const subSize = physicalSize / divisor;
                    pCtx.drawImage(
                      tileCanvas,
                      rx * subSize,
                      ry * subSize,
                      subSize,
                      subSize,
                    );
                  }
                }
              }
            }

            tileCache.current.set(target.key, {
              ...target,
              fractalSize: target.fSize,
              canvas: tileCanvas,
            });
          }
        }
      }

      // --- DYNAMIC FPS SCALING LOGIC ---
      if (lastFrameTimeRef.current !== 0) {
        const deltaTime = time - lastFrameTimeRef.current;

        if (wasLastIntensiveRef.current && isCurrentFrameIntensive) {
          emaDurationRef.current =
            0.2 * deltaTime + 0.8 * emaDurationRef.current;
          const currentFps = 1000 / emaDurationRef.current;

          if (currentFps < 20) {
            tilesPerFrameRef.current = Math.max(
              1,
              Math.floor(tilesPerFrameRef.current / 1.5),
            );
            emaDurationRef.current /= 1.5;
          } else if (currentFps > 45) {
            tilesPerFrameRef.current = Math.min(
              config.tile.MAX_TILES_PER_FRAME,
              Math.floor(tilesPerFrameRef.current * 1.5 + 1),
            );
            emaDurationRef.current *= 1.5;
          }
        }
      }

      lastFrameTimeRef.current = time;
      wasLastIntensiveRef.current = isCurrentFrameIntensive;

      // 2. Cleanup distant tiles
      for (const [key, tile] of tileCache.current.entries()) {
        const isTooDeep = tile.L > targetL + 5;
        const dist = Math.hypot(
          (tile.x + 0.5) * tile.fractalSize - vx,
          (tile.y + 0.5) * tile.fractalSize - vy,
        );
        const isTooFar = dist > (width * 3) / scale + tile.fractalSize;

        if (isTooDeep || isTooFar) tileCache.current.delete(key);
      }

      // 3. Paint Frame
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const physicalScale = scale * dpr;

      const drawableTiles = Array.from(tileCache.current.values())
        .filter((t) => t.L <= targetL + 1)
        .sort((a, b) => a.L - b.L);

      for (const tile of drawableTiles) {
        const tx = tile.x * tile.fractalSize;
        const ty = tile.y * tile.fractalSize;

        const screenX = cx + (tx - vx) * physicalScale;
        const screenY = cy + (ty - vy) * physicalScale;
        const drawSize = tile.fractalSize * physicalScale;

        if (
          screenX + drawSize < 0 ||
          screenX > canvas.width ||
          screenY + drawSize < 0 ||
          screenY > canvas.height
        ) {
          continue;
        }

        ctx.imageSmoothingEnabled = tile.L <= targetL ? false : true;

        ctx.drawImage(
          tile.canvas,
          screenX,
          screenY,
          drawSize + 0.5,
          drawSize + 0.5,
        );
      }

      if (debugTextRef.current) {
        const currentIters = iterationsAtLevel(targetL);
        const mode = scale > 1e7 ? "DOUBLE" : "FLOAT";
        const displayFps = Math.round(1000 / emaDurationRef.current);

        const newText = `CACHED: ${tileCache.current.size} | ZOOM: ${scale.toExponential(2)} | ITERS: ${currentIters} | PRECISION: ${mode} | FPS: ${displayFps} | TILES/FR: ${tilesPerFrameRef.current}`;
        if (debugTextRef.current.innerText !== newText) {
          debugTextRef.current.innerText = newText;
        }
      }

      loopRef.current = requestAnimationFrame(renderFrame);
    },
    [enforceLimits],
  );

  useEffect(() => {
    loopRef.current = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(loopRef.current);
  }, [renderFrame]);

  const onWheel = (e: React.WheelEvent) => {
    const zoomMultiplier = Math.pow(0.99, e.deltaY * 0.1);

    if (
      (zoomMultiplier > 1 && view.current.scale == config.limits.MAX_SCALE) ||
      (zoomMultiplier < 1 && view.current.scale == config.limits.MIN_SCALE)
    ) {
      return;
    }

    const rect = containerRef.current!.getBoundingClientRect();

    const mx = e.clientX - rect.left - rect.width / 2;
    const my = e.clientY - rect.top - rect.height / 2;

    const fx = view.current.x + mx / view.current.scale;
    const fy = view.current.y + my / view.current.scale;

    view.current.scale *= zoomMultiplier;
    view.current.x = fx - mx / view.current.scale;
    view.current.y = fy - my / view.current.scale;

    enforceLimits(); // Apply constraints after zoom
  };

  const onPointerDown = (e: React.PointerEvent) => {
    containerRef.current?.setPointerCapture(e.pointerId);
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!activePointers.current.has(e.pointerId)) return;

    const prev = activePointers.current.get(e.pointerId)!;
    const curr = { x: e.clientX, y: e.clientY };

    if (activePointers.current.size === 1) {
      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;
      view.current.x -= dx / view.current.scale;
      view.current.y -= dy / view.current.scale;

      enforceLimits(); // Apply constraints after pan
    } else if (activePointers.current.size === 2) {
      const pointersList = Array.from(activePointers.current.entries());
      const otherPointData = pointersList.find(([id]) => id !== e.pointerId);

      if (otherPointData) {
        const other = otherPointData[1];

        const prevDist = Math.hypot(prev.x - other.x, prev.y - other.y);
        const currDist = Math.hypot(curr.x - other.x, curr.y - other.y);

        const prevCenter = {
          x: (prev.x + other.x) / 2,
          y: (prev.y + other.y) / 2,
        };
        const currCenter = {
          x: (curr.x + other.x) / 2,
          y: (curr.y + other.y) / 2,
        };

        if (prevDist > 0) {
          const zoomMultiplier = currDist / prevDist;
          const rect = containerRef.current!.getBoundingClientRect();

          const prevMx = prevCenter.x - rect.left - rect.width / 2;
          const prevMy = prevCenter.y - rect.top - rect.height / 2;
          const focalWorldX = view.current.x + prevMx / view.current.scale;
          const focalWorldY = view.current.y + prevMy / view.current.scale;

          view.current.scale *= zoomMultiplier;
          enforceLimits(); // Apply constraints after pinch zoom

          const currMx = currCenter.x - rect.left - rect.width / 2;
          const currMy = currCenter.y - rect.top - rect.height / 2;
          view.current.x = focalWorldX - currMx / view.current.scale;
          view.current.y = focalWorldY - currMy / view.current.scale;
          enforceLimits(); // Apply constraints after pinch zoom
        }
      }
    }

    activePointers.current.set(e.pointerId, curr);
  };

  const onPointerUpOrCancel = (e: React.PointerEvent) => {
    activePointers.current.delete(e.pointerId);
    containerRef.current?.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      ref={containerRef}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUpOrCancel}
      onPointerCancel={onPointerUpOrCancel}
      style={{
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        position: "relative",
        backgroundColor: "#000",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        overscrollBehavior: "none",
        cursor: activePointers.current.size > 0 ? "grabbing" : "grab",
      }}
    >
      <canvas
        ref={mainCanvasRef}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
      <div
        ref={debugTextRef}
        style={{
          position: "absolute",
          display: config.DEBUG_MODE ? "block" : "none",
          top: 10,
          left: 10,
          color: "white",
          background: "rgba(0,0,0,0.6)",
          padding: "10px",
          borderRadius: "8px",
          fontFamily: "monospace",
          pointerEvents: "none",
          fontSize: "10px",
        }}
      >
        Initializing Explorer...
      </div>

      <div
        style={{
          position: "absolute",
          top: 20,
          left: "50%",
          transform: "translateX(-50%)",
          opacity: showInstructions ? 1 : 0,
          color: "white",
          background: "rgba(0,0,0,0.7)",
          padding: "12px 20px",
          borderRadius: "8px",
          fontFamily: "sans-serif",
          fontWeight: "bold",
          letterSpacing: "1px",
          pointerEvents: "none",
          fontSize: "14px",
          transition: "opacity 0.5s ease",
          whiteSpace: "nowrap",
          zIndex: 10,
        }}
      >
        DRAG TO MOVE, SCROLL TO ZOOM
      </div>
    </div>
  );
}
