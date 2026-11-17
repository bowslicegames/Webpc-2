#!/usr/bin/env python3
"""Copy tools/webpc-minecraft-display.sh into the disk installer and the page.

The guest launcher exists in three places: the canonical script, the heredoc that
the disk build bakes into the image, and the base64 constant the page writes when
the Launch button is pressed. Keeping them in step by hand once left the page
serving a launcher that could never fix the bug it was written for, so this
script is the only supported way to change them and it fails loudly on drift.
"""
import base64
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = (root / "tools" / "webpc-minecraft-display.sh").read_text()
b64 = base64.b64encode(source.encode()).decode()

installer = root / "tools" / "install-minecraft-prereqs.sh"
text = installer.read_text()
begin = "cat > /usr/local/bin/webpc-minecraft-display <<'WEBPC_MC_EOF'\n"
if text.count(begin) != 1:
    sys.exit("installer launcher heredoc opener is missing or duplicated")
start = text.index(begin) + len(begin)
end = text.index("\nWEBPC_MC_EOF\n", start)
text = text[:start] + source.rstrip("\n") + text[end:]
if text.count("WEBPC_MC_EOF") != 2:
    sys.exit("installer has stray heredoc terminators: the disk build would abort")
installer.write_text(text)

page = root / "index.html"
html = page.read_text()
pattern = re.compile(r'(const GUEST_DISPLAY_LAUNCHER_B64 = ")([A-Za-z0-9+/=]+)(";)')
if len(pattern.findall(html)) != 1:
    sys.exit("page is missing its single GUEST_DISPLAY_LAUNCHER_B64 constant")
html = pattern.sub(lambda match: match.group(1) + b64 + match.group(3), html)
page.write_text(html)

print("synced launcher: %d bytes source, %d base64 chars" % (len(source), len(b64)))
