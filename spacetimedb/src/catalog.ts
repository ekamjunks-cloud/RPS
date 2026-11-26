// Everything a player can own, what it costs and how it unlocks.
// Keep in step with src/catalog.ts in the game (names and art live there; the rules live here).

export type ItemKind = 'skin' | 'avatar' | 'aura' | 'pack' | 'title' | 'back' | 'color' | 'fx';
export type Item = {
  id: string;          // unique across all kinds, e.g. 'skin:neon'
  kind: ItemKind;
  key: string;         // the value stored on a player's look, e.g. 'neon'
  free?: boolean;      // everyone owns it from the start
  level?: number;      // free once you reach this level (the Level road)
  price?: number;      // can be bought in the Store for this many coins
  ach?: string;        // owned once this achievement is earned (never sold)
};

const I = (kind: ItemKind, key: string, o: Omit<Item, 'id' | 'kind' | 'key'> = {}): Item => ({ id: `${kind}:${key}`, kind, key, ...o });

export const ITEMS: Item[] = [
  // card styles: the long grind
  I('skin', 'classic', { free: true }),
  I('skin', 'neon', { level: 5, price: 400 }),
  I('skin', 'wood', { level: 10, price: 900 }),
  I('skin', 'pixel', { level: 15, price: 1500 }),
  I('skin', 'candy', { price: 2000 }),
  I('skin', 'ice', { level: 20, price: 3000 }),
  I('skin', 'sketch', { price: 4000 }),
  I('skin', 'lava', { level: 30, price: 6000 }),
  I('skin', 'holo', { price: 8000 }),
  I('skin', 'galaxy', { level: 40, price: 12000 }),
  I('skin', 'royal', { price: 16000 }),
  I('skin', 'gold', { level: 50, price: 25000 }),
  // avatars
  I('avatar', 'rocky', { free: true }),
  I('avatar', 'page', { free: true }),
  I('avatar', 'snip', { free: true }),
  I('avatar', 'clank', { level: 10, price: 1000 }),
  I('avatar', 'ember', { level: 20, price: 2500 }),
  I('avatar', 'ace', { price: 5000 }),
  // auras (the ring around your avatar). '' is no aura.
  I('aura', '', { free: true }),
  I('aura', 'ruby', { level: 7, price: 600 }),
  I('aura', 'ocean', { level: 14, price: 1200 }),
  I('aura', 'neon', { price: 2000 }),
  I('aura', 'rainbow', { price: 5000 }),
  I('aura', 'rookie', { ach: 'first_win' }),
  I('aura', 'blaze', { ach: 'streak5' }),
  I('aura', 'sunrise', { ach: 'daily7' }),
  I('aura', 'gold', { ach: 'gold' }),
  I('aura', 'diamond', { ach: 'diamond' }),
  // chat packs
  I('pack', 'starter', { free: true }),
  I('pack', 'goodsport', { level: 2, price: 150 }),
  I('pack', 'hype', { level: 4, price: 250 }),
  I('pack', 'mind', { level: 8, price: 500 }),
  I('pack', 'tilt', { level: 12, price: 700 }),
  I('pack', 'sweet', { price: 900 }),
  I('pack', 'trash', { price: 1200 }),
  I('pack', 'big', { price: 1500 }),
  // Level-road-only rewards: never sold
  I('title', '', { free: true }),
  I('title', 'challenger', { level: 9 }),
  I('title', 'cardshark', { level: 17 }),
  I('title', 'grandmaster', { level: 32 }),
  I('title', 'mythic', { level: 42 }),
  I('title', 'legend', { level: 50 }),
  I('back', 'classic', { free: true }),
  I('back', 'dots', { level: 13 }),
  I('back', 'stars', { level: 22 }),
  I('back', 'flames', { level: 25 }),
  I('back', 'crown', { level: 35 }),
  I('back', 'goldleaf', { level: 45 }),
  I('color', 'green', { free: true }),
  I('color', 'sky', { level: 19 }),
  I('color', 'sunset', { level: 27 }),
  I('color', 'gold', { level: 37 }),
  I('color', 'rainbow', { level: 47 }),
  I('fx', 'confetti', { free: true }),
  I('fx', 'fireworks', { level: 24 }),
  I('fx', 'lightning', { level: 34 }),
  I('fx', 'meteor', { level: 44 }),
  I('fx', 'supernova', { level: 48 }),
];
export const ITEM = new Map(ITEMS.map(i => [i.id, i]));
export const itemOf = (kind: ItemKind, key: string) => ITEM.get(`${kind}:${key}`);

// chat: reactions are custom drawings (sent by id); phrases are fixed text. Each belongs to a pack.
export const REACTIONS: Record<string, string> = {
  nice: 'starter', lol: 'starter', whoa: 'starter', grr: 'starter',
  fire: 'hype', hype: 'hype', love: 'hype', cool: 'hype',
  sob: 'tilt', evil: 'tilt', oops: 'tilt', hmm: 'tilt',
  mindblown: 'big', frozen: 'big', starstruck: 'big', king: 'big',
};
export const PHRASES: Record<string, string> = {
  'gg': 'starter', 'Good luck!': 'starter', 'Nice one!': 'starter',
  'Well played': 'goodsport', 'Thanks!': 'goodsport', 'Rematch?': 'goodsport',
  'Rock is coming': 'mind', 'Paper next': 'mind', 'Scissors time': 'mind',
  'Gift for you': 'sweet', 'I promise': 'sweet', 'Trust me': 'sweet',
  'Too easy': 'trash', 'Oops!': 'trash', 'Lucky!': 'trash',
};
export const REACTION_SLOTS = 6;
export const PHRASE_SLOTS = 4;
export const DEFAULT_REACTIONS = 'nice,lol,whoa,grr';
export const DEFAULT_PHRASES = 'gg|Good luck!|Nice one!';

// coins (the "Standard" speed). Change here to speed the economy up or down.
export const COINS = {
  win: 20, draw: 10, loss: 5, walkover: 10,
  firstWin: 50, dailyPlay: 30, dailyWin: 30,
  level: 100, level5: 300,
  ach: 100, achBig: 250,
  welcome: 300,
  dealOff: 0.2,
};
export const COIN_MULT: Record<string, number> = { ranked: 1.5, casual: 1, room: 1, bot: 0.5, practice: 0.5, daily: 0.5 };
export const BIG_ACHIEVEMENTS = ['perfect', 'comeback', 'full_house', 'wins50', 'diamond', 'daily7'];

/** Items the Store sells, in a fixed order; the daily deal is picked from these. */
export const FOR_SALE = ITEMS.filter(i => i.price !== undefined);
