// --- WEBGL RENDERER LOGIC ---

import Decimal from "decimal.js";
import config from "./config";

export const palettes: Record<string, string> = {
  gold: `
    vec3 palette(int iter, float dotZ) {
        float sn = float(iter) + 1.0 - log2(log2(dotZ) * 0.5);
        float t = fract(pow(sn, 0.35) * 0.15);
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
  `,
  fire: `
    vec3 palette(int iter, float dotZ) {
        float sn = float(iter) + 1.0 - log2(log2(dotZ) * 0.5);
        float t = fract(pow(sn, 0.35) * 0.15);
        vec3 c0 = vec3(0.000, 0.000, 0.000);
        vec3 c1 = vec3(0.502, 0.000, 0.000);
        vec3 c2 = vec3(1.000, 0.420, 0.000);
        vec3 c3 = vec3(1.000, 1.000, 0.200);
        vec3 c4 = vec3(1.000, 1.000, 1.000);
        if      (t < 0.25) return mix(c0, c1, t / 0.25);
        else if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
        else if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
        else if (t < 0.99) return mix(c3, c4, (t - 0.75) / 0.19);
        else               return mix(c4, c0, (t - 0.99) / 0.01);
    }
  `,
  rainbow: `
    vec3 palette(int iter, float dotZ) {
        float sn = float(iter) + 1.0 - log2(log2(dotZ) * 0.5);
        float t = fract(pow(sn, 0.35) * 0.15);
        float r = 0.5 + 0.5 * cos(6.28318 * (t + 0.000));
        float g = 0.5 + 0.5 * cos(6.28318 * (t + 0.333));
        float b = 0.5 + 0.5 * cos(6.28318 * (t + 0.667));
        return vec3(r, g, b);
    }
  `,
  grayscale: `
    vec3 palette(int iter, float dotZ) {
        float sn = float(iter) + 1.0 - log2(log2(dotZ) * 0.5);
        float t = fract(pow(sn, 0.35) * 0.15);
        return vec3(t);
    }
  `,
};

export interface RenderBatchParams {
  fx: Decimal;
  fy: Decimal;
  size: number;
  iters: number;
  useDouble: boolean;
}

function splitFloat32(val: number): [number, number] {
  const hi = Math.fround(val);
  const lo = val - hi;
  return [hi, lo];
}

type complex = [Decimal, Decimal];

function cMul(a: complex, b: complex): complex {
  return [
    a[0].mul(b[0]).sub(a[1].mul(b[1])),
    a[0].mul(b[1]).add(a[1].mul(b[0])),
  ];
}

function cAdd(a: complex, b: complex): complex {
  return [a[0].add(b[0]), a[1].add(b[1])];
}

function cNorm2(z: complex): number {
  return z[0].toNumber() ** 2 + z[1].toNumber() ** 2;
}

function computeTrajectory(
  cx: Decimal,
  cy: Decimal,
  maxIters: number,
  r: number,
  size: number,
): {
  iters: number;
  totalIters: number;
  zx: number;
  zy: number;
  dzScaledX: number; // dz.re * size
  dzScaledY: number; // dz.im * size
  d2zScaledX: number; // 0.5 * d2z.re * size^2
  d2zScaledY: number; // 0.5 * d2z.im * size^2
} {
  let z = [Decimal(0), Decimal(0)] as complex,
    dz = [Decimal(0), Decimal(0)] as complex,
    d2z = [Decimal(0), Decimal(0)] as complex;

  const D2_LIM = 0.01; // Threshold for second derivative escape

  let iter = 0;
  while (
    iter < maxIters &&
    cNorm2(z) <= 4 &&
    cNorm2(d2z) * r * r <= cNorm2(dz) * D2_LIM ** 2
  ) {
    d2z = cMul(cAdd(cMul(z, d2z), cMul(dz, dz)), [Decimal(2), Decimal(0)]);
    dz = cAdd(cMul(cMul(z, dz), [Decimal(2), Decimal(0)]), [
      Decimal(1),
      Decimal(0),
    ]);
    z = cAdd(cMul(z, z), [cx, cy]);
    iter++;
  }

  console.log("computed:", iter);

  let totalIters = iter;
  let z2 = [z[0], z[1]] as complex;
  while (totalIters < maxIters && cNorm2(z2) <= 4) {
    z2 = cAdd(cMul(z2, z2), [cx, cy]);
    totalIters++;
  }

  console.log({
    zx: z[0].toNumber(),
    zy: z[1].toNumber(),
    dzx: dz[0].toNumber(),
    dzy: dz[1].toNumber(),
    d2zx: d2z[0].toNumber(),
    d2zy: d2z[1].toNumber(),
  });

  return {
    iters: iter,
    totalIters: totalIters,
    zx: z[0].toNumber(),
    zy: z[1].toNumber(),
    dzScaledX: dz[0].toNumber() * size,
    dzScaledY: dz[1].toNumber() * size,
    d2zScaledX: d2z[0].toNumber() * size * 0.5 * size,
    d2zScaledY: d2z[1].toNumber() * size * 0.5 * size,
  };
}

export class MandelbrotRenderer {
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
  public palette: string;

  private instanceBuffer!: WebGLBuffer;
  private instanceData: Float32Array;

  constructor(physicalSize: number, maxTilesPerFrame: number, palette: string) {
    this.palette = palette;
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

    // 16 floats per instance: topLeftX(2) topLeftY(2) size(2) params(4) skipZ(2) skipDz(2) skipD2z(2)
    this.instanceData = new Float32Array(maxTilesPerFrame * 16);

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
      
      in vec2 i_cxCenter;
      in vec2 i_cyCenter;
      in vec4 i_params; // x = maxIterations, y = useDouble, z = skipIters
      in vec2 i_skipZ;
      in vec2 i_skipDz;  // pre-scaled: dz * size
      in vec2 i_skipD2z; // pre-scaled: 0.5 * d2z * size^2

      out vec2 v_cxCenter;
      out vec2 v_cyCenter;
      flat out int v_maxIterations;
      flat out int v_useDouble;
      flat out int v_skipIters;
      out vec2 v_skipZ;
      out vec2 v_skipDz;
      out vec2 v_skipD2z;
      out vec2 v_uv;

      uniform float u_tilesPerRow;

      void main() {
          v_cxCenter = i_cxCenter;
          v_cyCenter = i_cyCenter;
          v_maxIterations = int(i_params.x);
          v_useDouble = int(i_params.y);
          v_skipIters = int(i_params.z);
          v_skipZ = i_skipZ;
          v_skipDz = i_skipDz;
          v_skipD2z = i_skipD2z;

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
      
      in vec2 v_cxCenter;
      in vec2 v_cyCenter;
      flat in int v_maxIterations;
      flat in int v_useDouble;
      flat in int v_skipIters;
      in vec2 v_skipZ;
      in vec2 v_skipDz;  // pre-scaled: dz * size
      in vec2 v_skipD2z; // pre-scaled: 0.5 * d2z * size^2
      in vec2 v_uv;

      uniform float u_one; 
      uniform float u_other; 
      uniform float u_magicA; 
      uniform float u_magicB; 
      
      out vec4 outColor;

      ${this.palette}

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
        vec2 cx = v_cxCenter;
        vec2 cy = v_cyCenter;

        float dotZ = 0.0;

        // uv offset from tile center, in [-0.5, 0.5]
        // derivatives are pre-scaled by size (and size^2), so no size needed here
        float u = v_uv.x - 0.5;
        float v = v_uv.y - 0.5;
        float u2mv2 = u * u - v * v;
        float uv2 = 2.0 * u * v;
        float z0x = v_skipZ.x
            + (v_skipDz.x * u  - v_skipDz.y * v)
            + (v_skipD2z.x * u2mv2 - v_skipD2z.y * uv2);
        float z0y = v_skipZ.y
            + (v_skipDz.x * v  + v_skipDz.y * u)
            + (v_skipD2z.x * uv2    + v_skipD2z.y * u2mv2);

        int iter = v_skipIters;

        if (v_useDouble == 1) {
            vec2 zx = vec2(z0x, 0.0);
            vec2 zy = vec2(z0y, 0.0);

            for(int i = v_skipIters; i < ${config.mandelbrot.MAX_ITERS}; i++) {
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
            float zx = z0x;
            float zy = z0y;
            float cx_f = cx.x;
            float cy_f = cy.x;

            for(int i = v_skipIters; i < ${config.mandelbrot.MAX_ITERS}; i++) {
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
          outColor = vec4(palette(iter, dotZ), 1.0);
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

    const stride = 16 * 4; // 16 floats per instance, 4 bytes each

    const loc_cxCenter = gl.getAttribLocation(this.program, "i_cxCenter");
    gl.enableVertexAttribArray(loc_cxCenter);
    gl.vertexAttribPointer(loc_cxCenter, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(loc_cxCenter, 1);

    const loc_cyCenter = gl.getAttribLocation(this.program, "i_cyCenter");
    gl.enableVertexAttribArray(loc_cyCenter);
    gl.vertexAttribPointer(loc_cyCenter, 2, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(loc_cyCenter, 1);

    const loc_params = gl.getAttribLocation(this.program, "i_params");
    gl.enableVertexAttribArray(loc_params);
    gl.vertexAttribPointer(loc_params, 4, gl.FLOAT, false, stride, 24);
    gl.vertexAttribDivisor(loc_params, 1);

    const loc_skipZ = gl.getAttribLocation(this.program, "i_skipZ");
    gl.enableVertexAttribArray(loc_skipZ);
    gl.vertexAttribPointer(loc_skipZ, 2, gl.FLOAT, false, stride, 40);
    gl.vertexAttribDivisor(loc_skipZ, 1);

    const loc_skipDz = gl.getAttribLocation(this.program, "i_skipDz");
    gl.enableVertexAttribArray(loc_skipDz);
    gl.vertexAttribPointer(loc_skipDz, 2, gl.FLOAT, false, stride, 48);
    gl.vertexAttribDivisor(loc_skipDz, 1);

    const loc_skipD2z = gl.getAttribLocation(this.program, "i_skipD2z");
    gl.enableVertexAttribArray(loc_skipD2z);
    gl.vertexAttribPointer(loc_skipD2z, 2, gl.FLOAT, false, stride, 56);
    gl.vertexAttribDivisor(loc_skipD2z, 1);

    gl.bindVertexArray(null);

    this.loc_one = gl.getUniformLocation(this.program, "u_one");
    this.loc_other = gl.getUniformLocation(this.program, "u_other");
    this.loc_magic_a = gl.getUniformLocation(this.program, "u_magicA");
    this.loc_magic_b = gl.getUniformLocation(this.program, "u_magicB");
    this.loc_tilesPerRow = gl.getUniformLocation(this.program, "u_tilesPerRow");
  }

  public delete() {
    const { gl } = this;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.instanceBuffer);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  public renderBatch(tiles: RenderBatchParams[]) {
    const { gl } = this;
    if (tiles.length === 0) return;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    let iters = 0;
    let totalIters = 0;

    // Populate instance data array
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const cxCenter = t.fx.add(t.size * 0.5);
      const cyCenter = t.fy.add(t.size * 0.5);
      const [cxH, cxL] = splitFloat32(cxCenter.toNumber());
      const [cyH, cyL] = splitFloat32(cyCenter.toNumber());

      const traj = computeTrajectory(
        cxCenter,
        cyCenter,
        t.iters,
        t.size / Math.sqrt(2),
        t.size,
      );

      iters += traj.iters;
      totalIters += traj.totalIters;

      const offset = i * 16;
      this.instanceData[offset + 0] = cxH;
      this.instanceData[offset + 1] = cxL;
      this.instanceData[offset + 2] = cyH;
      this.instanceData[offset + 3] = cyL;
      this.instanceData[offset + 4] = 0; // padding (freed from i_size)
      this.instanceData[offset + 5] = 0;
      this.instanceData[offset + 6] = t.iters;
      this.instanceData[offset + 7] = t.useDouble ? 1 : 0;
      this.instanceData[offset + 8] = traj.iters;
      this.instanceData[offset + 9] = 0; // padding (vec4 alignment)
      this.instanceData[offset + 10] = traj.zx;
      this.instanceData[offset + 11] = traj.zy;
      this.instanceData[offset + 12] = traj.dzScaledX;
      this.instanceData[offset + 13] = traj.dzScaledY;
      this.instanceData[offset + 14] = traj.d2zScaledX;
      this.instanceData[offset + 15] = traj.d2zScaledY;
    }

    console.log("Gain:", totalIters / (totalIters - iters));

    // Push buffer changes for active instances
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.instanceData,
      0,
      tiles.length * 16,
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
