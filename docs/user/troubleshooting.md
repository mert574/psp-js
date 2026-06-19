# Troubleshooting

## No sound

Audio is **off by default**. The **Disable audio** option on the options screen is checked. Uncheck it before booting to get sound. See [Settings](/user/settings#audio).

## A game won't boot or hangs

- Make sure you provided a real, complete ISO/PBP dump. Encrypted retail EBOOTs are supported (they're KIRK-decrypted automatically), but a truncated or corrupt image won't load.
- Open the [debug panel](/user/debug-panel) and check the **Stubs Called** section: a long list of unimplemented syscalls means the game relies on something not yet emulated. The **Logs** and **Threads** sections show where it got stuck (e.g. every thread `WAITING`).

## It's running slowly

- Use the **WebGL** renderer (the default). **Software** is much slower and is mainly for debugging.
- On WebGL, lower the **Resolution** multiplier to 1× (higher values render more pixels and cost GPU time). Software has no scaling: it always renders at native 480×272.
- Open Performance in the debug panel to see whether the CPU (interpreter + GE) or the GPU is the bottleneck.
- A background tab is throttled by the browser, so the game pauses when it isn't visible.

## Colors look wrong or the image is off

The WebGL and Software renderers can render the same scene slightly differently. WebGL is the reference. If something looks wrong on one, switch renderers from the debug panel's **Renderer** toggle to compare. See [GPU (GE)](/systems/gpu-ge).

## "SharedArrayBuffer is not defined" / blank page

The page must be served with the cross-origin isolation headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The dev/preview server sets these automatically. If you self-host the build, your server must send them too, or `SharedArrayBuffer` (and the app) won't work.

## Saves disappeared

Your savedata (the game's own in-game saves) lives in the browser's storage (IndexedDB), so clearing site data or using private/incognito mode wipes it. Save states are separate: they are `.pspstate` files you export and keep on your own machine, so they are not affected. See [Saves](/user/saves).
