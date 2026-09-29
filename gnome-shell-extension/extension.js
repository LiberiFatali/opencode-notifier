import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js'

const interfaceXml = `<node>
  <interface name="org.gnome.Shell.Extensions.OpenCodeNotifier">
    <method name="CaptureWindow"><arg type="s" direction="out"/></method>
    <method name="ActivateWindow"><arg name="id" type="s" direction="in"/><arg type="b" direction="out"/></method>
  </interface>
</node>`

export default class OpenCodeNotifier extends Extension {
  enable() {
    // Include this enable cycle in IDs so a stale notification cannot target a new window after reload.
    this._generation = GLib.uuid_string_random()
    this._bridge = Gio.DBusExportedObject.wrapJSObject(interfaceXml, this)
    this._bridge.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/OpenCodeNotifier')
  }

  disable() {
    this._bridge?.unexport()
    this._bridge = null
    this._generation = null
  }

  CaptureWindow() {
    const window = global.display.get_focus_window()
    return window ? `${this._generation}:${window.get_stable_sequence()}` : ''
  }

  ActivateWindow(id) {
    if (!this._generation || !id.startsWith(`${this._generation}:`)) return false
    const window = global.get_window_actors().map(actor => actor.meta_window)
      .find(candidate => `${this._generation}:${candidate.get_stable_sequence()}` === id)
    if (!window) return false
    Main.activateWindow(window)
    return true
  }
}
