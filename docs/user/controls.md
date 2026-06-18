# Controls

Play with the keyboard or a gamepad. Input is read every frame and sampled by the emulated `sceCtrl` controller.

## Keyboard

| Key | PSP button |
| --- | --- |
| Arrow keys | D-pad (Up / Down / Left / Right) |
| `Z` | Cross (✕) |
| `X` | Circle (○) |
| `J` | Square (□) |
| `K` | Triangle (△) |
| `Q` | L trigger |
| `E` | R trigger |
| `Enter` | Start |
| `Shift` (left or right) | Select |
| `W` `A` `S` `D` | Analog stick (up / left / down / right) |

The arrow keys are captured so the page doesn't scroll while you play.

## Gamepad

A connected controller is detected through the browser's Gamepad API. Face buttons and triggers map to the PSP buttons, and the left analog stick maps to the PSP stick (with a small dead zone so a centered stick reads as neutral). The keyboard and gamepad work at the same time; whichever is pressed registers.
