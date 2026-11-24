// Sound effects, synthesised with Web Audio so there are no audio files to download.
// The audio context starts on the player's first tap (browsers block sound before that).

const MUTE_KEY = 'rps10_mute';
let muted = (() => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } })();
let ac: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

function audio(): AudioContext | null {
  if (muted) return null;
  if (!ac) {
    const C = window.AudioContext || (window as any).webkitAudioContext;
    if (!C) return null;
    try { ac = new C(); } catch { return null; }
    master = ac.createGain();
    master.gain.value = 0.55;
    const comp = ac.createDynamicsCompressor();
    master.connect(comp).connect(ac.destination);
  }
  if (ac.state === 'suspended') ac.resume().catch(() => {});
  return ac;
}

export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch {}
  if (m && ac) ac.suspend().catch(() => {});
  else audio();
}
/** Call from a user gesture so later sounds are allowed to play. */
export function unlock() { audio(); }

type ToneOpts = { type?: OscillatorType; vol?: number; at?: number; slide?: number; attack?: number };
function tone(freq: number, dur: number, o: ToneOpts = {}) {
  const a = audio(); if (!a || !master) return;
  const t = a.currentTime + (o.at || 0);
  const osc = a.createOscillator(), g = a.createGain();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(freq, t);
  if (o.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * o.slide), t + dur);
  const vol = o.vol ?? 0.2, atk = o.attack ?? 0.006;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + atk);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t); osc.stop(t + dur + 0.03);
}

type NoiseOpts = { vol?: number; at?: number; freq?: number; to?: number; q?: number; type?: BiquadFilterType };
function noise(dur: number, o: NoiseOpts = {}) {
  const a = audio(); if (!a || !master) return;
  if (!noiseBuf) {
    noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = a.currentTime + (o.at || 0);
  const src = a.createBufferSource(); src.buffer = noiseBuf;
  const f = a.createBiquadFilter(); f.type = o.type || 'bandpass'; f.Q.value = o.q ?? 1.2;
  f.frequency.setValueAtTime(o.freq ?? 1500, t);
  if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.vol ?? 0.2, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t); src.stop(t + dur + 0.03);
}

const notes = (seq: [number, number, number?][], type: OscillatorType = 'triangle', vol = 0.18) =>
  seq.forEach(([f, at, d]) => tone(f, d ?? 0.18, { type, vol, at }));

export const sfx = {
  msg: () => notes([[880, 0, 0.07], [1320, 0.06, 0.12]], 'sine', 0.13),
  emote: () => { tone(500, 0.12, { type: 'triangle', vol: 0.14, slide: 2 }); },
  tap: () => tone(540, 0.06, { type: 'triangle', vol: 0.12 }),
  select: () => { tone(700, 0.07, { type: 'triangle', vol: 0.16 }); tone(1050, 0.09, { vol: 0.08, at: 0.03 }); },
  deal: (i: number) => noise(0.07, { vol: 0.12, freq: 3800, at: i * 0.05, q: 0.8 }),
  lock: () => { tone(180, 0.14, { type: 'square', vol: 0.06 }); tone(360, 0.2, { type: 'triangle', vol: 0.2, at: 0.02 }); noise(0.06, { vol: 0.16, freq: 4200 }); },
  ready: () => notes([[523, 0], [784, 0.07, 0.22]], 'triangle', 0.15),
  banner: () => { noise(0.5, { vol: 0.16, freq: 400, to: 3000, q: 0.7 }); tone(98, 0.5, { type: 'sawtooth', vol: 0.05, slide: 2 }); },
  tick: () => tone(1250, 0.035, { type: 'square', vol: 0.045 }),
  tickUrgent: () => { tone(1500, 0.06, { type: 'square', vol: 0.08 }); tone(750, 0.06, { type: 'square', vol: 0.04 }); },
  flip: () => noise(0.16, { vol: 0.22, freq: 1800, to: 5000, q: 0.9 }),
  clash: () => { noise(0.3, { vol: 0.32, freq: 900, to: 200, q: 0.6, type: 'lowpass' }); tone(140, 0.32, { vol: 0.35, slide: 0.4 }); },
  roundWin: () => notes([[523, 0], [659, 0.08], [784, 0.16], [1047, 0.24, 0.3]], 'triangle', 0.17),
  roundLose: () => notes([[392, 0, 0.16], [330, 0.12, 0.16], [262, 0.24, 0.32]], 'sawtooth', 0.07),
  roundDraw: () => notes([[440, 0, 0.14], [440, 0.15, 0.2]], 'triangle', 0.13),
  match: () => notes([[392, 0], [523, 0.1], [659, 0.2], [784, 0.3, 0.35]], 'square', 0.07),
  victory: () => {
    notes([[523, 0, 0.15], [523, 0.15, 0.1], [523, 0.25, 0.1], [698, 0.36, 0.5]], 'square', 0.09);
    notes([[659, 0.36, 0.5], [880, 0.62, 0.7], [1047, 0.62, 0.7]], 'triangle', 0.14);
  },
  defeat: () => notes([[392, 0, 0.3], [370, 0.3, 0.3], [349, 0.6, 0.3], [330, 0.9, 0.8]], 'sawtooth', 0.07),
};
