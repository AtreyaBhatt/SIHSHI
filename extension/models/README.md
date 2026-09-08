# Local model weights

Not committed — `.gitignore` excludes `*.onnx`. Fetch with:

```
cd extension && npm run fetch:model
```

## version-RFB-320.onnx — face detection

| | |
|---|---|
| Source | ONNX Model Zoo, `validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx` |
| Upstream | Ultra-Light-Fast-Generic-Face-Detector-1MB (Linzaer) |
| License | MIT |
| Size | 1.21 MB (1,270,727 bytes) |
| SHA-256 | `34cd7e60aeff28744c657de7a3dc64e872d506741de66987f3426f2b79f88017` |
| Input | `input` — float32 `[1, 3, 240, 320]`, RGB planar, `(x - 127) / 128` |
| Outputs | `scores` `[1, 4420, 2]` (index 1 = face), `boxes` `[1, 4420, 4]` normalised xyxy, already decoded |
| Opset | 9 |

Verify after fetching:

```
sha256sum extension/models/version-RFB-320.onnx
```

### Why not BlazeFace

PRD §6.2.3 names "BlazeFace (TF.js) or an ONNX-exported equivalent", and CLAUDE.md
requires all client-side inference to go through ONNX Runtime Web. BlazeFace's
canonical distribution is TF.js, so the ONNX-native equivalent is what ships.
UltraFace is the same class of model — a single-shot lightweight detector — at a
comparable size and accuracy.

### Measured (this machine, headless Chrome)

| | |
|---|---|
| Session init | ~235 ms, once per worker lifetime |
| Inference | ~31 ms per 320x240 pass, WASM SIMD |
| Provider | `wasm` on the default build (see below) |
| Detection | 25 faces on a 1024x791 group photo at threshold 0.6, every box in bounds |

## Runtime size, and the build flag

The ONNX Runtime wasm binary dominates the package, not the model:

| Build | Artifact | On disk | Gzipped | Providers |
|---|---|---|---|---|
| `npm run build` (default) | `ort-wasm-simd-threaded.wasm` | 13.3 MB | 3.4 MB | WASM SIMD |
| `PPVA_ORT_EP=webgpu npm run build` | `ort-wasm-simd-threaded.jsep.wasm` | 26.5 MB | 6.3 MB | WebGPU + WASM SIMD |

PRD §8 budgets under 20 MB of client payload. The default build totals ~15 MB
including the model and stays inside it; the WebGPU build does not. The runtime
code requests WebGPU first and falls back to WASM either way — with the default
artifact that fallback is simply always taken, which is the documented behaviour
rather than a failure. For a 320x240 single-shot detector the gap is small:
WebGPU's advantage shows on large batched work and is largely spent on shader
compilation for one inference.
