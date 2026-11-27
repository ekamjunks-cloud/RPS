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


// ---------- music: one loop made in code, playing in step on every device ----------
// Everyone hears the same track at the same moment: the note that plays is worked out from the time of day
// (internet time, see syncClock), not from when you opened the game. Opening the game, a new screen or a
// hidden tab coming back all just join the song where it is. Volume is a little lower during a match.
// It starts after the first tap (browsers require that), sits under the sound effects and pauses in a hidden tab.
const MUSIC_KEY = 'rps10_music';
let musicOn = (() => { try { return localStorage.getItem(MUSIC_KEY) !== '0'; } catch { return true; } })();
type Track = 'lobby' | 'match' | 'final' | null;
let track: Track = null;
let musicGain: GainNode | null = null;
let lastBeat = -1, loopTimer: any = 0;

export const isMusicOn = () => musicOn;
export function setMusicOn(on: boolean) {
  musicOn = on;
  try { localStorage.setItem(MUSIC_KEY, on ? '1' : '0'); } catch {}
  fadeMusic();
}
/** Where we are: the lobby, a match, the final round, or null for silence. The song is the same; only the volume changes. */
export function setTrack(t: Track) {
  if (t === track) return;
  track = t;
  fadeMusic();
}
const LEVEL: Record<string, number> = { lobby: 0.11, match: 0.07, final: 0.08 };
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
  loopTimer = setInterval(schedule, 100);
  fadeMusic();
}
document.addEventListener('visibilitychange', () => {
  if (!ac) return;
  if (document.hidden) ac.suspend().catch(() => {}); else { lastBeat = -1; ac.resume().catch(() => {}); }
});

// ---------- the shared clock ----------
// Phones and computers set their clocks from the internet, but some are off by a second or more. The site runs
// through Cloudflare, whose /cdn-cgi/trace page tells the time in whole seconds. Each reading says "internet time
// was somewhere in this second while the request was out", so ten readings a tenth of a second apart narrow it
// down to about the network round trip. If this device's clock already fits, it's left alone; if not, it's moved
// to the middle of the possible window. Where that page isn't there (the test server), the device clock is used.
let clockOffset = 0; // add to Date.now() to get internet time
export const worldNow = () => Date.now() + clockOffset;
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function syncClock() {
  let lo = -Infinity, hi = Infinity;
  for (let i = 0; i < 10; i++) {
    try {
      const t0 = Date.now();
      const r = await fetch('/cdn-cgi/trace', { cache: 'no-store' });
      const txt = await r.text(), t1 = Date.now();
      const m = /(?:^|\n)ts=(\d+)/.exec(txt);
      if (!r.ok || !m) return; // not behind Cloudflare: keep the device clock
      const sec = parseInt(m[1]!, 10) * 1000;
      // the server read its clock between t0 and t1 (our time), and it showed sec..sec+999 (internet time)
      lo = Math.max(lo, sec - t1); hi = Math.min(hi, sec + 1000 - t0);
    } catch { return; }
    await pause(110);
  }
  if (!(lo <= hi)) return; // readings disagree (the network hiccuped): keep what we had
  clockOffset = lo <= 0 && 0 <= hi ? 0 : Math.round((lo + hi) / 2); // fits already: leave it; otherwise the middle of what's possible
  lastBeat = -1;
}
if (location.protocol.startsWith('http')) { syncClock(); setInterval(syncClock, 10 * 60 * 1000); }

const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);
// 8 bars: bright (C Am F G), then darker (Am F C G); 88 beats a minute, played in eighth notes
const BARS = [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62], [57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const BPM = 88, STEP_MS = 60000 / BPM / 2, LOOP = BARS.length * 8;
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
function hat(at: number) {
  const a = ac!;
  if (!noiseBuf) {
    noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let k = 0; k < d.length; k++) d[k] = Math.random() * 2 - 1;
  }
  const src = a.createBufferSource(); src.buffer = noiseBuf;
  const f = a.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
  const g = a.createGain(); g.gain.setValueAtTime(0.018, at); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
  src.connect(f).connect(g).connect(musicGain!); src.start(at); src.stop(at + 0.06);
}
/** Plays eighth note number n of the song (counted from 1 Jan 1970, so every device agrees) at audio time t. */
function playBeat(n: number, t: number) {
  const i = n % LOOP, bar = Math.floor(i / 8), chord = BARS[bar]!, step = STEP_MS / 1000;
  if (i % 8 === 0) {
    // a soft pad for the whole bar, and the bass note
    for (const m of chord) note(midi(m), t, step * 8.2, 0.05, 'triangle', 0.4);
    note(midi(chord[0]! - 12), t, step * 3, 0.09, 'sine', 0.01);
  }
  const arp = [0, 1, 2, 1, 2, 0, 1, 2];
  note(midi(chord[arp[i % 8]!]! + 12), t, step * 1.6, 0.04, 'sine'); // a gentle arpeggio over the chord
  if (i % 2 === 1) hat(t); // a quiet hi-hat on the off-beats
}
function schedule() {
  const a = ac; if (!a || !musicGain || a.state !== 'running') return;
  if (!musicOn || !track) { lastBeat = -1; return; }
  // match the audio clock to internet time; the sound reaches the speaker outputLatency later, so start that much early
  const now = worldNow(), latency = (a.outputLatency || 0) + (a.baseLatency || 0);
  const toAudio = (ms: number) => a.currentTime + (ms - now) / 1000 - latency;
  const first = Math.ceil((now + 30) / STEP_MS), last = Math.floor((now + 400) / STEP_MS);
  for (let n = Math.max(first, lastBeat + 1); n <= last; n++) { playBeat(n, toAudio(n * STEP_MS)); lastBeat = n; }
}
if (import.meta.env.DEV) (window as any).__music = () => ({ offset: clockOffset, beat: lastBeat, bar: Math.floor((lastBeat % LOOP) / 8), msIntoStep: worldNow() % STEP_MS });
void loopTimer;
