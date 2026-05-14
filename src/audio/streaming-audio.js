/**
 * StreamingAudio — drop-in replacement for `new Audio()` that decodes a
 * streaming WAV response via the Web Audio API instead of letting the
 * browser's <audio> element buffer 1-2s of pre-roll before playback.
 *
 * Built specifically for HA's `/api/tts_proxy/<token>.wav` URLs (chunked
 * transfer encoding, 16-bit PCM mono/stereo). Other sources (chimes,
 * non-PCM codecs) should keep using `new Audio()`.
 *
 * Surface intentionally mimics HTMLAudioElement so TtsManager can use it
 * without further changes:
 *   volume getter/setter, src setter (triggers fetch+playback),
 *   currentTime getter, duration getter, onended, onerror, play(), pause(),
 *   removeAttribute('src'), load() (no-op).
 *
 * For the reactive-bar analyser, we expose `_isStreamingAudio` so
 * `analyser.attachAudio()` can detect us and tap our internal GainNode
 * directly (createMediaElementSource doesn't accept non-HTMLMediaElements).
 */
export class StreamingAudio {
  /**
   * @param {AudioContext} [audioContext] — Shared context (preferred, lets
   *   the reactive-bar analyser tap our output). If omitted, we create our
   *   own private context and close it on destroy/pause.
   */
  constructor(audioContext = null) {
    this._isStreamingAudio = true; // marker for analyser.js

    const AC = window.AudioContext || window.webkitAudioContext;
    this._ctx = audioContext || new AC();
    this._ownContext = !audioContext;

    this._gain = this._ctx.createGain();
    this._gain.gain.value = 1;
    this._gain.connect(this._ctx.destination);
    this._routedToAnalyser = false; // toggled by analyser.attachAudio

    this._src = null;
    this._abort = null;
    this._stopped = false;

    this._playHead = -1;        // ctx.currentTime when next sample plays
    this._startedAt = 0;        // ctx.currentTime when first sample played
    this._totalDuration = 0;    // accumulated audio duration in seconds

    // WAV parsing state
    this._sampleRate = 0;
    this._channels = 0;
    this._bitsPerSample = 0;
    this._headerParsed = false;
    this._leftover = new Uint8Array(0);

    this._onended = null;
    this._onerror = null;
    this._endTimer = null;
    this._fetchDone = false;

    this._volume = 1;
  }

  // ─── HTMLAudioElement surface ────────────────────────────────────────

  get onended() { return this._onended; }
  set onended(fn) { this._onended = fn; }

  get onerror() { return this._onerror; }
  set onerror(fn) { this._onerror = fn; }

  get volume() { return this._volume; }
  set volume(v) {
    this._volume = v;
    if (this._gain) this._gain.gain.value = v;
    if (this._mseAudio) this._mseAudio.volume = v;
  }

  get src() { return this._src || ''; }
  set src(url) {
    // Setting src on HTMLAudioElement cancels any in-flight fetch and starts
    // a new one. Mirror that exactly.
    this._abortInFlight();
    if (!url) return;
    this._src = url;
    this._startStream(url);
  }

  get currentTime() {
    // In MSE mode the internal <audio> tracks playback time accurately.
    if (this._mseAudio) return this._mseAudio.currentTime || 0;
    if (this._startedAt === 0) return 0;
    return Math.max(0, this._ctx.currentTime - this._startedAt);
  }

  /**
   * Total audio duration in seconds. For a streaming source we don't know
   * this until the fetch completes, so we return what's been scheduled so
   * far (a lower bound). HTMLAudioElement returns NaN until metadata loads;
   * we return 0, which keeps consumers like `isFinite(duration) && duration > 0`
   * from doing the wrong thing prematurely.
   */
  get duration() {
    if (this._mseAudio) {
      const d = this._mseAudio.duration;
      return Number.isFinite(d) ? d : this._totalDuration;
    }
    return this._totalDuration;
  }

  play() {
    // HTMLAudioElement.play() returns a Promise that resolves once playback
    // has begun. Ours starts on `src=`, so play() is effectively a no-op
    // beyond unlocking the AudioContext under the browser autoplay policy.
    if (this._ctx.state === 'suspended') {
      return this._ctx.resume();
    }
    return Promise.resolve();
  }

  pause() {
    this._stopped = true;
    this._abortInFlight();
  }

  removeAttribute(attr) {
    if (attr === 'src') {
      this._stopped = true;
      this._abortInFlight();
      this._src = null;
    }
  }

  load() { /* no-op: we don't pre-buffer */ }

  // ─── Analyser integration ────────────────────────────────────────────

  /**
   * Called by analyser.attachAudio() in lieu of createMediaElementSource.
   * Re-routes our internal output through the analyser node so its
   * connect-to-destination handles audibility. Caller is responsible for
   * connecting `analyserNode` to `ctx.destination` (matches existing
   * convention for the HTMLMediaElement path).
   */
  routeToAnalyser(analyserNode) {
    if (this._routedToAnalyser) return;
    try { this._gain.disconnect(); } catch {}
    this._gain.connect(analyserNode);
    this._routedToAnalyser = true;
  }

  /** Restore the default gain→destination routing (after analyser detach). */
  restoreDefaultRouting() {
    if (!this._routedToAnalyser) return;
    try { this._gain.disconnect(); } catch {}
    this._gain.connect(this._ctx.destination);
    this._routedToAnalyser = false;
  }

  /** Free internal AudioContext if we created it. */
  destroy() {
    this.pause();
    if (this._ownContext && this._ctx) {
      try { this._ctx.close(); } catch {}
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────

  _abortInFlight() {
    if (this._abort) {
      try { this._abort.abort(); } catch {}
      this._abort = null;
    }
    if (this._endTimer) {
      clearTimeout(this._endTimer);
      this._endTimer = null;
    }
    if (this._mseAudio) {
      try { this._mseAudio.pause(); } catch {}
      try { this._mseAudio.removeAttribute('src'); this._mseAudio.load(); } catch {}
      this._mseAudio.onended = null;
      this._mseAudio.onerror = null;
      this._mseAudio = null;
    }
    if (this._mseObjUrl) {
      try { URL.revokeObjectURL(this._mseObjUrl); } catch {}
      this._mseObjUrl = null;
    }
    this._playHead = -1;
    this._startedAt = 0;
    this._totalDuration = 0;
    this._headerParsed = false;
    this._leftover = new Uint8Array(0);
    this._fetchDone = false;
  }

  async _startStream(url) {
    this._stopped = false;
    this._abort = new AbortController();
    const abort = this._abort;
    try {
      if (this._ctx.state === 'suspended') {
        try { await this._ctx.resume(); } catch {}
      }
      const resp = await fetch(url, { signal: abort.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      // HA's tts_proxy serves WAV for some pipelines and MP3 for others.
      // WAV gets the chunked streaming path (first sample audible while
      // bytes still arriving). MP3 (and any decodeAudioData-compatible
      // codec) gets the "fetch-then-decode" path — not as low-latency as
      // streaming WAV but still skips the <audio> element's ~1-2s pre-roll
      // because we hand the decoded buffer straight to BufferSourceNode.
      const ctype = (resp.headers.get('content-type') || '').toLowerCase();
      const isWav = ctype.includes('wav') || /\.wav(\?|$)/i.test(url);
      if (isWav) {
        await this._streamWav(resp);
      } else {
        await this._streamViaMse(resp, ctype);
      }
      this._fetchDone = true;
      this._scheduleOnEnded();
    } catch (e) {
      if (e?.name === 'AbortError') return;
      this._onerror?.(e);
    }
  }

  /** Streaming-WAV path: parse RIFF/WAVE header, schedule each PCM block as
   *  bytes arrive. Lowest latency (~50-200ms to first sample). */
  async _streamWav(resp) {
    const reader = resp.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done || this._stopped) break;
      this._processChunk(value);
    }
  }

  /** MSE-based streaming MP3 (or other browser-decoded codec) path.
   *  Feeds bytes to the browser decoder incrementally via SourceBuffer,
   *  so playback can begin within ~200-500ms instead of waiting for the
   *  full body. Uses an internal HTMLAudioElement (the only consumer of
   *  MediaSource); we proxy our public API to it. */
  async _streamViaMse(resp, contentType) {
    // Normalize the codec MIME — HA serves Content-Type "audio/mpeg" but
    // some servers say "audio/mp3" (not officially registered).
    let mime = (contentType || '').split(';')[0].trim().toLowerCase();
    if (mime === 'audio/mp3') mime = 'audio/mpeg';
    if (!mime) mime = 'audio/mpeg';  // best guess if header missing

    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mime)) {
      // No MSE support OR unsupported codec — fall back to full-fetch decode.
      // This preserves correctness at the cost of waiting for all bytes.
      return this._fetchAndDecodeFallback(resp);
    }

    const audio = new Audio();
    audio.volume = this._volume;
    audio.onended = () => this._onended?.();
    audio.onerror = (e) => {
      const err = audio.error;
      this._onerror?.(err || new Error(`MSE audio error: ${e}`));
    };
    this._mseAudio = audio;

    const mediaSource = new MediaSource();
    const objUrl = URL.createObjectURL(mediaSource);
    audio.src = objUrl;
    this._mseObjUrl = objUrl;

    // Wait for MediaSource to open before we can add a SourceBuffer.
    await new Promise((resolve, reject) => {
      const onOpen = () => { mediaSource.removeEventListener('error', onErr); resolve(); };
      const onErr = (e) => { mediaSource.removeEventListener('sourceopen', onOpen); reject(e); };
      mediaSource.addEventListener('sourceopen', onOpen, { once: true });
      mediaSource.addEventListener('error', onErr, { once: true });
    });
    if (this._stopped) return;

    const sb = mediaSource.addSourceBuffer(mime);
    sb.mode = 'sequence';  // simpler: chunks are appended in arrival order

    // SourceBuffer only accepts one appendBuffer at a time — anything that
    // arrives while a previous append is still updating must be queued.
    const queue = [];
    let ended = false;
    sb.addEventListener('updateend', () => {
      if (queue.length > 0 && !sb.updating && !ended) {
        sb.appendBuffer(queue.shift());
      }
    });

    const reader = resp.body.getReader();
    let firstAppend = true;
    let playKicked = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || this._stopped) break;
        if (sb.updating || queue.length > 0) {
          queue.push(value);
        } else {
          sb.appendBuffer(value);
        }
        if (firstAppend) {
          firstAppend = false;
          this._startedAt = this._ctx.currentTime;
        }
        // Kick off playback after the FIRST chunk lands. The browser will
        // pause itself if it underruns — that's fine.
        if (!playKicked) {
          playKicked = true;
          // Don't await: play() can resolve after audio actually starts,
          // which itself depends on more bytes being decoded.
          audio.play().catch((e) => this._onerror?.(e));
        }
      }
      // Drain the queue, then signal end-of-stream.
      while ((queue.length > 0 || sb.updating) && !this._stopped) {
        await new Promise(r => setTimeout(r, 10));
      }
      ended = true;
      if (!this._stopped && mediaSource.readyState === 'open') {
        try { mediaSource.endOfStream(); } catch {}
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
      throw e;
    }
  }

  /** Last-resort path when MSE isn't available or doesn't support the codec.
   *  Wait for all bytes, decodeAudioData, schedule as one buffer. Slower
   *  than MSE but at least works on older browsers and exotic codecs. */
  async _fetchAndDecodeFallback(resp) {
    const buf = await resp.arrayBuffer();
    if (this._stopped) return;
    let decoded;
    try {
      decoded = await this._ctx.decodeAudioData(buf);
    } catch (e) {
      throw new Error(`StreamingAudio: decodeAudioData failed (${e?.message || e}) — codec unsupported?`);
    }
    if (this._stopped) return;

    const src = this._ctx.createBufferSource();
    src.buffer = decoded;
    src.connect(this._gain);
    const now = this._ctx.currentTime;
    this._playHead = now + 0.02;
    this._startedAt = this._playHead;
    src.start(this._playHead);
    this._playHead += decoded.duration;
    this._totalDuration = decoded.duration;
  }

  _processChunk(value) {
    if (!value || value.length === 0) return;
    const merged = new Uint8Array(this._leftover.length + value.length);
    merged.set(this._leftover, 0);
    merged.set(value, this._leftover.length);
    this._leftover = merged;

    if (!this._headerParsed) {
      const off = this._parseWavHeader(this._leftover);
      if (off < 0) return;
      this._headerParsed = true;
      this._leftover = this._leftover.subarray(off);
    }

    const frameBytes = (this._bitsPerSample / 8) * this._channels;
    if (frameBytes === 0) return;
    const whole = Math.floor(this._leftover.length / frameBytes) * frameBytes;
    if (whole > 0) {
      this._scheduleSamples(this._leftover.subarray(0, whole));
      this._leftover = this._leftover.subarray(whole);
    }
  }

  _parseWavHeader(bytes) {
    if (bytes.length < 44) return -1;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, false) !== 0x52494646) {
      this._onerror?.(new Error('StreamingAudio: not a RIFF/WAV stream'));
      return -1;
    }
    if (dv.getUint32(8, false) !== 0x57415645) {
      this._onerror?.(new Error('StreamingAudio: RIFF but not WAVE'));
      return -1;
    }
    let off = 12;
    while (off + 8 <= bytes.length) {
      const id = dv.getUint32(off, false);
      const size = dv.getUint32(off + 4, true);
      if (id === 0x666d7420) { // "fmt "
        this._channels = dv.getUint16(off + 10, true);
        this._sampleRate = dv.getUint32(off + 12, true);
        this._bitsPerSample = dv.getUint16(off + 22, true);
        off += 8 + size;
      } else if (id === 0x64617461) { // "data"
        return off + 8;
      } else {
        off += 8 + size;
      }
    }
    return -1; // need more bytes
  }

  _scheduleSamples(pcm) {
    if (this._stopped) return;
    if (this._bitsPerSample !== 16) {
      this._onerror?.(new Error(
        `StreamingAudio: only 16-bit PCM is supported (got ${this._bitsPerSample}-bit)`
      ));
      return;
    }
    const frames = pcm.length / 2 / this._channels;
    if (frames === 0) return;

    const buf = this._ctx.createBuffer(this._channels, frames, this._sampleRate);
    const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let c = 0; c < this._channels; c++) {
      const out = buf.getChannelData(c);
      for (let i = 0; i < frames; i++) {
        out[i] = dv.getInt16((i * this._channels + c) * 2, true) / 32768;
      }
    }

    const source = this._ctx.createBufferSource();
    source.buffer = buf;
    source.connect(this._gain);

    const now = this._ctx.currentTime;
    if (this._playHead < 0) {
      // First scheduled chunk — add a tiny lead so the OS audio thread has
      // time to pick it up. 20ms is far below perceptible.
      this._playHead = now + 0.02;
      this._startedAt = this._playHead;
    } else if (this._playHead < now) {
      // Underrun: we fell behind real time. Catch up.
      this._playHead = now;
    }
    source.start(this._playHead);
    this._playHead += buf.duration;
    this._totalDuration += buf.duration;
  }

  _scheduleOnEnded() {
    if (this._endTimer) clearTimeout(this._endTimer);
    // In MSE mode the internal <audio> element fires onended itself via the
    // 'ended' event; nothing to schedule.
    if (this._mseAudio) return;
    if (!this._fetchDone) return;
    const remaining = Math.max(0, this._playHead - this._ctx.currentTime);
    this._endTimer = setTimeout(() => {
      this._endTimer = null;
      if (!this._stopped) this._onended?.();
    }, remaining * 1000 + 50);
  }
}

/** Heuristic: should `url` be played via the streaming path? Only safe for
 *  HA's TTS proxy URLs which are guaranteed 16-bit PCM WAV. Anything else
 *  (chimes, announcements, MP3 from media-source://) goes through the
 *  normal HTMLAudioElement path. */
export function shouldStreamUrl(url) {
  return typeof url === "string" && url.includes("/api/tts_proxy/");
}
