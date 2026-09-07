'use strict';
(function (root) {
  const KEY = 'flip-blocks-muted';
  let ctx = null, muted = false;
  try { muted = root.localStorage?.getItem(KEY) === '1'; } catch {}
  function context() {
    const Ctor = root.AudioContext || root.webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx) ctx = new Ctor();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, start, dur, type, gain) {
    const audio = context();
    if (!audio) return;
    const osc = audio.createOscillator(), amp = audio.createGain();
    osc.type = type; osc.frequency.value = freq;
    amp.gain.setValueAtTime(gain, audio.currentTime + start);
    amp.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + start + dur);
    osc.connect(amp); amp.connect(audio.destination);
    osc.start(audio.currentTime + start); osc.stop(audio.currentTime + start + dur);
  }
  function play(kind) {
    if (muted) return;
    try {
      if (kind === 'lock') tone(196, 0, 0.07, 'square', 0.05);
      else if (kind === 'flip') { tone(440, 0, 0.06, 'triangle', 0.06); tone(660, 0.04, 0.08, 'triangle', 0.05); }
      else if (kind === 'capture') { tone(330, 0, 0.08, 'sawtooth', 0.04); tone(495, 0.06, 0.1, 'triangle', 0.05); }
      else if (kind === 'win') { tone(523, 0, 0.1, 'triangle', 0.06); tone(659, 0.1, 0.12, 'triangle', 0.06); tone(784, 0.22, 0.18, 'triangle', 0.05); }
      else if (kind === 'lose') { tone(330, 0, 0.12, 'sawtooth', 0.04); tone(220, 0.1, 0.2, 'triangle', 0.05); }
    } catch {}
  }
  function isMuted() { return muted; }
  function setMuted(value) {
    muted = Boolean(value);
    try { root.localStorage?.setItem(KEY, muted ? '1' : '0'); } catch {}
    return muted;
  }
  function unlock() { try { context(); } catch {} }
  const api = { play, isMuted, setMuted, unlock };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlipAudio = api;
})(globalThis);
