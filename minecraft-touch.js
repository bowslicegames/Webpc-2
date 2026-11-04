/* iPad-oriented Minecraft touch controls and guest-window presentation shell.
 * This forwards controls to the QEMU adapter. Actual game input only works
 * after the native QEMU input ABI is wired to QEMU input devices.
 */
(() => {
  "use strict";
  const canvas = document.getElementById("guestDisplayCanvas");
  const status = document.getElementById("guestDisplayStatus");
  if (!canvas || !canvas.parentElement) return;

  const style = document.createElement("style");
  style.textContent = `
    #mcTouchPanel{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0;touch-action:none;user-select:none;-webkit-user-select:none}
    #mcTouchPanel .mc-pad{min-height:124px;border:1px solid #52677e;border-radius:12px;background:#111e2d;padding:8px;display:flex;align-items:center;justify-content:center;gap:7px;touch-action:none}
    #mcTouchPanel button{min-width:42px;min-height:42px;border:1px solid #66809c;border-radius:10px;background:#263f59;color:white;font-weight:700;font-size:15px;touch-action:none}
    #mcTouchPanel .mc-dpad{display:grid;grid-template-columns:repeat(3,44px);grid-template-rows:repeat(2,44px);gap:5px}
    #mcTouchPanel .mc-dpad button:nth-child(1){grid-column:2}
    #mcTouchPanel .mc-dpad button:nth-child(2){grid-column:1;grid-row:2}
    #mcTouchPanel .mc-dpad button:nth-child(3){grid-column:2;grid-row:2}
    #mcTouchPanel .mc-dpad button:nth-child(4){grid-column:3;grid-row:2}
    #mcTouchPanel .mc-actions{display:grid;grid-template-columns:repeat(2,minmax(44px,1fr));gap:7px;width:100%}
    #mcTouchPanel .mc-look{width:100%;height:100%;min-height:105px;border:1px dashed #71869b;border-radius:10px;color:#b9c9da;display:flex;align-items:center;justify-content:center;font-size:12px;text-align:center}
    #mcWindowToolbar{display:flex;gap:7px;flex-wrap:wrap;margin:8px 0}
    #mcWindowToolbar button{min-height:38px}
    #guestDisplayCanvas{touch-action:none;display:block;max-height:60vh;object-fit:contain}
    @media(max-width:600px){#mcTouchPanel{grid-template-columns:1fr 1fr}#mcTouchPanel .mc-pad{min-height:116px;padding:5px}}
  `;
  document.head.appendChild(style);

  const toolbar = document.createElement("div");
  toolbar.id = "mcWindowToolbar";
  toolbar.innerHTML = '<button class="ui-button primary" id="mcFullscreen" type="button">Fullscreen</button><button class="ui-button" id="mcFps" type="button" aria-label="Frame cap">Frame cap: 30 FPS</button><span class="info-status">Touch controls enabled · guest input bridge pending</span>';
  canvas.insertAdjacentElement("afterend", toolbar);

  const panel = document.createElement("div");
  panel.id = "mcTouchPanel";
  panel.setAttribute("aria-label", "Minecraft touch controls");
  panel.innerHTML = '<div class="mc-pad"><div class="mc-dpad"><button data-key="87">▲</button><button data-key="65">◀</button><button data-key="83">▼</button><button data-key="68">▶</button></div></div><div class="mc-pad"><div class="mc-look" id="mcLook">Drag here to look around</div></div><div class="mc-pad"><div class="mc-actions"><button data-key="32">Jump</button><button data-key="16">Sneak</button><button data-key="69">Inventory</button><button data-key="81">Drop</button></div></div><div class="mc-pad"><div class="mc-actions"><button data-mouse="0">Attack</button><button data-mouse="2">Place</button><button data-key="27">Pause</button><button data-key="9">Swap</button></div></div>';
  toolbar.insertAdjacentElement("afterend", panel);

  const keyNames = {87:"W",65:"A",83:"S",68:"D",32:" ",16:"Shift",69:"E",81:"Q",27:"Escape",9:"Tab"};
  const keyEvent = (code, down) => {
    if (window.WebPCQemuGraphics && window.WebPCQemuGraphics.sendInput) {
      window.WebPCQemuGraphics.sendInput({type:"key",codeValue:code,buttons:down?1:0});
    }
  };
  const mouseEvent = (button, down, x=canvas.width/2, y=canvas.height/2) => {
    if (window.WebPCQemuGraphics && window.WebPCQemuGraphics.sendInput) {
      window.WebPCQemuGraphics.sendInput({type:"pointer",codeValue:button,x,y,buttons:down?(button===2?2:1):0});
    }
  };
  panel.querySelectorAll("[data-key]").forEach(button => {
    const code = Number(button.dataset.key);
    const down = e => { e.preventDefault(); button.setPointerCapture?.(e.pointerId); keyEvent(code,true); };
    const up = e => { e.preventDefault(); keyEvent(code,false); };
    button.addEventListener("pointerdown",down);
    ["pointerup","pointercancel","lostpointercapture"].forEach(type=>button.addEventListener(type,up));
    button.addEventListener("contextmenu",e=>e.preventDefault());
  });
  panel.querySelectorAll("[data-mouse]").forEach(button => {
    const code=Number(button.dataset.mouse);
    button.addEventListener("pointerdown",e=>{e.preventDefault();mouseEvent(code,true);});
    ["pointerup","pointercancel","lostpointercapture"].forEach(type=>button.addEventListener(type,e=>{e.preventDefault();mouseEvent(code,false);}));
  });

  const look = document.getElementById("mcLook");
  let lookPointer = null;
  let lastX = 0, lastY = 0;
  look.addEventListener("pointerdown",e=>{e.preventDefault();lookPointer=e.pointerId;lastX=e.clientX;lastY=e.clientY;look.setPointerCapture(e.pointerId);});
  look.addEventListener("pointermove",e=>{
    if(lookPointer!==e.pointerId)return;
    const dx=e.clientX-lastX,dy=e.clientY-lastY;lastX=e.clientX;lastY=e.clientY;
    const rect=canvas.getBoundingClientRect();
    const x=Math.max(0,Math.min(canvas.width-1,Math.round((e.clientX-rect.left)*canvas.width/Math.max(1,rect.width))));
    const y=Math.max(0,Math.min(canvas.height-1,Math.round((e.clientY-rect.top)*canvas.height/Math.max(1,rect.height))));
    if(window.WebPCQemuGraphics?.sendInput)window.WebPCQemuGraphics.sendInput({type:"pointer",codeValue:255,x:x+Math.round(dx*4),y:y+Math.round(dy*4),buttons:1});
  });
  const stopLook=e=>{if(lookPointer===e.pointerId)lookPointer=null;};
  look.addEventListener("pointerup",stopLook);look.addEventListener("pointercancel",stopLook);

  document.getElementById("mcFullscreen").addEventListener("click",async()=>{
    const target=canvas.closest("#minecraftWindow")||canvas;
    try { if(!document.fullscreenElement) await target.requestFullscreen?.(); else await document.exitFullscreen?.(); }
    catch(error){if(status)status.textContent="Fullscreen unavailable in this browser: "+error.message;}
  });
  document.getElementById("mcFps").addEventListener("click",()=>{
    if(status)status.textContent="Display polling is capped at 30 FPS. The guest framebuffer ABI is still required before frames can appear.";
  });
  window.addEventListener("blur",()=>panel.querySelectorAll("[data-key]").forEach(b=>keyEvent(Number(b.dataset.key),false)));
})();
