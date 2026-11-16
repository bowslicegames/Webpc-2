/* WebPC Browser GPU Display Application.
 * Uses WebGL 2 to upload and present guest RGBA framebuffer frames on the
 * iPad's browser GPU. This accelerates display/compositing of guest pixels;
 * it is NOT a guest OpenGL command translator. A QEMU/Mesa backend must still
 * produce the guest framebuffer and inject guest input.
 */
(() => {
  "use strict";
  const state = { canvas:null, gl:null, program:null, texture:null,
    width:0, height:0, frames:0, lastFrameAt:0, frameTimes:[], sink:null,
    stopped:false, lastUploadAt:0, maxFps:30, contextLost:false,
    restored:0 };
  const vertexSource = `#version 300 es
    precision highp float;
    out vec2 uv;
    void main() {
      vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
      uv = vec2(p.x, 1.0 - p.y);
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }`;
  const fragmentSource = `#version 300 es
    precision mediump float;
    uniform sampler2D guestFrame;
    in vec2 uv;
    out vec4 outColor;
    void main() { outColor = texture(guestFrame, uv); }`;

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(shader) || "unknown shader error";
      gl.deleteShader(shader);
      throw new Error("WebGL shader compile failed: " + error);
    }
    return shader;
  }

  function buildRenderer(canvas) {
    const gl = canvas.getContext("webgl2", { alpha:false, antialias:false,
      depth:false, stencil:false, desynchronized:true, powerPreference:"high-performance" });
    if (!gl) throw new Error("WebGL 2 is unavailable; browser GPU display cannot start");
    const vs = compile(gl, gl.VERTEX_SHADER, vertexSource);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program,vs); gl.attachShader(program,fs); gl.linkProgram(program);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(program,gl.LINK_STATUS))
      throw new Error("WebGL program link failed: " + gl.getProgramInfoLog(program));
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program,"guestFrame"),0);
    return { gl, program, texture };
  }

  function releaseRenderer() {
    const gl = state.gl;
    if (!gl) return;
    try {
      if (state.texture) gl.deleteTexture(state.texture);
      if (state.program) gl.deleteProgram(state.program);
    } catch (_) { /* a lost context cannot delete objects */ }
  }

  function attach(canvas) {
    if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError("A canvas is required");
    /*
     * Attaching the same canvas twice must reuse the live renderer. The page
     * and the QEMU frame adapter both attach during startup; rebuilding the
     * WebGL context there used to discard the first program/texture and cost
     * an extra GPU context on iPad.
     */
    if (state.canvas === canvas && state.gl && !state.contextLost && !state.gl.isContextLost()) {
      state.stopped = false;
      return getStats();
    }
    if (state.canvas && state.canvas !== canvas) {
      state.canvas.removeEventListener("webglcontextlost", onContextLost, false);
      state.canvas.removeEventListener("webglcontextrestored", onContextRestored, false);
    }
    releaseRenderer();
    const renderer = buildRenderer(canvas);
    state.canvas = canvas;
    state.gl = renderer.gl;
    state.program = renderer.program;
    state.texture = renderer.texture;
    state.width = 0;
    state.height = 0;
    state.frames = 0;
    state.frameTimes = [];
    state.stopped = false;
    state.lastUploadAt = 0;
    state.contextLost = false;
    canvas.addEventListener("webglcontextlost", onContextLost, false);
    canvas.addEventListener("webglcontextrestored", onContextRestored, false);
    return getStats();
  }

  function onContextLost(event) {
    if (event && event.cancelable) event.preventDefault();
    state.contextLost = true;
  }

  function onContextRestored() {
    if (!state.canvas) return;
    try {
      const renderer = buildRenderer(state.canvas);
      state.gl = renderer.gl;
      state.program = renderer.program;
      state.texture = renderer.texture;
      state.contextLost = false;
      state.stopped = false;
      state.width = 0;
      state.height = 0;
      state.lastUploadAt = 0;
      state.restored++;
    } catch (error) {
      state.contextLost = true;
    }
  }

  function presentFrame(frame) {
    if (state.stopped || state.contextLost) return false;
    if (!state.gl) throw new Error("Start the WebPC GPU display before presenting frames");
    if (!frame || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) ||
       frame.width<1 || frame.height<1 || frame.width>4096 || frame.height>4096)
      throw new RangeError("Invalid guest framebuffer dimensions (1–4096)");
    const bytes=frame.width*frame.height*4, pixels=frame.pixels;
    if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) || pixels.byteLength!==bytes)
      throw new TypeError("Expected width × height × 4 RGBA bytes");
    const now=performance.now();
    if(state.lastUploadAt && now-state.lastUploadAt < 1000/state.maxFps) return false;
    const gl=state.gl;
    if(state.width!==frame.width || state.height!==frame.height) {
      state.canvas.width=frame.width; state.canvas.height=frame.height;
      /* Keep the display area's shape in sync with the guest mode, so a
         4:3 guest mode is not letterboxed into a 16:9 box (or vice versa). */
      state.canvas.style.aspectRatio = frame.width + " / " + frame.height;
      state.width=frame.width; state.height=frame.height;
      gl.viewport(0,0,frame.width,frame.height);
      gl.bindTexture(gl.TEXTURE_2D,state.texture);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,frame.width,frame.height,0,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    } else {
      gl.bindTexture(gl.TEXTURE_2D,state.texture);
      gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,frame.width,frame.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    }
    gl.useProgram(state.program); gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D,state.texture); gl.drawArrays(gl.TRIANGLES,0,3);
    if(gl.getError()!==gl.NO_ERROR) throw new Error("WebGL error while uploading/drawing guest frame");
    state.frames++; state.lastFrameAt=now; state.lastUploadAt=now;
    state.frameTimes.push(now); state.frameTimes=state.frameTimes.filter(t=>now-t<1000);
    return true;
  }

  function setInputSink(callback) {
    if(callback!==null && typeof callback!=="function") throw new TypeError("Input sink must be a function or null");
    state.sink=callback;
  }

  function sendInput(event) {
    if(!state.sink || state.stopped) return false;
    state.sink(Object.freeze({...event,timestamp:performance.now()})); return true;
  }

  function setFrameCap(fps) {
    if(!Number.isFinite(fps) || fps<1 || fps>60) throw new RangeError("FPS cap must be between 1 and 60");
    state.maxFps=fps; return fps;
  }

  function getStats() {
    const gl=state.gl;
    const lost=!gl||state.contextLost||gl.isContextLost();
    return Object.freeze({gpu:"WebGL 2",renderer:lost?"unavailable":gl.getParameter(gl.RENDERER),
      vendor:lost?"unavailable":gl.getParameter(gl.VENDOR),width:state.width,height:state.height,
      frames:state.frames,fps:state.frameTimes.length,lastFrameAt:state.lastFrameAt,
      maxFps:state.maxFps,contextLost:lost,restored:state.restored,inputConnected:!!state.sink});
  }

  function stop() {
    state.stopped=true; state.sink=null;
    if(state.canvas) {
      state.canvas.removeEventListener("webglcontextlost", onContextLost);
      state.canvas.removeEventListener("webglcontextrestored", onContextRestored);
    }
    releaseRenderer();
    state.canvas=null; state.gl=null; state.program=null; state.texture=null;
  }

  window.WebPCGPU = Object.freeze({attach,presentFrame,setInputSink,sendInput,setFrameCap,getStats,stop});
  // Compatibility facade for the existing QEMU framebuffer adapter.
  window.WebPCGraphicsBridge = Object.freeze({
    attach, presentFrame, setInputSink, sendInput, getStats, stop
  });
})();
