/**
 * PSP button bitmask — matches the PSP's internal pad bits.
 */
export const enum PspButton {
  Select    = 0x0001,
  Start     = 0x0008,
  Up        = 0x0010,
  Right     = 0x0020,
  Down      = 0x0040,
  Left      = 0x0080,
  LTrigger  = 0x0100,
  RTrigger  = 0x0200,
  Triangle  = 0x1000,
  Circle    = 0x2000,
  Cross     = 0x4000,
  Square    = 0x8000,
}

export interface AnalogState {
  x: number;
  y: number;
}

export interface InputSnapshot {
  buttons: number;
  analog: AnalogState;
}

const KEY_TO_BUTTON: Record<string, PspButton> = {
  ArrowUp:    PspButton.Up,
  ArrowDown:  PspButton.Down,
  ArrowLeft:  PspButton.Left,
  ArrowRight: PspButton.Right,
  KeyZ:       PspButton.Cross,
  KeyX:       PspButton.Circle,
  KeyA:       PspButton.Square,
  KeyS:       PspButton.Triangle,
  KeyQ:       PspButton.LTrigger,
  KeyE:       PspButton.RTrigger,
  Enter:      PspButton.Start,
  ShiftLeft:  PspButton.Select,
  ShiftRight: PspButton.Select,
};

export class InputHandler {
  private heldKeys = new Set<string>();

  constructor() {
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp   = this._onKeyUp.bind(this);
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup",   this._onKeyUp);
  }

  private _onKeyDown(e: KeyboardEvent): void {
    if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.code)) {
      e.preventDefault();
    }
    this.heldKeys.add(e.code);
  }

  private _onKeyUp(e: KeyboardEvent): void {
    this.heldKeys.delete(e.code);
  }

  snapshot(): InputSnapshot {
    let buttons = 0;

    for (const [code, btn] of Object.entries(KEY_TO_BUTTON)) {
      if (this.heldKeys.has(code)) buttons |= btn;
    }

    let ax = 0, ay = 0;
    if (this.heldKeys.has("KeyD")) ax += 1;
    if (this.heldKeys.has("KeyA")) ax -= 1;
    if (this.heldKeys.has("KeyS")) ay += 1;
    if (this.heldKeys.has("KeyW")) ay -= 1;

    const pad = this._firstGamepad();
    if (pad) {
      const B = pad.buttons;
      const mapBtn = (idx: number, psp: PspButton) => {
        if (B[idx]?.pressed) buttons |= psp;
      };
      mapBtn(0,  PspButton.Cross);
      mapBtn(1,  PspButton.Circle);
      mapBtn(2,  PspButton.Square);
      mapBtn(3,  PspButton.Triangle);
      mapBtn(4,  PspButton.LTrigger);
      mapBtn(5,  PspButton.RTrigger);
      mapBtn(8,  PspButton.Select);
      mapBtn(9,  PspButton.Start);
      mapBtn(12, PspButton.Up);
      mapBtn(13, PspButton.Down);
      mapBtn(14, PspButton.Left);
      mapBtn(15, PspButton.Right);

      const axes = pad.axes;
      if (Math.abs(axes[0]) > 0.1) ax = axes[0];
      if (Math.abs(axes[1]) > 0.1) ay = axes[1];
    }

    return { buttons, analog: { x: ax, y: ay } };
  }

  private _firstGamepad(): Gamepad | null {
    for (const gp of navigator.getGamepads()) {
      if (gp && gp.connected) return gp;
    }
    return null;
  }

  destroy(): void {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup",   this._onKeyUp);
    this.heldKeys.clear();
  }
}
