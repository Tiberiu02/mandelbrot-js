// --- WEBGL RENDERER LOGIC ---

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
  fx: number;
  fy: number;
  size: number;
  iters: number;
  useDouble: boolean;
}

function splitFloat32(val: number): [number, number] {
  const hi = Math.fround(val);
  const lo = val - hi;
  return [hi, lo];
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
  public maxIters: number;

  private instanceBuffer!: WebGLBuffer;
  private instanceData: Float32Array;

  constructor(
    physicalSize: number,
    maxTilesPerFrame: number,
    palette: string,
    maxIters: number,
  ) {
    this.palette = palette;
    this.physicalSize = physicalSize;
    this.maxIters = maxIters;
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
        vec2 uv_x = vec2(v_uv.x, 0.0);
        vec2 uv_y = vec2(v_uv.y, 0.0);
        
        vec2 cx = df_add(v_topLeftX, df_mul(v_size, uv_x));
        vec2 cy = df_add(v_topLeftY, df_mul(v_size, uv_y));
        
        int iter = 0;
        float dotZ = 0.0;
        
        if (v_useDouble == 1) {
            vec2 zx = vec2(0.0);
            vec2 zy = vec2(0.0);
            
            // Max Iters must be a compile-time constant, but if it's too large,
            // mobile GPUs struggle to compile the shader.
            for(int i = 0; i < ${this.maxIters}; i++) {
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
            
            for(int i = 0; i < ${this.maxIters}; i++) {
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
      this.instanceData[offset + 6] = t.iters;
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
