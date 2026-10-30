"""T2-only native form; its saved UTF-8 file is an oracle independent of the desktop runtime."""

from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

window = Gtk.Window(title="Deskmates T2 Fixture")
window.set_default_size(520, 180)
window.connect("destroy", Gtk.main_quit)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
box.set_border_width(16)
window.add(box)
entry = Gtk.Entry()
entry.get_accessible().set_name("Verification text")
entry.set_placeholder_text("Verification text")
box.pack_start(entry, False, False, 0)
status = Gtk.Label(label="Not saved")


def save(_button):
    Path("/tmp/deskmates-native-fixture.txt").write_text(entry.get_text(), encoding="utf-8")
    status.set_text("Saved")


button = Gtk.Button(label="Save verification")
button.connect("clicked", save)
box.pack_start(button, False, False, 0)
box.pack_start(status, False, False, 0)
window.show_all()
Gtk.main()
