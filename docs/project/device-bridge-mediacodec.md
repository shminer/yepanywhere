# Android Real-Device Streaming: MediaCodec Hardware Encoding

## Problem

The current real-device capture pipeline polls screenshot APIs per frame. Each call to `ScreenCapture.capture()` or `SurfaceControl.captureDisplay()` costs ~400ms on a Pixel 7a (Android 16), capping throughput at ~2.5 fps before any streaming overhead. The bottleneck is on-device capture, not WebRTC or x264.

Current pipeline (per frame):
```
Screenshot API call (~400ms)
  → Hardware bitmap → software copy
  → Optional downscale
  → JPEG encode (Bitmap.compress)
  → TCP send to Go sidecar
  → JPEG decode → RGB → I420 → x264 encode
  → WebRTC RTP
```

## Solution: Continuous VirtualDisplay → Hardware H.264

Replace per-frame screenshot polling with a persistent VirtualDisplay that mirrors the physical screen into a hardware MediaCodec encoder. The encoder outputs H.264 NAL units continuously — no bitmap readback, no CPU image processing, no re-encoding on the Go side.

New pipeline:
```
SurfaceControl.createDisplay() (once)
  → VirtualDisplay mirrors physical screen (continuous)
  → MediaCodec hardware H.264 encoder (continuous)
  → NAL units over TCP to Go sidecar
  → Go forwards NALs directly to WebRTC
```

Expected improvement: ~2.5 fps / 400ms latency → 30-60 fps / <50ms latency.

## Why SurfaceControl, Not MediaProjection

Both can create a VirtualDisplay that mirrors the screen. The difference:

| | SurfaceControl | MediaProjection |
|---|---|---|
| User consent dialog | No | Yes (system UI prompt) |
| Shell user access | Yes (hidden API, reflection) | Unreliable from shell context |
| scrcpy uses it | Yes | No |
| API stability | Hidden API, changes across versions | Public API, stable |

Since `DeviceServer.java` already runs as shell user via `app_process` and already uses reflection for `SurfaceControl` screenshot APIs, this is the natural progression. scrcpy has proven this approach works across Android 5–16.

## APK Changes (DeviceServer.java)

### New Streaming Mode

Add a `MediaCodecStreamer` class alongside the existing `FrameCapturer` backends. The existing screenshot path stays intact for single-frame capture (agent CLI, etc.); streaming uses the new path.

**Activation:** New control command starts/stops the stream:
```json
{"cmd": "stream_start", "width": 720, "height": 1600, "bitrate": 2000000, "fps": 30}
{"cmd": "stream_stop"}
```

When streaming is active, the device pushes NAL units continuously instead of waiting for `0x01` frame requests.

### Key Components

**1. VirtualDisplay setup (reflection)**

```java
// Get SurfaceControl class (already loaded for screenshot backend)
Class<?> scClass = Class.forName("android.view.SurfaceControl");

// Create a virtual display token
// SurfaceControl.createDisplay(String name, boolean secure)
Method createDisplay = scClass.getMethod("createDisplay", String.class, boolean.class);
Object displayToken = createDisplay.invoke(null, "yep-stream", false);

// Configure the virtual display to mirror the physical display
// Uses SurfaceControl.Transaction to set display surface, projection, and layer stack
```

**2. MediaCodec configuration**

```java
MediaFormat format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height);
format.setInteger(MediaFormat.KEY_COLOR_FORMAT,
    MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);        // e.g. 2 Mbps
format.setInteger(MediaFormat.KEY_FRAME_RATE, fps);           // e.g. 30
format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);       // Keyframe every 2s
format.setInteger(MediaFormat.KEY_BITRATE_MODE,
    MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR);
format.setInteger(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000); // µs

MediaCodec codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);

// The encoder's input Surface — VirtualDisplay renders into this
Surface inputSurface = codec.createInputSurface();
codec.start();
```

**3. Encoder output loop**

```java
// Runs in a dedicated thread
MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
while (streaming) {
    int index = codec.dequeueOutputBuffer(info, 100_000); // 100ms timeout
    if (index >= 0) {
        ByteBuffer buf = codec.getOutputBuffer(index);
        // Send NAL unit(s) over TCP
        sendNalUnit(buf, info);
        codec.releaseOutputBuffer(index, false);
    }
}
```

### Dynamic Controls (No Pipeline Restart)

All adjustable mid-stream via existing `0x03` control commands:

```json
{"cmd": "stream_bitrate", "bps": 1000000}
{"cmd": "stream_fps", "fps": 15}
{"cmd": "stream_keyframe"}
```

Implementation:
```java
// Bitrate change — takes effect within 1-2 frames
Bundle params = new Bundle();
params.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, newBitrate);
codec.setParameters(params);

// Keyframe request — next frame is an I-frame
Bundle kf = new Bundle();
kf.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
codec.setParameters(kf);

// FPS change — update KEY_FRAME_RATE (advisory) + throttle dequeue
targetFps = newFps;
```

### Wire Protocol Extension

New message type for streaming NAL units (device → sidecar):

```
Stream NAL (device → sidecar, push-based):
  [0x05][flags u8][len u32 LE][H.264 NAL bytes]

  flags:
    bit 0: keyframe (1 = IDR frame, 0 = P-frame)
    bit 1: config (1 = SPS/PPS, 0 = frame data)
```

`0x05` distinguishes stream data from `0x02` JPEG frame responses. The existing `0x01`/`0x02` request-response protocol continues to work for single-frame screenshots when not streaming.

The `flags` byte lets the Go side make drop decisions without parsing H.264:
- Always forward `config` packets (SPS/PPS) — needed to initialize the decoder
- Can safely drop non-keyframe packets during congestion
- After dropping, request a keyframe to resync

## Go Sidecar Changes (device-bridge)

### New Stream Mode in AndroidDevice

`AndroidDevice` gains a `StartStream()`/`StopStream()` method pair. When streaming:

- Sends `stream_start` command to the APK
- Switches from poll-based `GetFrame()` to push-based NAL reader
- Exposes NALs through a new `NalSource` (analogous to `FrameSource`)

```go
type NalUnit struct {
    Data     []byte
    Keyframe bool
    Config   bool  // SPS/PPS
}

type NalSource struct {
    // Same subscribe/unsubscribe pattern as FrameSource
}
```

### Pipeline Bypass

When streaming from a real device with MediaCodec, the pipeline in `signaling.go` changes from:

```
FrameSource → ScaleAndConvertToI420 → H264Encoder.Encode → WriteVideoSample
```

to:

```
NalSource → WriteVideoSample (direct passthrough)
```

The `FrameSource` / `H264Encoder` path remains for emulators (gRPC screenshots → x264).

The `SignalingHandler` / `runPipeline` need to support both modes. Options:
- **Interface approach:** Define a `VideoSource` interface with `Subscribe()`/`Unsubscribe()` that both `FrameSource`+encoder and `NalSource` implement
- **Flag approach:** `runPipeline` checks the device type and runs the appropriate loop

The interface approach is cleaner since the signaling handler shouldn't know about device types.

### Backpressure & Adaptive Quality

The Go side monitors congestion and sends control commands back to the APK:

**Congestion detection signals:**
1. **WebRTC RTCP feedback** — Pion fires PLI (Picture Loss Indication) when the browser detects missing frames. Already handled via `ReadRTCP()` in `peer.go`.
2. **NAL queue depth** — if the subscriber channel backs up, frames are arriving faster than they can be sent.
3. **Write errors** — `WriteVideoSample` failures indicate transport congestion.

**Response strategy (progressive):**

```
1. Mild congestion (queue > 2 NALs):
   → Reduce bitrate by 25%
   → Send {"cmd": "stream_bitrate", "bps": <reduced>}

2. Moderate congestion (queue > 5 NALs or PLI received):
   → Reduce FPS (30 → 15 → 10)
   → Send {"cmd": "stream_fps", "fps": <reduced>}
   → Request keyframe + drop queued non-keyframe NALs

3. Severe congestion (sustained for >2s):
   → Drop to minimum (10fps, 500kbps)
   → Request keyframe, flush queue

4. Recovery (queue empty for >1s):
   → Ramp bitrate back up by 25% per second
   → Ramp FPS back up (10 → 15 → 30)
```

**NAL dropping rules:**
- Never drop SPS/PPS config packets
- Never drop keyframes (IDR)
- Can drop P-frames, but must request a keyframe afterward
- After any drop, the next forwarded frame must be a keyframe

### Resolution Changes

Resolution requires recreating the VirtualDisplay and MediaCodec (can't resize mid-stream). The Go side sends:

```json
{"cmd": "stream_stop"}
{"cmd": "stream_start", "width": 540, "height": 1200, "bitrate": 1000000, "fps": 30}
```

This causes a brief interruption (~100ms). Use sparingly — prefer bitrate/fps adjustment first.

## Compatibility & Fallback

The MediaCodec path requires:
- `SurfaceControl.createDisplay()` — available Android 5+ from shell user
- `MediaCodec` with `COLOR_FormatSurface` — available Android 5+

If the hardware encoder fails to initialize (rare but possible on some OEM ROMs), fall back to the existing screenshot-polling path gracefully. The APK logs the failure and responds to `stream_start` with an error response, so the Go side knows to use `GetFrame()` polling instead.

## Implementation Phases

### Phase 1 — MediaCodec streaming in APK

1. Add `MediaCodecStreamer` class to `DeviceServer.java`
   - VirtualDisplay setup via `SurfaceControl.createDisplay()` reflection
   - MediaCodec H.264 encoder with `createInputSurface()`
   - Output loop reading NAL units and sending via `0x05` messages
2. Add `stream_start` / `stream_stop` / `stream_bitrate` / `stream_fps` / `stream_keyframe` command handlers
3. Test standalone: `adb forward` + read raw NAL output, verify with ffprobe/ffplay

### Phase 2 — Go sidecar NAL passthrough

1. Add `0x05` message parsing to `conn` package
2. Add `NalSource` with subscribe/unsubscribe (mirrors `FrameSource` API)
3. Add `StartStream()` / `StopStream()` to `AndroidDevice`
4. Modify `runPipeline` to support NAL passthrough mode (skip JPEG decode + x264)
5. Test: real device → WebRTC → browser video at 30fps

### Phase 3 — Adaptive quality

1. Add congestion detection (queue depth monitoring, PLI forwarding)
2. Implement progressive backpressure (bitrate → fps → resolution)
3. Add recovery ramp-up logic
4. Wire PLI from Pion RTCP → `stream_keyframe` command to APK

### Phase 4 — Polish

1. Auto-detect device capability: try `stream_start`, fall back to polling if it fails
2. Client UI: show current stream stats (fps, bitrate, resolution)
3. Client controls: manual quality override (low/medium/high presets)
4. Benchmark: measure end-to-end latency and fps on multiple devices

## File Locations

| Component | Path |
|-----------|------|
| APK source | `packages/android-device-server/app/src/main/java/com/yepanywhere/DeviceServer.java` |
| Go device abstraction | `packages/device-bridge/internal/device/android_device.go` |
| Go frame source | `packages/device-bridge/internal/device/frame_source.go` |
| Go encoder (emulator path) | `packages/device-bridge/internal/encoder/h264.go` |
| Go WebRTC pipeline | `packages/device-bridge/internal/stream/signaling.go` |
| Wire protocol | `packages/device-bridge/internal/conn/framing.go` |
| This doc | `docs/project/device-bridge-mediacodec.md` |
