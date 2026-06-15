import { Key } from "./ui";

export function ShortcutPanel() {
  return (
    <div className="shortcut-panel">
      <div><Key>Space</Key> Play / pause</div>
      <div><Key>←</Key><Key>→</Key> Step frame (Shift = 1s)</div>
      <div><Key>Home</Key><Key>End</Key> Jump to start / end</div>
      <div><Key>R</Key> Razor</div>
      <div><Key>J</Key> Stitch</div>
      <div><Key>T</Key> Text tool</div>
      <div><Key>S</Key> Split</div>
      <div><Key>D</Key> Duplicate</div>
      <div><Key>Del</Key> Delete</div>
      <div><Key>Shift Del</Key> Ripple delete</div>
      <div><Key>← → ↑ ↓</Key> Nudge text (Shift = 10px)</div>
      <div><Key>[</Key><Key>]</Key> Select scene</div>
      <div><Key>+</Key><Key>-</Key> Scene speed</div>
      <div><Key>A</Key> Add scene</div>
      <div><Key>X</Key> Context menu</div>
      <div><Key>E</Key> Scene tab</div>
      <div><Key>C</Key> Color/effects</div>
      <div><Key>M</Key> Mix tab</div>
      <div><Key>1</Key><Key>2</Key><Key>3</Key> Audio tracks</div>
      <div><Key>Cmd S</Key> Save</div>
      <div><Key>Cmd Shift S</Key> Save & render</div>
      <div><Key>Cmd Z</Key> Undo</div>
      <div><Key>Cmd Shift Z</Key><Key>Cmd Y</Key> Redo</div>
      <div><Key>?</Key> Toggle this panel</div>
      <div><Key>Esc</Key> Close tools</div>
    </div>
  );
}
