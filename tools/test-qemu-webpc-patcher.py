#!/usr/bin/env python3
import subprocess
import tempfile
from pathlib import Path

repo = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as tmp:
    qemu = Path(tmp)
    (qemu / "ui").mkdir()
    (qemu / "ui" / "console.c").write_text(
        '#include "ui/console.h"\n'
        'void dpy_gfx_update(QemuConsole *con, int x, int y, int w, int h) {\n'
        '    w = MIN(w, width - x);\n'
        '    h = MIN(h, height - y);\n'
        '\n'
        '\n'
        '    if (!qemu_console_is_visible(con)) {\n'
        '        return;\n'
        '    }\n'
        '    dpy_gfx_update_texture(con, con->surface, x, y, w, h);\n'
        '}\n'
    )
    (qemu / "ui" / "meson.build").write_text(
        "system_ss.add(files(\n  'clipboard.c',\n  'console.c',\n))\n"
    )
    patcher = repo / "tools" / "patch-qemu-webpc-display.py"
    subprocess.run(["python3", str(patcher), str(qemu)], check=True)
    console = (qemu / "ui" / "console.c").read_text()
    meson = (qemu / "ui" / "meson.build").read_text()
    assert console.count('#include "webpc-qemu-hook.h"') == 1
    assert console.count("webpc_qemu_capture_surface(con->surface);") == 1
    assert console.index("webpc_qemu_capture_surface(con->surface);") < console.index("if (!qemu_console_is_visible(con))")
    assert meson.count("'webpc-display-abi.c'") == 1
    assert meson.count("'webpc-qemu-hook.c'") == 1
    subprocess.run(["python3", str(patcher), str(qemu)], check=True)
    assert console.count("webpc_qemu_capture_surface(con->surface);") == 1
print("QEMU WebPC framebuffer patcher fixture passed.")
