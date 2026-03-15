import React, { useEffect, useRef, useCallback, useState } from "react";
import { MandelbrotRenderer, palettes } from "./rendering";
import config from "./config";
import { MdDownload, MdShare, MdClose, MdSettings } from "react-icons/md";
import { FaGithub } from "react-icons/fa";
import { FaUser } from "react-icons/fa6";

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

function isMobile(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function iterationsAtLevel(level: number): number {
  return Math.min(
    config.mandelbrot.MAX_ITERS,
    Math.floor(
      config.mandelbrot.BASE_ITERS +
        Math.max(0, level) * config.mandelbrot.ITERS_PER_LEVEL_INIT,
    ),
  );
}

// --- URL PARAMS (parsed once at module load) ---

const _p = new URLSearchParams(window.location.search);
const _urlParams = {
  x: parseFloat(_p.get("x") ?? ""),
  y: parseFloat(_p.get("y") ?? ""),
  z: parseFloat(_p.get("z") ?? ""),
  pal: _p.get("p") ?? "",
  iters: parseInt(_p.get("i") ?? ""),
};

// --- REACT COMPONENT ---

export default function MandelbrotExplorer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const debugTextRef = useRef<HTMLDivElement>(null);

  const tileCache = useRef<Map<string, TileData>>(new Map());
  const view = useRef<ViewState>({
    x: isFinite(_urlParams.x) ? _urlParams.x : -0.5,
    y: isFinite(_urlParams.y) ? _urlParams.y : 0,
    scale: isFinite(_urlParams.z) && _urlParams.z > 0 ? _urlParams.z : 100,
  });
  const activePointers = useRef<Map<number, Point>>(new Map());
  const loopRef = useRef<number>(0);

  const rendererRef = useRef<MandelbrotRenderer | null>(null);
  const isRenderingRef = useRef<boolean>(false);
  const isInteractingRef = useRef<boolean>(false);

  // --- DYNAMIC FPS SCALING ---
  const tilesPerFrameRef = useRef<number>(config.tile.INITIAL_TILES_PER_FRAME);
  const lastFrameTimeRef = useRef<number>(0);
  const wasLastIntensiveRef = useRef<boolean>(false);
  const emaDurationRef = useRef<number>(1000 / 60);

  const [showInstructions, setShowInstructions] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [itersPerLevel, setItersPerLevel] = useState(() => {
    const val = _urlParams.iters;
    if (isFinite(val) && val > 0) {
      config.mandelbrot.ITERS_PER_LEVEL_INIT = val;
      return val;
    }
    const defaultIters = isMobile()
      ? config.mandelbrot.ITERS_PER_LEVEL_INIT_MOBILE
      : config.mandelbrot.ITERS_PER_LEVEL_INIT;
    config.mandelbrot.ITERS_PER_LEVEL_INIT = defaultIters;
    return defaultIters;
  });
  const [palette, setPalette] = useState(() =>
    _urlParams.pal && _urlParams.pal in palettes
      ? _urlParams.pal
      : config.mandelbrot.DEFAULT_PALETTE,
  );

  // Hide instructions after 10 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      setShowInstructions(false);
    }, 10000);
    return () => clearTimeout(timer);
  }, []);

  // Preview animation: after delay, fly to target location
  useEffect(() => {
    if (!config.preview.ENABLED) return;
    let rafId: number;
    const delayTimer = setTimeout(() => {
      const startView = { ...view.current };
      const startLogScale = Math.log(startView.scale);
      const targetLogScale = Math.log(config.preview.TARGET.z);
      const startTime = performance.now();

      const k = 50;
      const norm = 1 - Math.exp(-k);

      const animate = () => {
        if (isInteractingRef.current) return;
        const t = Math.min(
          (performance.now() - startTime) / config.preview.DURATION_MS,
          1,
        );
        const te = t < 1 ? (1 - Math.exp(-k * t)) / norm : 1;
        view.current.x =
          startView.x + (config.preview.TARGET.x - startView.x) * te;
        view.current.y =
          startView.y + (config.preview.TARGET.y - startView.y) * te;
        view.current.scale = Math.exp(
          startLogScale + (targetLogScale - startLogScale) * t,
        );
        if (t < 1) rafId = requestAnimationFrame(animate);
      };

      rafId = requestAnimationFrame(animate);
    }, config.preview.START_DELAY_MS);

    return () => {
      clearTimeout(delayTimer);
      cancelAnimationFrame(rafId);
    };
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
      const currentTilesPerFrame =
        (isInteractingRef.current || showModal) && !config.preview.ENABLED
          ? 0
          : tilesPerFrameRef.current;
      let isCurrentFrameIntensive = false;

      // 1. Render missing tiles using WebGL Instance Batching
      if (!isRenderingRef.current && currentTilesPerFrame > 0) {
        const missing = [];

        for (let L = Math.min(-3, targetL - 4); L <= targetL + 4; L++) {
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

          if (targets.length >= tilesPerFrameRef.current) {
            isCurrentFrameIntensive = true;
          }

          if (
            !rendererRef.current ||
            rendererRef.current.physicalSize !== physicalSize ||
            rendererRef.current.palette !== palette
          ) {
            rendererRef.current?.delete();
            rendererRef.current = new MandelbrotRenderer(
              physicalSize,
              config.tile.MAX_TILES_PER_FRAME,
              palettes[palette],
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

          if (currentFps < 6) {
            tilesPerFrameRef.current = Math.max(
              1,
              Math.floor(tilesPerFrameRef.current / 1.5),
            );
            emaDurationRef.current /= 1.5;
          } else if (currentFps > 12) {
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
          screenY > canvas.height ||
          tile.L >= targetL + 2
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
    [enforceLimits, palette, showModal],
  );

  useEffect(() => {
    loopRef.current = requestAnimationFrame(renderFrame);
    return () => {
      cancelAnimationFrame(loopRef.current);
      rendererRef.current?.delete();
      rendererRef.current = null;
    };
  }, [renderFrame]);

  const interactionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

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

    isInteractingRef.current = true;
    if (interactionTimeoutRef.current)
      clearTimeout(interactionTimeoutRef.current);
    interactionTimeoutRef.current = setTimeout(() => {
      isInteractingRef.current = false;
    }, 150);
    enforceLimits(); // Apply constraints after zoom
  };

  const onPointerDown = (e: React.PointerEvent) => {
    isInteractingRef.current = true;
    if (interactionTimeoutRef.current)
      clearTimeout(interactionTimeoutRef.current);
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
    if (activePointers.current.size === 0) {
      if (interactionTimeoutRef.current)
        clearTimeout(interactionTimeoutRef.current);
      interactionTimeoutRef.current = setTimeout(() => {
        isInteractingRef.current = false;
      }, 150);
    }
    containerRef.current?.releasePointerCapture(e.pointerId);
  };

  return (
    <div className="w-dvw h-dvh relative">
      <div
        ref={containerRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUpOrCancel}
        onPointerCancel={onPointerUpOrCancel}
        className={`w-full h-full overflow-hidden relative bg-black touch-none select-none overscroll-none ${activePointers.current.size > 0 ? "cursor-grabbing" : "cursor-grab"}`}
      >
        <canvas ref={mainCanvasRef} className="w-full h-full block" />
        <div
          ref={debugTextRef}
          className={`absolute top-2.5 left-2.5 text-white bg-black/60 p-2.5 rounded-lg font-mono pointer-events-none text-[10px] ${config.DEBUG_MODE ? "block" : "hidden"}`}
        >
          Initializing Explorer...
        </div>

        <div
          className={`absolute top-5 left-1/2 -translate-x-1/2 text-white bg-black/70 px-5 py-3 rounded-lg font-sans font-bold tracking-[1px] pointer-events-none text-sm transition-opacity duration-500 whitespace-nowrap z-10 ${showInstructions ? "opacity-100" : "opacity-0"}`}
        >
          DRAG TO MOVE, SCROLL TO ZOOM
        </div>
      </div>

      <div className="absolute bottom-5 right-5 z-10">
        <button
          onClick={() => setShowModal(true)}
          className="w-11 h-11 rounded-full border-none bg-black/60 text-white cursor-pointer flex items-center justify-center text-[22px]"
          title="About"
        >
          <MdSettings />
        </button>
      </div>
      {showModal && (
        <div
          className="absolute inset-0 bg-black/70 flex items-center justify-center z-20"
          onClick={() => setShowModal(false)}
        >
          <div
            className="bg-[#111] text-white rounded-2xl p-8 max-w-sm w-[90%] flex flex-col gap-5 relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setShowModal(false)}
              className="absolute top-4 right-4 text-white/50 hover:text-white cursor-pointer text-[22px] bg-transparent border-none"
            >
              <MdClose />
            </button>

            <div>
              <h2 className="text-xl font-bold mb-3">Settings</h2>
              <div className="flex justify-between items-center">
                <label className="text-sm text-white/60">
                  Number of iterations
                </label>
                <select
                  value={itersPerLevel}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setItersPerLevel(val);
                    config.mandelbrot.ITERS_PER_LEVEL_INIT = val;
                    tileCache.current.clear();
                    setShowModal(false);
                  }}
                  className="w-32 bg-white/10 text-white text-sm rounded-lg px-3 py-1 border-none cursor-pointer outline-none"
                >
                  <option value={64} className="bg-[#222] text-white">
                    very low
                  </option>
                  <option value={128} className="bg-[#222] text-white">
                    low
                  </option>
                  <option value={256} className="bg-[#222] text-white">
                    medium
                  </option>
                  <option value={512} className="bg-[#222] text-white">
                    high
                  </option>
                  <option value={2048} className="bg-[#222] text-white">
                    very high
                  </option>
                  <option value={8192} className="bg-[#222] text-white">
                    extreme
                  </option>
                </select>
              </div>
              <div className="flex justify-between items-center mt-3">
                <label className="text-sm text-white/60">Color palette</label>
                <select
                  value={palette}
                  onChange={(e) => {
                    setPalette(e.target.value);
                    tileCache.current.clear();
                    setShowModal(false);
                  }}
                  className="w-32 bg-white/10 text-white text-sm rounded-lg px-3 py-1 border-none cursor-pointer outline-none"
                >
                  {Object.keys(palettes).map((name) => (
                    <option
                      key={name}
                      value={name}
                      className="bg-[#222] text-white"
                    >
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <h2 className="text-xl font-bold mb-3">Current View</h2>
              <div className="bg-white/5 rounded-xl px-4 py-3 font-mono text-xs flex flex-col gap-2">
                {(() => {
                  const { x, y, scale } = view.current;
                  const decimals = Math.min(15, Math.ceil(Math.log10(scale)));
                  return (
                    <>
                      <div className="flex justify-between">
                        <span className="text-white/40">X</span>
                        <span>{x.toFixed(decimals)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-white/40">Y</span>
                        <span>{y.toFixed(decimals)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-white/40">Zoom</span>
                        <span>{scale.toExponential(2)}</span>
                      </div>
                    </>
                  );
                })()}
              </div>
              <div className="flex flex-col gap-2 mt-3">
                <button
                  onClick={() => {
                    const canvas = mainCanvasRef.current;
                    if (!canvas) return;
                    const { x, y, scale } = view.current;
                    const now = new Date();
                    const date = now.toISOString().slice(0, 10);
                    const time = now
                      .toTimeString()
                      .slice(0, 8)
                      .replace(/:/g, "-");
                    const decimals = Math.min(15, Math.ceil(Math.log10(scale)));
                    const link = document.createElement("a");
                    link.download = `mandelbrot_${date}_${time}_${x.toFixed(decimals)}_${y.toFixed(decimals)}_${scale.toExponential(1)}.png`;
                    link.href = canvas.toDataURL("image/png");
                    link.click();
                  }}
                  className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm cursor-pointer border-none transition-colors"
                >
                  <MdDownload className="text-base mr-1 shrink-0" /> Download
                  current view as image
                </button>
                <button
                  onClick={() => {
                    const canvas = mainCanvasRef.current;
                    const { x, y, scale } = view.current;
                    const decimals = Math.min(15, Math.ceil(Math.log10(scale)));
                    const params = new URLSearchParams({
                      x: x.toFixed(decimals),
                      y: y.toFixed(decimals),
                      z: scale.toExponential(1),
                      p: palette,
                      i: String(itersPerLevel),
                    });
                    const url = `https://mandelbrot.musat.ai?${params}`;
                    const text = `Check out this Mandelbrot view: ${url}`;
                    if (isMobile() && navigator.share && canvas) {
                      const maxSize = 720;
                      const scale2 = Math.min(
                        1,
                        maxSize / Math.max(canvas.width, canvas.height),
                      );
                      const thumb = document.createElement("canvas");
                      thumb.width = Math.round(canvas.width * scale2);
                      thumb.height = Math.round(canvas.height * scale2);
                      thumb
                        .getContext("2d")!
                        .drawImage(canvas, 0, 0, thumb.width, thumb.height);
                      thumb.toBlob((blob) => {
                        if (!blob) return;
                        const file = new File([blob], "mandelbrot.png", {
                          type: "image/png",
                        });
                        const shareData = { text, files: [file] };
                        if (navigator.canShare?.(shareData)) {
                          navigator.share(shareData);
                        } else {
                          navigator.share({ text });
                        }
                      }, "image/png");
                    } else {
                      navigator.clipboard
                        .writeText(url)
                        .then(() => alert("Link copied to clipboard!"));
                    }
                  }}
                  className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm cursor-pointer border-none transition-colors"
                >
                  <MdShare className="text-base mr-1 shrink-0" /> Share current
                  view via link
                  {isMobile() ? " and image" : ""}
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <h2 className="text-xl font-bold mb-1">About the project</h2>

              <a
                href="https://github.com/tiberiu02/mandelbrot-js"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 text-sm text-white opacity-80 hover:opacity-100 transition-opacity"
              >
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-xl shrink-0">
                  <FaGithub />
                </div>
                <div>
                  <div className="font-semibold">Source Code on GitHub</div>
                  <div className="text-white/40 text-xs text-ellipsis w-full text-nowrap grow-0">
                    github.com/tiberiu02/mandelbrot-js
                  </div>
                </div>
              </a>

              <a
                href="https://musat.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 text-sm text-white opacity-80 hover:opacity-100 transition-opacity"
              >
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-base shrink-0">
                  <FaUser />
                </div>
                <div>
                  <div className="font-semibold">Created by Tiberiu Musat</div>
                  <div className="text-white/40 text-xs">
                    Read more at https://musat.ai
                  </div>
                </div>
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
