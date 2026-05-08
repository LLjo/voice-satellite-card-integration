# On-Device Wake Word Detection

Voice Satellite includes built-in wake word detection that runs entirely in the browser - no server-side wake word service required. Two on-device engines are available: **microWakeWord** (default, runs everywhere) and **openWakeWord** (GPU-accelerated, requires WebGPU).

## Contents

- [Engines](#engines)
- [How It Works](#how-it-works)
- [Built-in Wake Words](#built-in-wake-words)
- [Custom Wake Words](#custom-wake-words)
- [Configuration](#configuration)
- [Dual Wake Words and Pipelines](#dual-wake-words-and-pipelines)
- [Disabled Mode](#disabled-mode)

## Engines

Both engines run entirely in the browser in pure JavaScript and produce the same wake-event output (state transitions, chimes, pipeline routing). They differ in model architecture and runtime requirements.

| | **microWakeWord** | **openWakeWord** |
|---|---|---|
| Where it runs | CPU only | Mel + embedding on GPU, classifiers on CPU |
| Architecture | Per-keyword streaming model. One full model per wake word | Shared mel + embedding feeding small per-keyword classifiers |
| Multi-keyword scaling | Each added keyword pays full model cost on CPU - doubles for two keywords | Near-flat - mel + embedding are shared, each added keyword adds only a sub-millisecond classifier |
| Detection robustness | Tight, narrow models tuned per-phrase. Strong on the trained phrase, less forgiving across speakers and accents | Larger embedding generalizes across speakers, accents, and acoustic conditions |
| Requires WebGPU | No | **Yes** - the engine refuses to start without it |
| Available on | Every device with `AudioWorklet` support | Devices reporting `navigator.gpu` (modern Chromium and Firefox builds, recent macOS/Windows/Android) |

### Why pick microWakeWord
- Works on every device, including older Android tablets and any browser without WebGPU.
- The microWakeWord wake-word collection has years of real-world tuning behind it and is what the ESPHome / HA Voice PE ecosystem ships.

### Why pick openWakeWord
- **Less false positives.** openWakeWord models significantly mitigate false positives due to its larger more complex models depending on the quality of the wake word used.
- **Same performance, increased reliability.** openWakeWord models are 10x the size of their microWakeWord counterparts but inference performance is nearly the same due to GPU acceleration.
- **Better generalization across speakers and accents.** The 96-dim shared embedding was trained on a much broader speech corpus than any single MWW model, so detection is more forgiving of who's talking and how.
- **Near-free multi-keyword scaling.** Mel + embedding are computed once per chunk regardless of how many keywords you've loaded. Adding a second keyword adds only a sub-millisecond classifier on the existing embedding output.

### Default and fallback
microWakeWord is the default detection mode on fresh installs because it works on every device. If you select openWakeWord on a device without WebGPU, the satellite shows an error toast and asks you to switch back - the GPU requirement is enforced, not a soft fallback.

If your device supports WebGPU and you're picking between the two: try openWakeWord when speaker / accent variability or false-positive sensitivity matter, or when you want behavior that mirrors the official HA OWW addon. Stick with microWakeWord if you want the lowest possible per-chunk latency or you specifically want a phrase only available as an MWW model.

## How It Works

### microWakeWord (MWW)
Runs streaming int8 TFLite models entirely in pure JavaScript: a hand-rolled interpreter for the streaming model plus a bit-exact port of the TFLM audio frontend (windowing, KISS FFT, mel filterbank, noise reduction, PCAN, log-scale). Each chunk produces an updated probability via a sliding window, so the model can fire on the very first audio frame after warmup. One full model per keyword.

### openWakeWord (OWW)
Runs a three-stage pipeline: a shared mel-spectrogram model, a shared embedding model, and one classifier per keyword. The mel + embedding stages are dispatched as WebGPU compute shaders generated per-layer, with weights baked into the WGSL at compile time so the shader stack runs without per-call buffer round-trips. Classifiers stay on CPU since each one is sub-millisecond. The whole pipeline is pure JavaScript - no WebAssembly is loaded. WebGPU is required because the embedding stage is too heavy to run on CPU within the 80 ms real-time budget, so the engine refuses to start on devices that don't expose `navigator.gpu`. Because mel + embedding are shared across keywords, adding a second wake word adds only a tiny classifier - the same shared backbone is what makes OWW efficient for multi-keyword setups.

### Common to both engines

The browser continuously processes audio and runs lightweight keyword classifiers to detect the wake word. Audio is only streamed to Home Assistant after detection. This means:

- **Lower latency** - detection happens instantly on the device, no network round-trip
- **Reduced server load** - audio is only sent to HA for STT after the wake word is detected
- **No wake word add-on required** - works without openWakeWord or microWakeWord installed on HA
- **Energy-efficient** - optional noise gate pauses inference during silence and resumes instantly when sound is detected (enable via the "Wake word noise gate" switch)
- **Optional stop-word interruption** - enable the "Stop word interruption" switch if you want the browser to listen for `stop` during timer alerts, TTS, and announcement playback

## Custom Wake Words

Drop your `.tflite` file in the right folder, restart Home Assistant, and it appears in the "Wake word model" dropdown for the matching engine.

| Engine | Drop folder |
|---|---|
| microWakeWord | `config/voice_satellite/models/` |
| openWakeWord  | `config/voice_satellite/models/openwakeword/` |

If the model has a companion `.json` manifest, place it next to the `.tflite` with the same base filename. The filename (without `.tflite`) becomes the dropdown label - `hey_computer.tflite` appears as `hey_computer`.


## Configuration

All wake word settings are configured per-device on the satellite's device page (**Settings -> Devices & Services -> Voice Satellite -> [device]**):

- **Wake word detection** - one of:
  - **On Device (microWakeWord)** *(default)* - runs MWW locally
  - **On Device (openWakeWord)** - runs OWW locally on WebGPU
  - **Home Assistant** - server-side detection via the pipeline's wake word service
  - **Disabled** - no automatic listening
- **Wake word 1** - primary wake word (always active in either On Device mode). The dropdown is engine-specific: switching between MWW and OWW shows the right model list automatically
- **Wake word 2** - optional second wake word with its own pipeline, defaults to "Disabled". See [Dual Wake Words and Pipelines](#dual-wake-words-and-pipelines)
- **Pipeline 1** - Assist pipeline used when Wake word 1 fires (this is the device's default pipeline)
- **Pipeline 2** - Assist pipeline used when Wake word 2 fires, only shown when Wake word 2 is enabled
- **Stop word interruption** - optional on-device `stop` keyword that can cancel timer alerts, TTS, and announcement playback. Disabled by default
- **Wake word sensitivity** - "Slightly sensitive", "Moderately sensitive" (default), or "Very sensitive" (shared by both slots)

To use server-side detection instead, set "Wake word detection" to "Home Assistant". This requires a wake word service (openWakeWord or microWakeWord) configured in your Assist pipeline. Server-side detection is single-slot only - dual wake words require On Device mode.

## Dual Wake Words and Pipelines

Voice Satellite can listen for two wake words at the same time and route each to its own Assist pipeline. Common use cases:

- **Dual language** - "Okay Nabu" runs an English pipeline, "Hey Jarvis" runs a Spanish one
- **Local + cloud** - one wake word hits a fully-local Speech-to-Phrase + Piper pipeline, the other routes to an LLM-backed cloud pipeline for harder questions
- **Per-character personalities** - pair each wake word with its own conversation agent and Piper voice to switch between characters (e.g. "Hey Jarvis" vs. "Hey Bender") without a sentence trigger and without bouncing through an LLM

### How to configure

1. Set **Wake word detection** to "On Device (microWakeWord)" or "On Device (openWakeWord)".
2. Pick a primary model in **Wake word 1** and the pipeline you want it to route to in **Pipeline 1**.
3. Pick a different model in **Wake word 2** - the select defaults to "Disabled".
4. Pick the target pipeline for slot 2 in **Pipeline 2**. "Preferred" falls back to Pipeline 1, effectively making slot 2 inert.

The runtime loads both TFLite models into a single shared feature extractor and runs both classifiers in parallel. Per-keyword quantization is applied at the model input, so the two models can have different training parameters without interfering.

### Details and edge cases

- **Single-slot quantization:** this is a real change to the feature pipeline used by every satellite, single-slot included. Detection accuracy should be identical to before; if you see a regression file an issue with the model name and wake word sensitivity.
- **Same model in both slots:** silently deduped - only one copy loads and every detection routes to Pipeline 1. The diagnostics panel surfaces a warning so you know Pipeline 2 is inert until you pick a different model.
- **Sensitivity is shared:** one sensitivity slider controls both slots. File an issue if per-slot sensitivity would help your setup.
- **Chime is shared:** both wake words use the same wake chime.
- **CPU cost:** running two models roughly doubles inference work for microWakeWord. openWakeWord shares mel + embedding across both slots, so the only added cost is the second classifier (<1 ms). Modern desktops, Galaxy Tab S8, and Fire HD 10 (2021+) handle MWW dual-slot without trouble. On older or low-powered devices, stick to one slot or enable the "Wake word noise gate" switch to pause inference during silence.
- **No limit escape hatch:** the cap is two, matching Home Assistant Voice PE. There is no hidden setting for three or more.

## Disabled Mode

Set "Wake word detection" to **Disabled** when you want full manual control over when the satellite listens. The microphone stream is **not activated at all** until you explicitly trigger a wake. Useful for older or low-powered devices (e.g. Android 7-9 tablets where always-on detection is unreliable), shared spaces where passive listening isn't wanted, or fully automation-driven workflows.

In Disabled mode:

- The mic stays off and no audio is streamed to Home Assistant
- Announcements, `start_conversation`, and `ask_question` from automations still work normally - they bring the mic up only for the brief STT phase, then release it
- Trigger listening via the [`voice_satellite.wake`](usage.md#voice-satellite-wake-action) action from a dashboard button, automation, or the mini card's mic icon

The mini card keeps its small mic-dot icon visible so users can tap to talk. The full card stays clean - wake it via the action.
