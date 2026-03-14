import React, { useEffect, useRef, useCallback, useState } from "react";

const DEBUG_MODE = false;

const TILE_SIZE = 32;
const MAX_ALLOWED_ITERATIONS = 20000;
const INITIAL_TILES_PER_FRAME = 16;
const MAX_TILES_PER_FRAME = 256;

// --- LIMITS ---
const MIN_SCALE = 80; // Prevent zooming too far out
const MAX_SCALE = 1e14; // Prevent zooming past emulated double limits
const BOUNDS_MIN_X = -10.0; // Leftmost world coordinate
const BOUNDS_MAX_X = 10.0; // Rightmost world coordinate
const BOUNDS_MIN_Y = -10.0; // Topmost world coordinate
const BOUNDS_MAX_Y = 10.0; // Bottommost world coordinate

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

interface RenderBatchParams {
  fx: number;
  fy: number;
  size: number;
  maxIterations: number;
  useDouble: boolean;
}

// --- WEBGL RENDERER LOGIC ---

function splitFloat32(val: number): [number, number] {
  const hi = Math.fround(val);
  const lo = val - hi;
  return [hi, lo];
}

class MandelbrotRenderer {
  public canvas: HTMLCanvasElement | OffscreenCanvas;
  private gl: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;

  private loc_one!: WebGLUniformLocation | null;
  private loc_other!: WebGLUniformLocation | null;
  private loc_magic_a!: WebGLUniformLocation | null;
  private loc_magic_b!: WebGLUniformLocation | null;
  private loc_tilesPerRow!: WebGLUniformLocation | null;

  public physicalSize: number;
  public tilesPerRow: number;

  private instanceBuffer!: WebGLBuffer;
  private instanceData: Float32Array;

  constructor(physicalSize: number, maxTilesPerFrame: number) {
    this.physicalSize = physicalSize;
    this.tilesPerRow = Math.ceil(Math.sqrt(maxTilesPerFrame));
    const totalSize = this.tilesPerRow * physicalSize;

    if (typeof OffscreenCanvas !== "undefined") {
      this.canvas = new OffscreenCanvas(totalSize, totalSize);
    } else {
      this.canvas = document.createElement("canvas");
      this.canvas.width = totalSize;
      this.canvas.height = totalSize;
    }

    // 8 floats per instance (vec2 x 4)
    this.instanceData = new Float32Array(maxTilesPerFrame * 8);

    const glContext = this.canvas.getContext("webgl2", {
      preserveDrawingBuffer: true,
      antialias: false,
      powerPreference: "high-performance",
    });

    if (!glContext) throw new Error("WebGL 2 not supported");

    this.gl = glContext as WebGL2RenderingContext;
    this.initWebGL();
  }

  private initWebGL() {
    const { gl } = this;

    const vsSource = `#version 300 es
      in vec2 a_position;
      
      in vec2 i_topLeftX;
      in vec2 i_topLeftY;
      in vec2 i_size;
      in vec2 i_params; // x = maxIterations, y = useDouble

      out vec2 v_topLeftX;
      out vec2 v_topLeftY;
      out vec2 v_size;
      flat out int v_maxIterations;
      flat out int v_useDouble;
      out vec2 v_uv;

      uniform float u_tilesPerRow;

      void main() {
          v_topLeftX = i_topLeftX;
          v_topLeftY = i_topLeftY;
          v_size = i_size;
          v_maxIterations = int(i_params.x);
          v_useDouble = int(i_params.y);

          // Map quad space (-1 to 1) to UV space (0 to 1)
          v_uv = vec2(a_position.x * 0.5 + 0.5, -a_position.y * 0.5 + 0.5);

          // Calculate grid position for this specific tile instance
          float col = float(gl_InstanceID % int(u_tilesPerRow));
          float row = float(gl_InstanceID / int(u_tilesPerRow));
          
          float tileSizeNDC = 2.0 / u_tilesPerRow;
          
          float x0 = -1.0 + col * tileSizeNDC;
          float y0 = 1.0 - row * tileSizeNDC; // Row 0 is at the top
          
          vec2 pos;
          pos.x = x0 + (a_position.x * 0.5 + 0.5) * tileSizeNDC;
          pos.y = y0 - (-a_position.y * 0.5 + 0.5) * tileSizeNDC; 

          gl_Position = vec4(pos, 0.0, 1.0);
      }
    `;

    const fsSource = `#version 300 es
      precision highp float;
      
      in vec2 v_topLeftX;
      in vec2 v_topLeftY;
      in vec2 v_size;
      flat in int v_maxIterations;
      flat in int v_useDouble;
      in vec2 v_uv;

      uniform float u_one; 
      uniform float u_other; 
      uniform float u_magicA; 
      uniform float u_magicB; 
      
      out vec4 outColor;

      vec3 palette(float t) {
          t = fract(t);
          vec3 c0 = vec3(0.000, 0.027, 0.392);
          vec3 c1 = vec3(0.125, 0.420, 0.796);
          vec3 c2 = vec3(0.929, 1.000, 1.000);
          vec3 c3 = vec3(1.000, 0.667, 0.000);
          vec3 c4 = vec3(0.000, 0.008, 0.000);
          if      (t < 0.1600) return mix(c0, c1, t / 0.1600);
          else if (t < 0.4200) return mix(c1, c2, (t - 0.1600) / 0.2600);
          else if (t < 0.6425) return mix(c2, c3, (t - 0.4200) / 0.2225);
          else if (t < 0.8575) return mix(c3, c4, (t - 0.6425) / 0.2150);
          else                 return mix(c4, c0, (t - 0.8575) / 0.1425);
      }

      vec2 df_add(vec2 a, vec2 b) {
          float one = (u_one + u_other) * 0.5;
          float s = (a.x + b.x) * one;
          float v = (s - a.x) * one;
          float e = ((a.x - (s - v) * one) * one + (b.x - v) * one + (a.y + b.y) * one) * one;
          float x = (s + e) * one;
          float y = (e + (s - x) * one) * one;
          return vec2(x, y);
      }

      vec2 df_sub(vec2 a, vec2 b) {
          return df_add(a, vec2(-b.x, -b.y));
      }

      vec2 df_mul(vec2 a, vec2 b) {
          float one = (u_one + u_other) * 0.5;
          float c = u_magicA + u_magicB;
          
          float x = (a.x * b.x) * one;
          float ax = a.x * c; float ay = (ax - (ax - a.x) * one) * one; float a_lo = (a.x - ay) * one;
          float bx = b.x * c; float by = (bx - (bx - b.x) * one) * one; float b_lo = (b.x - by) * one;
          float y = ((ay * by - x) * one + ay * b_lo + a_lo * by + a_lo * b_lo + (a.x * b.y + a.y * b.x) * one) * one;
          float s = (x + y) * one;
          float e = (y + (x - s) * one) * one;
          return vec2(s, e);
      }

      void main() {
        vec2 uv_x = vec2(v_uv.x, 0.0);
        vec2 uv_y = vec2(v_uv.y, 0.0);
        
        vec2 cx = df_add(v_topLeftX, df_mul(v_size, uv_x));
        vec2 cy = df_add(v_topLeftY, df_mul(v_size, uv_y));
        
        int iter = 0;
        float dotZ = 0.0;
        
        if (v_useDouble == 1) {
            vec2 zx = vec2(0.0);
            vec2 zy = vec2(0.0);
            
            for(int i = 0; i < ${MAX_ALLOWED_ITERATIONS}; i++) {
                if (i >= v_maxIterations) break;
                
                vec2 x2 = df_mul(zx, zx);
                vec2 y2 = df_mul(zy, zy);
                
                if (x2.x + y2.x > 256.0) {
                    dotZ = x2.x + y2.x;
                    break;
                }
                
                vec2 zxy = df_mul(zx, zy);
                zxy = df_mul(zxy, vec2(2.0, 0.0));
                zy = df_add(zxy, cy);
                zx = df_add(df_sub(x2, y2), cx);
                iter++;
            }
        } else {
            float zx = 0.0;
            float zy = 0.0;
            float cx_f = cx.x;
            float cy_f = cy.x;
            
            for(int i = 0; i < ${MAX_ALLOWED_ITERATIONS}; i++) {
                if (i >= v_maxIterations) break;
                
                float x2 = zx * zx;
                float y2 = zy * zy;
                
                if (x2 + y2 > 256.0) {
                    dotZ = x2 + y2;
                    break;
                }
                
                zy = 2.0 * zx * zy + cy_f;
                zx = x2 - y2 + cx_f;
                iter++;
            }
        }
        
        if (iter >= v_maxIterations) {
          outColor = vec4(0.0, 0.0, 0.02, 1.0);
        } else {
          float sn = float(iter) + 1.0 - log2(log2(dotZ) * 0.5);
          float t = pow(sn, 0.35) * 0.15;
          outColor = vec4(palette(t), 1.0);
        }
      }
    `;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error("Shader compile failed:", gl.getShaderInfoLog(s));
      }
      return s;
    };

    this.program = gl.createProgram()!;
    gl.attachShader(this.program, compile(gl.VERTEX_SHADER, vsSource));
    gl.attachShader(this.program, compile(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(this.program);
    gl.useProgram(this.program);

    // Viewport spans the entire grid canvas
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    // Quad rendering points
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    const pos = gl.getAttribLocation(this.program, "a_position");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    // Instances Buffer
    this.instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.instanceData.byteLength,
      gl.DYNAMIC_DRAW,
    );

    const stride = 8 * 4; // 8 floats per instance, 4 bytes each

    const loc_topLeftX = gl.getAttribLocation(this.program, "i_topLeftX");
    gl.enableVertexAttribArray(loc_topLeftX);
    gl.vertexAttribPointer(loc_topLeftX, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(loc_topLeftX, 1);

    const loc_topLeftY = gl.getAttribLocation(this.program, "i_topLeftY");
    gl.enableVertexAttribArray(loc_topLeftY);
    gl.vertexAttribPointer(loc_topLeftY, 2, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(loc_topLeftY, 1);

    const loc_size = gl.getAttribLocation(this.program, "i_size");
    gl.enableVertexAttribArray(loc_size);
    gl.vertexAttribPointer(loc_size, 2, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(loc_size, 1);

    const loc_params = gl.getAttribLocation(this.program, "i_params");
    gl.enableVertexAttribArray(loc_params);
    gl.vertexAttribPointer(loc_params, 2, gl.FLOAT, false, stride, 24);
    gl.vertexAttribDivisor(loc_params, 1);

    gl.bindVertexArray(null);

    this.loc_one = gl.getUniformLocation(this.program, "u_one");
    this.loc_other = gl.getUniformLocation(this.program, "u_other");
    this.loc_magic_a = gl.getUniformLocation(this.program, "u_magicA");
    this.loc_magic_b = gl.getUniformLocation(this.program, "u_magicB");
    this.loc_tilesPerRow = gl.getUniformLocation(this.program, "u_tilesPerRow");
  }

  public renderBatch(tiles: RenderBatchParams[]) {
    const { gl } = this;
    if (tiles.length === 0) return;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    // Populate instance data array
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const [fxH, fxL] = splitFloat32(t.fx);
      const [fyH, fyL] = splitFloat32(t.fy);
      const [sizeH, sizeL] = splitFloat32(t.size);

      const offset = i * 8;
      this.instanceData[offset + 0] = fxH;
      this.instanceData[offset + 1] = fxL;
      this.instanceData[offset + 2] = fyH;
      this.instanceData[offset + 3] = fyL;
      this.instanceData[offset + 4] = sizeH;
      this.instanceData[offset + 5] = sizeL;
      this.instanceData[offset + 6] = t.maxIterations;
      this.instanceData[offset + 7] = t.useDouble ? 1 : 0;
    }

    // Push buffer changes for active instances
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.instanceData,
      0,
      tiles.length * 8,
    );

    const one = 0.5 * Math.round(Math.random() * 100000) * 0.00001;
    const other = 1.0 - one;
    gl.uniform1f(this.loc_one, one * 2);
    gl.uniform1f(this.loc_other, other * 2);
    gl.uniform1f(this.loc_magic_a, 2048.0 + one);
    gl.uniform1f(this.loc_magic_b, 2048.0 + other);
    gl.uniform1f(this.loc_tilesPerRow, this.tilesPerRow);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, tiles.length);
  }
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
  const tilesPerFrameRef = useRef<number>(INITIAL_TILES_PER_FRAME);
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
      const physicalSize = Math.floor(TILE_SIZE * dpr);

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

      const targetL = Math.floor(Math.log2(scale / TILE_SIZE));
      const currentTilesPerFrame = tilesPerFrameRef.current;
      let isCurrentFrameIntensive = false;

      // 1. Render missing tiles using WebGL Instance Batching
      if (!isRenderingRef.current) {
        const missing = [];

        for (let L = targetL - 4; L <= targetL + 3; L++) {
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
              MAX_TILES_PER_FRAME,
            );
          }

          // --- Execute Batched Draw Call ---
          const batchParams: RenderBatchParams[] = targets.map((target) => ({
            fx: target.x * target.fSize,
            fy: target.y * target.fSize,
            size: target.fSize,
            maxIterations: Math.min(
              MAX_ALLOWED_ITERATIONS,
              Math.floor(256 + Math.max(0, target.L) * 256),
            ),
            useDouble: scale > 1e7,
          }));

          rendererRef.current.renderBatch(batchParams);

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
              MAX_TILES_PER_FRAME,
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
      ctx.imageSmoothingEnabled = false;

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

        ctx.drawImage(
          tile.canvas,
          screenX,
          screenY,
          drawSize + 0.5,
          drawSize + 0.5,
        );
      }

      if (debugTextRef.current) {
        const currentIters = Math.min(
          MAX_ALLOWED_ITERATIONS,
          Math.floor(256 + Math.max(0, targetL) * 256),
        );
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
      (zoomMultiplier > 1 && view.current.scale == MAX_SCALE) ||
      (zoomMultiplier < 1 && view.current.scale == MIN_SCALE)
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
          display: DEBUG_MODE ? "block" : "none",
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
