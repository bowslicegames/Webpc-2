#!/usr/bin/env python3
"""Apply WebPC's bounded framebuffer capture hook to the pinned QEMU-Wasm tree."""
from pathlib import Path
import shutil, sys
repo=Path(__file__).resolve().parents[1]
qemu=Path(sys.argv[1]).resolve()
ui=qemu/"ui"
for name in ("webpc-display-abi.h","webpc-display-abi.c","webpc-qemu-hook.h","webpc-qemu-hook.c"):
    shutil.copy2(repo/"qemu-webpc-display"/name,ui/name)
block_dir=qemu/"block"; shutil.copy2(repo/"qemu-webpc-display"/"webpc-opfs.c",block_dir/"webpc-opfs.c")
console=ui/"console.c"; source=console.read_text()
inc='#include "webpc-qemu-hook.h"'; anchor='#include "ui/console.h"'
if inc not in source:
    if source.count(anchor)!=1: raise SystemExit("QEMU console include anchor changed; refusing unsafe patch")
    source=source.replace(anchor,anchor+"\n"+inc,1)
call="    webpc_qemu_capture_surface(con->surface);"
anchor="    w = MIN(w, width - x);\n    h = MIN(h, height - y);\n\n    if (!qemu_console_is_visible(con)) {"
if call not in source:
    if source.count(anchor)!=1: raise SystemExit("QEMU visibility/update anchor changed; refusing unsafe patch")
    source=source.replace(anchor,"    w = MIN(w, width - x);\n    h = MIN(h, height - y);\n\n"+call+"\n\n    if (!qemu_console_is_visible(con)) {",1)
console.write_text(source)
meson=ui/"meson.build"; source=meson.read_text()
anchor="  'clipboard.c',"; entries=["  'webpc-display-abi.c',","  'webpc-qemu-hook.c',"]
if not all(x in source for x in entries):
    if source.count(anchor)!=1: raise SystemExit("QEMU UI Meson anchor changed; refusing unsafe patch")
    source=source.replace(anchor,anchor+"\n"+"\n".join(entries),1)
meson.write_text(source)
block=qemu/"block"/"meson.build"; source=block.read_text()
anchor="  'null.c',"; entry="  'webpc-opfs.c',"
if entry not in source:
    if source.count(anchor)!=1: raise SystemExit("QEMU block Meson anchor changed; refusing unsafe patch")
    source=source.replace(anchor,anchor+"\n"+entry,1)
block.write_text(source)
print("Applied WebPC framebuffer and OPFS hooks to",qemu)
