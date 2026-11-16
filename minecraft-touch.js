/* iPad-oriented Minecraft touch controls and guest-window presentation shell.
 * This forwards controls through the browser adapter into the QEMU Linux
 * input queue (keyboard, absolute tablet and relative look events).
 */
(() => {
  "use strict";
  const canvas = document.getElementById("guestDisplayCanvas");
  const status = document.getElementById("guestDisplayStatus");
  if (!canvas || !canvas.parentElement) return;

  const style = document.createElement("style");
  style.textContent = `
    #mcTouchPanel{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
    #mcTouchPanel .mc-pad{min-height:132px;border:1px solid #52677e;border-radius:12px;background:#111e2d;padding:8px;display:flex;align-items:center;justify-content:center;gap:7px;touch-action:none}
    #mcTouchPanel button{min-width:46px;min-height:46px;border:1px solid #66809c;border-radius:10px;background:#263f59;color:white;font-weight:700;font-size:15px;touch-action:none}
    #mcTouchPanel button:active{background:#3c648c}
    #mcTouchPanel .mc-dpad{display:grid;grid-template-columns:repeat(3,48px);grid-template-rows:repeat(2,48px);gap:5px}
    #mcTouchPanel .mc-dpad button:nth-child(1){grid-column:2}
    #mcTouchPanel .mc-dpad button:nth-child(2){grid-column:1;grid-row:2}
    #mcTouchPanel .mc-dpad button:nth-child(3){grid-column:2;grid-row:2}
    #mcTouchPanel .mc-dpad button:nth-child(4){grid-column:3;grid-row:2}
    #mcTouchPanel .mc-actions{display:grid;grid-template-columns:repeat(2,minmax(46px,1fr));gap:7px;width:100%}
    #mcTouchPanel .mc-actions button{font-size:13px}
    #mcTouchPanel .mc-hotbar{grid-column:1/-1;display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:4px}
    #mcTouchPanel .mc-hotbar button{min-width:0;min-height:44px;padding:0;font-size:13px}
    #mcTouchPanel .mc-look{width:100%;height:100%;min-height:112px;border:1px dashed #71869b;border-radius:10px;color:#b9c9da;display:flex;align-items:center;justify-content:center;font-size:12px;text-align:center;touch-action:none}
    #mcWindowToolbar{display:flex;gap:7px;flex-wrap:wrap;margin:8px 0;align-items:center}
    #mcWindowToolbar button{min-height:40px}
    #guestDisplayCanvas{touch-action:none;display:block;max-height:60vh;object-fit:contain;width:100%}
    #minecraftWindow.mc-pseudo-fullscreen{position:fixed!important;inset:0!important;z-index:2147483646;background:#05080d;overflow:auto;border-radius:0!important;max-height:none!important;width:100%!important;height:100dvh!important;padding:8px;box-sizing:border-box}
    #minecraftWindow.mc-pseudo-fullscreen #guestDisplayCanvas{max-height:calc(100dvh - 260px)!important;margin:0 auto!important}
    #minecraftWindow.mc-pseudo-fullscreen #mcTouchPanel{grid-template-columns:1fr 1fr}
    @media(max-width:600px){#mcTouchPanel{grid-template-columns:1fr 1fr}#mcTouchPanel .mc-pad{min-height:120px;padding:5px}#mcTouchPanel .mc-dpad{grid-template-columns:repeat(3,44px);grid-template-rows:repeat(2,44px)}}
    @media(orientation:landscape) and (max-height:820px){#mcTouchPanel{grid-template-columns:0.9fr 1.1fr 1fr 1fr}#mcTouchPanel .mc-pad{min-height:104px}#mcTouchPanel .mc-hotbar{grid-column:1/-1}}
  `;
  document.head.appendChild(style);

  const toolbar = document.createElement("div");
  toolbar.id = "mcWindowToolbar";
  toolbar.innerHTML = '<button class="ui-button primary" id="mcFullscreen" type="button">Fullscreen</button><button class="ui-button" id="mcFps" type="button" aria-label="Frame cap">Frame cap: 30 FPS</button><span class="info-status">Touch controls · drag the game view or the look pad to aim</span>';
  canvas.insertAdjacentElement("afterend", toolbar);

  const panel = document.createElement("div");
  panel.id = "mcTouchPanel";
  panel.setAttribute("aria-label", "Minecraft touch controls");
  panel.innerHTML = '<div class="mc-pad"><div class="mc-dpad" aria-label="Movement"><button data-key="87" aria-label="Forward">▲</button><button data-key="65" aria-label="Left">◀</button><button data-key="83" aria-label="Back">▼</button><button data-key="68" aria-label="Right">▶</button></div></div><div class="mc-pad"><div class="mc-look" id="mcLook">Drag here to look around</div></div><div class="mc-pad"><div class="mc-actions"><button data-key="32">Jump</button><button data-key="16">Sneak</button><button data-key="17">Sprint</button><button data-key="69">Inventory</button><button data-key="84">Chat</button><button data-key="81">Drop</button></div></div><div class="mc-pad"><div class="mc-actions"><button data-mouse="0">Attack</button><button data-mouse="2">Place</button><button data-key="27">Pause</button><button data-key="9">Swap</button><button data-key="116">View</button><button data-key="114">Debug</button></div></div><div class="mc-hotbar" aria-label="Hotbar slots"><button data-key="49">1</button><button data-key="50">2</button><button data-key="51">3</button><button data-key="52">4</button><button data-key="53">5</button><button data-key="54">6</button><button data-key="55">7</button><button data-key="56">8</button><button data-key="57">9</button></div>';
  toolbar.insertAdjacentElement("afterend", panel);

  const keyEvent = (code, down) => {
    if (window.WebPCQemuGraphics && window.WebPCQemuGraphics.sendInput) {
      window.WebPCQemuGraphics.sendKeyCode(code,down);
    }
  };
  const mouseEvent = (button, down) => {
    if (window.WebPCQemuGraphics && window.WebPCQemuGraphics.sendInput) {
      window.WebPCQemuGraphics.sendInput({type:"pointer",codeValue:254,x:0,y:0,buttons:down?(button===2?2:1):0});
    }
  };

  /* Touch buttons hold their key until the pointer is released. Track every
     key that is down so a hidden tab or an interrupted gesture cannot leave
     the guest walking forever. */
  const heldKeys = new Set();
  const pressKey = (code) => { heldKeys.add(code); keyEvent(code, true); };
  const releaseKey = (code) => { heldKeys.delete(code); keyEvent(code, false); };
  const releaseAllKeys = () => { [...heldKeys].forEach(releaseKey); };

  panel.querySelectorAll("[data-key]").forEach(button => {
    const code = Number(button.dataset.key);
    /* Send the key before attempting pointer capture: setPointerCapture can
       throw for an inactive pointer, and a thrown error there would swallow
       the key press entirely. */
    const down = e => { e.preventDefault(); pressKey(code); try { button.setPointerCapture?.(e.pointerId); } catch (_) {} };
    const up = e => { e.preventDefault(); releaseKey(code); };
    button.addEventListener("pointerdown",down);
    ["pointerup","pointercancel","lostpointercapture"].forEach(type=>button.addEventListener(type,up));
    button.addEventListener("contextmenu",e=>e.preventDefault());
  });
  panel.querySelectorAll("[data-mouse]").forEach(button => {
    const code=Number(button.dataset.mouse);
    button.addEventListener("pointerdown",e=>{e.preventDefault();mouseEvent(code,true);try{button.setPointerCapture?.(e.pointerId);}catch(_){}});
    ["pointerup","pointercancel","lostpointercapture"].forEach(type=>button.addEventListener(type,e=>{e.preventDefault();mouseEvent(code,false);}));
    button.addEventListener("contextmenu",e=>e.preventDefault());
  });

  const look = document.getElementById("mcLook");
  let lookPointer = null;
  let lastX = 0, lastY = 0;
  const LOOK_SENSITIVITY = 3;
  look.addEventListener("pointerdown",e=>{e.preventDefault();lookPointer=e.pointerId;lastX=e.clientX;lastY=e.clientY;try{look.setPointerCapture(e.pointerId);}catch(_){}});
  look.addEventListener("pointermove",e=>{
    if(lookPointer!==e.pointerId)return;
    const dx=e.clientX-lastX,dy=e.clientY-lastY;lastX=e.clientX;lastY=e.clientY;
    if(window.WebPCQemuGraphics?.sendInput)window.WebPCQemuGraphics.sendInput({type:"pointer",codeValue:255,x:Math.round(dx*LOOK_SENSITIVITY),y:Math.round(dy*LOOK_SENSITIVITY),buttons:0});
  });
  const stopLook=e=>{if(lookPointer===e.pointerId)lookPointer=null;};
  look.addEventListener("pointerup",stopLook);look.addEventListener("pointercancel",stopLook);look.addEventListener("lostpointercapture",stopLook);

  /* iPad Safari does not offer requestFullscreen() for arbitrary elements.
     Fall back to a fixed, full-viewport layout so the game area still fills
     the screen. */
  const fullscreenButton = document.getElementById("mcFullscreen");
  const target = canvas.closest("#minecraftWindow") || canvas;
  const isPseudoFullscreen = () => target.classList.contains("mc-pseudo-fullscreen");
  const setPseudoFullscreen = (on) => {
    target.classList.toggle("mc-pseudo-fullscreen", on);
    document.body.style.overflow = on ? "hidden" : "";
    fullscreenButton.textContent = on ? "Exit fullscreen" : "Fullscreen";
  };
  fullscreenButton.addEventListener("click",async()=>{
    if (isPseudoFullscreen()) { setPseudoFullscreen(false); return; }
    if (document.fullscreenElement) { await document.exitFullscreen?.(); return; }
    try {
      if (target.requestFullscreen && document.fullscreenEnabled) {
        await target.requestFullscreen();
        return;
      }
      setPseudoFullscreen(true);
    } catch (error) {
      setPseudoFullscreen(true);
      if(status)status.textContent="Using the in-page fullscreen layout: "+(error && error.message ? error.message : String(error));
    }
  });
  document.addEventListener("fullscreenchange", () => {
    fullscreenButton.textContent = document.fullscreenElement ? "Exit fullscreen" : "Fullscreen";
  });

  document.getElementById("mcFps").addEventListener("click",()=>{
    if(!window.WebPCGPU) return;
    const cap = window.WebPCGPU.getStats().maxFps === 30 ? 20 : 30;
    window.WebPCGPU.setFrameCap(cap);
    document.getElementById("mcFps").textContent = "Frame cap: " + cap + " FPS";
    if(status)status.textContent = "Display presentation capped at " + cap + " FPS to save iPad GPU and battery.";
  });

  const wasHidden = () => { releaseAllKeys(); };
  window.addEventListener("blur", releaseAllKeys);
  window.addEventListener("pagehide", releaseAllKeys);
  document.addEventListener("visibilitychange", () => { if (document.hidden) wasHidden(); });

  /* Live display diagnostics: update only when the text actually changes. */
  let lastDisplayText = "";
  const syncDisplayStatus = () => {
    if (!status || !window.WebPCQemuGraphics?.getStats) return;
    const s = window.WebPCQemuGraphics.getStats();
    /* Leave adapter errors and "missing ABI" messages alone until real
       frames exist, otherwise this diagnostic would overwrite them. */
    if (!s.connected || !s.framesPresented) return;
    const text = "Guest display: live · " + s.width + "×" + s.height +
      " · " + s.fps + " FPS · " + s.framesPresented + " frames";
    if (text !== lastDisplayText) { lastDisplayText = text; status.textContent = text; }
  };
  window.setInterval(syncDisplayStatus, 1000);
})();
