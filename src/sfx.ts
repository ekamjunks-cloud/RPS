// Sound effects, synthesised with Web Audio so there are no audio files to download.
// The audio context starts on the player's first tap (browsers block sound before that).

const MUTE_KEY = 'rps10_mute';
let muted = (() => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } })();
let ac: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

/** The shared audio context (sound effects and music). Null until the browser allows sound. */
function ctx(): AudioContext | null {
  if (!ac) {
    const C = window.AudioContext || (window as any).webkitAudioContext;
    if (!C) return null;
    try { ac = new C(); } catch { return null; }
    master = ac.createGain();
    master.gain.value = 0.55;
    const comp = ac.createDynamicsCompressor();
    master.connect(comp).connect(ac.destination);
  }
  if (ac.state === 'suspended' && !document.hidden) ac.resume().catch(() => {});
  return ac;
}
function audio(): AudioContext | null { return muted ? null : ctx(); }

export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch {}
  if (!m) audio();
}
/** Call from a user gesture so later sounds are allowed to play. */
export function unlock() { ctx(); startMusicLoop(); }

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
  // "Opponent found": a beep for 3, 2, 1 and a rising "go"
  count: () => { tone(660, 0.12, { type: 'square', vol: 0.07 }); tone(1320, 0.08, { type: 'triangle', vol: 0.05 }); },
  go: () => notes([[880, 0, 0.1], [1175, 0.08, 0.1], [1760, 0.16, 0.3]], 'square', 0.08),
  // both cards slam down face down
  thud: () => { noise(0.12, { vol: 0.2, freq: 500, q: 0.7, type: 'lowpass' }); tone(110, 0.16, { vol: 0.22, slide: 0.6 }); },
  tickUrgent: () => { tone(1500, 0.06, { type: 'square', vol: 0.08 }); tone(750, 0.06, { type: 'square', vol: 0.04 }); },
  flip: () => noise(0.16, { vol: 0.22, freq: 1800, to: 5000, q: 0.9 }),
  clash: () => { noise(0.3, { vol: 0.32, freq: 900, to: 200, q: 0.6, type: 'lowpass' }); tone(140, 0.32, { vol: 0.35, slide: 0.4 }); },
  roundWin: () => notes([[523, 0], [659, 0.08], [784, 0.16], [1047, 0.24, 0.3]], 'triangle', 0.17),
  roundLose: () => notes([[392, 0, 0.16], [330, 0.12, 0.16], [262, 0.24, 0.32]], 'sawtooth', 0.07),
  roundDraw: () => notes([[440, 0, 0.14], [440, 0.15, 0.2]], 'triangle', 0.13),
  match: () => notes([[392, 0], [523, 0.1], [659, 0.2], [784, 0.3, 0.35]], 'square', 0.07),
  unlock: () => {
    notes([[784, 0, 0.1], [988, 0.08, 0.1], [1175, 0.16, 0.1], [1568, 0.24, 0.35]], 'triangle', 0.13);
    tone(2350, 0.4, { vol: 0.04, at: 0.24 });
  },
  victory: () => {
    notes([[523, 0, 0.15], [523, 0.15, 0.1], [523, 0.25, 0.1], [698, 0.36, 0.5]], 'square', 0.09);
    notes([[659, 0.36, 0.5], [880, 0.62, 0.7], [1047, 0.62, 0.7]], 'triangle', 0.14);
  },
  defeat: () => notes([[392, 0, 0.3], [370, 0.3, 0.3], [349, 0.6, 0.3], [330, 0.9, 0.8]], 'sawtooth', 0.07),
};


// ---------- music: two short loops made in code, so there is no music file to download ----------
// A relaxed loop in the lobby, a quieter one during a match that picks up a little in the final round.
// It starts after the first tap (browsers require that), sits under the sound effects and pauses in a hidden tab.
const MUSIC_KEY = 'rps10_music';
let musicOn = (() => { try { return localStorage.getItem(MUSIC_KEY) !== '0'; } catch { return true; } })();
type Track = 'lobby' | 'match' | 'final' | null;
let track: Track = null;
let musicGain: GainNode | null = null;
let nextBeat = 0, beatN = 0, loopTimer: any = 0;

export const isMusicOn = () => musicOn;
export function setMusicOn(on: boolean) {
  musicOn = on;
  try { localStorage.setItem(MUSIC_KEY, on ? '1' : '0'); } catch {}
  fadeMusic();
}
/** Which loop should play: 'lobby', 'match', 'final' or null for silence. */
export function setTrack(t: Track) {
  if (t === track) return;
  track = t;
  fadeMusic();
}
const LEVEL: Record<string, number> = { lobby: 0.11, match: 0.06, final: 0.08 };
function fadeMusic() {
  const a = ac; if (!a || !musicGain) return;
  const target = musicOn && track ? LEVEL[track]! : 0;
  musicGain.gain.cancelScheduledValues(a.currentTime);
  musicGain.gain.setTargetAtTime(target, a.currentTime, 0.6);
}
function startMusicLoop() {
  const a = ac; if (!a || musicGain) return;
  musicGain = a.createGain();
  musicGain.gain.value = 0;
  const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
  musicGain.connect(lp).connect(a.destination);
  nextBeat = a.currentTime + 0.1;
  loopTimer = setInterval(schedule, 120);
  fadeMusic();
}
document.addEventListener('visibilitychange', () => {
  if (!ac) return;
  if (document.hidden) ac.suspend().catch(() => {}); else ac.resume().catch(() => {});
});

const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);
// chords as MIDI notes; lobby is bright (C Am F G), the match loop darker (Am F C G)
const LOBBY = [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]];
const MATCH = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
function note(freq: number, at: number, dur: number, vol: number, type: OscillatorType, attack = 0.02) {
  const a = ac!; if (!musicGain) return;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(musicGain);
  o.start(at); o.stop(at + dur + 0.05);
}
function schedule() {
  const a = ac; if (!a || !musicGain || a.state !== 'running') return;
  if (!musicOn || !track) { nextBeat = a.currentTime + 0.1; return; }
  const bpm = track === 'lobby' ? 84 : track === 'match' ? 96 : 104;
  const step = 60 / bpm / 2; // eighth notes
  while (nextBeat < a.currentTime + 0.5) {
    const t = nextBeat, i = beatN % 32, bar = Math.floor(beatN / 8) % 4;
    const chord = (track === 'lobby' ? LOBBY : MATCH)[bar]!;
    if (i % 8 === 0) {
      // a soft pad for the whole bar, and the bass note
      for (const n of chord) note(midi(n), t, step * 8.2, 0.05, 'triangle', 0.4);
      note(midi(chord[0]! - 12), t, step * 3, 0.09, 'sine', 0.01);
    }
    // a gentle arpeggio over the chord
    const arp = [0, 1, 2, 1, 2, 0, 1, 2];
    if (track === 'lobby' || i % 2 === 0) note(midi(chord[arp[i % 8]!]! + 12), t, step * 1.6, track === 'lobby' ? 0.045 : 0.03, 'sine');
    if (track === 'final' && i % 2 === 0) note(midi(chord[0]! - 12), t, step * 0.9, 0.07, 'sine', 0.005);
    if (track !== 'lobby' && i % 2 === 1) {
      // a quiet hi-hat on the off-beats during a match
      if (!noiseBuf) {
        noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let k = 0; k < d.length; k++) d[k] = Math.random() * 2 - 1;
      }
      {
        const src = a.createBufferSource(); src.buffer = noiseBuf;
        const f = a.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
        const g = a.createGain(); g.gain.setValueAtTime(0.02, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        src.connect(f).connect(g).connect(musicGain); src.start(t); src.stop(t + 0.06);
      }
    }
    nextBeat += step; beatN++;
  }
}
void loopTimer;
