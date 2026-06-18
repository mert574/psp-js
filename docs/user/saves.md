# Save States & Savedata

There are two ways your progress is kept: **savedata** (the game's own in-game saves) and **save states** (a snapshot of the whole machine).

## Savedata

Savedata is what a game writes when you use its own save feature. psp-js persists it in the browser (IndexedDB), so it survives across sessions like a real memory stick. The **Save Data** section of the [debug panel](/user/debug-panel) lists a game's saves (read-only); loading and deleting happen through the game's own save menu.

## Save states

A save state captures the entire emulator at an instant: CPU, memory, kernel, and GPU state. Restoring one drops you back to that exact moment. Manage them from the **Save State** section of the debug panel:

- **Export** writes a `.pspstate` file you can download.
- **Import** loads a `.pspstate` back into the running game.

### Things to know

- A save state is **bound to the game and its EBOOT**. You can't load one game's state into another, and a different build of the same game is rejected by default (the debug panel offers a Force import to override).
- Bundled fonts reload fine on restore, but a video that's mid-playback may glitch a single frame.
- Save states are also a developer tool: a `.pspstate` exported from the browser can be replayed headless to reproduce a bug. See [Storage & Save States](/systems/storage-state).
