// What every item is called and how it looks. Prices, levels and unlock rules come straight from the
// server's catalog (spacetimedb/src/catalog.ts), so the two can never disagree.
import {
  ITEMS, ITEM, REACTIONS, PHRASES, COINS, REACTION_SLOTS, PHRASE_SLOTS, XP, XP_MULT, COIN_MULT, K_STEPS, RANK_LINES, type Item, type ItemKind,
} from '../spacetimedb/src/catalog';
import { face } from './art';

export { ITEMS, ITEM, REACTIONS, PHRASES, COINS, REACTION_SLOTS, PHRASE_SLOTS, XP, XP_MULT, COIN_MULT, K_STEPS, RANK_LINES };
export type { Item, ItemKind };

/** Level from total XP, the same sum as the server: level n needs 100 + 25 × (n − 1) XP to go up. */
export function levelOf(xp: number) {
  let level = 1, need = 100;
  while (xp >= need) { xp -= need; level += 1; need = 100 + 25 * (level - 1); }
  return { level, into: xp, need };
}
/** Total XP needed to reach a level. */
export function xpForLevel(level: number) {
  let xp = 0;
  for (let l = 1; l < level; l++) xp += 100 + 25 * (l - 1);
  return xp;
}

type Info = { name: string; desc: string };
const NAMES: Record<string, Info> = {
  'skin:classic': { name: 'Classic', desc: 'The original bright cards.' },
  'skin:neon': { name: 'Neon', desc: 'Glowing outlines on a dark card.' },
  'skin:wood': { name: 'Wood', desc: 'Hand-carved, with a real grain.' },
  'skin:pixel': { name: 'Pixel', desc: 'Retro square cards.' },
  'skin:candy': { name: 'Candy', desc: 'Sweet stripes and a glossy shine.' },
  'skin:ice': { name: 'Ice', desc: 'Frosted glass with a cold glow.' },
  'skin:sketch': { name: 'Sketch', desc: 'Pencil lines on notebook paper.' },
  'skin:lava': { name: 'Lava', desc: 'Molten rock that glows and pulses.' },
  'skin:holo': { name: 'Holo', desc: 'A rainbow foil that shifts as it moves.' },
  'skin:galaxy': { name: 'Galaxy', desc: 'Stars and nebula clouds.' },
  'skin:royal': { name: 'Royal', desc: 'Velvet and gold trim.' },
  'skin:gold': { name: 'Gold', desc: 'Solid gold. The rarest card style.' },
  'avatar:rocky': { name: 'Rocky', desc: 'The rock. Stubborn, steady, never blinks first.' },
  'avatar:page': { name: 'Page', desc: 'The paper. All smiles, wraps you up anyway.' },
  'avatar:snip': { name: 'Snip', desc: 'The scissors. Sharp eyes, sharper moves.' },
  'avatar:clank': { name: 'Clank', desc: 'A robot that counts every card you play.' },
  'avatar:ember': { name: 'Ember', desc: 'Hot streak energy. Burns bright on a win run.' },
  'avatar:ace': { name: 'Ace', desc: 'Too cool to show their hand. Literally.' },
  'aura:': { name: 'No aura', desc: 'Just your avatar.' },
  'aura:ruby': { name: 'Ruby', desc: 'Red gems at every corner.' },
  'aura:ocean': { name: 'Ocean', desc: 'Deep blue with a wave along the bottom.' },
  'aura:neon': { name: 'Neon', desc: 'Pulses pink and blue.' },
  'aura:rainbow': { name: 'Rainbow', desc: 'Colours keep cycling.' },
  'aura:rookie': { name: 'Rookie', desc: 'Earned: win your first match.' },
  'aura:blaze': { name: 'Blaze', desc: 'Earned: win 5 in a row.' },
  'aura:sunrise': { name: 'Sunrise', desc: 'Earned: play the daily challenge 7 days in a row.' },
  'aura:gold': { name: 'Gold', desc: 'Earned: reach Gold rank.' },
  'aura:diamond': { name: 'Diamond', desc: 'Earned: reach Diamond rank.' },
  'aura:silver': { name: 'Silver', desc: 'Earned: reach Silver rank.' },
  'pack:starter': { name: 'Starter', desc: 'Everyone has it.' },
  'pack:goodsport': { name: 'Good sport', desc: 'Well played · Thanks! · Rematch?' },
  'pack:hype': { name: 'Hype', desc: 'Reactions: On fire, Hype, Love, Cool.' },
  'pack:mind': { name: 'Mind games', desc: 'Rock is coming · Paper next · Scissors time' },
  'pack:tilt': { name: 'Tilt', desc: 'Reactions: Sob, Evil, Oops, Hmm.' },
  'pack:sweet': { name: 'Sweet talk', desc: 'Gift for you · I promise · Trust me' },
  'pack:trash': { name: 'Trash talk', desc: 'Too easy · Oops! · Lucky!' },
  'pack:big': { name: 'Big reactions', desc: 'Reactions: Mind blown, Frozen, Starstruck, King.' },
  'title:': { name: 'No title', desc: '' },
  'title:challenger': { name: 'CHALLENGER', desc: 'A title under your name.' },
  'title:cardshark': { name: 'CARD SHARK', desc: 'A title under your name.' },
  'title:grandmaster': { name: 'GRANDMASTER', desc: 'A title under your name.' },
  'title:mythic': { name: 'MYTHIC', desc: 'A title under your name.' },
  'title:legend': { name: 'LEGEND', desc: 'The top title.' },
  'title:contender': { name: 'CONTENDER', desc: 'Earned: reach Silver rank.' },
  'title:golden': { name: 'GOLDEN', desc: 'Earned: reach Gold rank.' },
  'title:diamond': { name: 'DIAMOND', desc: 'Earned: reach Diamond rank.' },
  'back:classic': { name: 'Classic back', desc: 'What your opponent sees.' },
  'back:dots': { name: 'Dots', desc: 'A card back your opponent sees.' },
  'back:stars': { name: 'Stars', desc: 'A card back your opponent sees.' },
  'back:flames': { name: 'Flames', desc: 'A card back your opponent sees.' },
  'back:crown': { name: 'Crown', desc: 'A card back your opponent sees.' },
  'back:goldleaf': { name: 'Gold leaf', desc: 'A card back your opponent sees.' },
  'back:goldcrest': { name: 'Gold Crest', desc: 'Earned: reach Gold rank. Your opponent sees it.' },
  'back:prism': { name: 'Prism', desc: 'Earned: reach Diamond rank. Your opponent sees it.' },
  'color:green': { name: 'Green', desc: 'Your phrase tickets.' },
  'color:sky': { name: 'Sky', desc: 'Your phrase tickets.' },
  'color:sunset': { name: 'Sunset', desc: 'Your phrase tickets.' },
  'color:gold': { name: 'Gold', desc: 'Your phrase tickets.' },
  'color:rainbow': { name: 'Rainbow', desc: 'Your phrase tickets.' },
  'fx:confetti': { name: 'Confetti', desc: 'The normal celebration.' },
  'fx:fireworks': { name: 'Fireworks', desc: 'Coloured bursts pop around the score.' },
  'fx:lightning': { name: 'Lightning', desc: 'Two bolts crack down and the screen flashes.' },
  'fx:meteor': { name: 'Meteor shower', desc: 'Glowing meteors streak across the sky.' },
  'fx:supernova': { name: 'Supernova', desc: 'A white flash, then rainbow shockwaves.' },
  'fx:shatter': { name: 'Shatter', desc: 'Earned: reach Diamond rank. A crystal flash, then shards burst across the screen.' },
};
export const nameOf = (id: string) => NAMES[id]?.name ?? id.split(':')[1] ?? id;
export const descOf = (id: string) => NAMES[id]?.desc ?? '';
export const itemsOf = (kind: ItemKind) => ITEMS.filter(i => i.kind === kind);
export const KIND_LABEL: Record<ItemKind, string> = {
  skin: 'Card style', avatar: 'Avatar', aura: 'Aura', pack: 'Chat pack', title: 'Title', back: 'Card back', color: 'Message colour', fx: 'Win effect',
};

// ---------- drawing ----------
const esc = (s: string) => s.replace(/[&<>"']/g, c => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as any)[c]);
const AURA_BADGE: Record<string, string> = {
  rookie: '<svg class="bBot" aria-hidden="true"><use href="#b-star"/></svg>',
  blaze: '<svg class="bTop" aria-hidden="true"><use href="#b-flame"/></svg>',
  sunrise: '<svg class="bTop" aria-hidden="true"><use href="#b-sun"/></svg>',
  gold: '<svg class="bTop" aria-hidden="true"><use href="#b-crown"/></svg>',
  diamond: '<svg class="bTop" aria-hidden="true"><use href="#b-gem"/></svg><svg class="bSpark" aria-hidden="true"><use href="#b-spark"/></svg>',
  silver: '<svg class="bBot rkB" aria-hidden="true" viewBox="0 0 100 100"><use href="#rk-silver"/></svg>',
  ruby: '<i class="stud s1"></i><i class="stud s2"></i><i class="stud s3"></i><i class="stud s4"></i>',
};
const AVATAR_KEYS = new Set(['rocky', 'page', 'snip', 'clank', 'ember', 'ace']);
/** An avatar with its aura, `size` pixels across. Small ones drop the badges so they stay clean. */
export function avatarHtml(avatar: string, aura: string, size: number, label = ''): string {
  const a = AVATAR_KEYS.has(avatar) ? avatar : 'rocky';
  const badges = size >= 34 ? (AURA_BADGE[aura] || '') : '';
  return `<span class="ava${aura ? ' au-' + aura : ''}" style="--s:${size}px"${label ? ` role="img" aria-label="${esc(label)}"` : ' aria-hidden="true"'}>`
    + `<svg class="avs" aria-hidden="true"><use href="#av-${a}"/></svg>${badges}</span>`;
}

// reactions: id → drawing and name
export const REACTION_ART: Record<string, [string, string]> = {
  nice: ['e-gg', 'Nice'], lol: ['e-lol', 'LOL'], whoa: ['e-wow', 'Whoa'], grr: ['e-grr', 'Grr'],
  fire: ['e-fire', 'On fire'], hype: ['e-hype', 'Hype'], love: ['e-love', 'Love'], cool: ['e-cool', 'Cool'],
  sob: ['e-sob', 'Sob'], evil: ['e-evil', 'Evil'], oops: ['e-oops', 'Oops'], hmm: ['e-hmm', 'Hmm'],
  mindblown: ['e-blown', 'Mind blown'], frozen: ['e-frozen', 'Frozen'], starstruck: ['e-star', 'Starstruck'], king: ['e-king', 'King'],
};
export const reactionSvg = (id: string) => `<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#${(REACTION_ART[id] || REACTION_ART.nice!)[0]}"/></svg>`;
export const reactionName = (id: string) => (REACTION_ART[id] || ['', id])[1];
const PHRASE_ICON: Record<string, string> = { 'Rock is coming': 'i-rock', 'Paper next': 'i-paper', 'Scissors time': 'i-scissors', 'Gift for you': 'i-gift' };
/** A phrase as a ticket in a message colour, with its little icon if it has one. */
export function ticketHtml(text: string, color: string, cls = ''): string {
  const ic = PHRASE_ICON[text];
  return `<span class="tkt t-${color || 'green'} ${cls}">${ic ? `<svg aria-hidden="true"><use href="#${ic}"/></svg>` : ''}${esc(text)}</span>`;
}
export const packOfReaction = (id: string) => REACTIONS[id];
export const packOfPhrase = (p: string) => PHRASES[p];
export const reactionsInPack = (pack: string) => Object.keys(REACTIONS).filter(r => REACTIONS[r] === pack);
export const phrasesInPack = (pack: string) => Object.keys(PHRASES).filter(p => PHRASES[p] === pack);

/** A title chip, e.g. CARD SHARK. */
export const titleHtml = (title: string) => (title ? `<span class="ttl tt-${title}">${esc(nameOf('title:' + title))}</span>` : '');
/** The back of a card in a back style. */
const BACK_EMBLEM: Record<string, string> = { goldcrest: 'gold', prism: 'diamond' };
export const backHtml = (back: string) => `<span class="cb b-${back || 'classic'}">${BACK_EMBLEM[back] ? `<svg class="cbEm" viewBox="0 0 100 100" aria-hidden="true"><use href="#rk-${BACK_EMBLEM[back]}"/></svg>` : '<span class="cbl">10</span>'}</span>`;
/** Three cards (rock, paper, scissors) in a card style. */
export const skinTrio = (skin: string, cls = '') =>
  `<span class="trio ${cls}" data-skin="${skin}">${['rock', 'paper', 'scissors'].map(k => `<span class="tc">${face(k)}</span>`).join('')}</span>`;

/** A small picture of any item, for the Locker, Store and Level road. */
export function itemArt(id: string, size = 56, avatar = 'rocky'): string {
  const it = ITEM.get(id);
  if (!it) return '';
  switch (it.kind) {
    case 'skin': return `<span class="art tc" data-skin="${it.key}" style="width:${Math.round(size * 0.72)}px">${face('rock')}</span>`;
    case 'avatar': return avatarHtml(it.key, '', size);
    case 'aura': return avatarHtml(avatar, it.key, size);
    case 'pack': {
      const r = reactionsInPack(it.key);
      return r.length ? `<span class="art packArt">${r.slice(0, 2).map(x => `<span class="rx">${reactionSvg(x)}</span>`).join('')}</span>`
        : `<span class="art packArt">${ticketHtml(phrasesInPack(it.key)[0] || 'gg', 'green', 's')}</span>`;
    }
    case 'title': return `<span class="art">${it.key ? titleHtml(it.key) : '<span class="ttl">—</span>'}</span>`;
    case 'back': return `<span class="art tc" style="width:${Math.round(size * 0.72)}px">${backHtml(it.key)}</span>`;
    case 'color': return `<span class="art">${ticketHtml('gg', it.key, 's')}</span>`;
    case 'fx': return `<span class="art fxArt fx-${it.key}"><i></i><i></i><i></i></span>`;
  }
}

/** The Level road: for every level from 2 to 50, what it unlocks and the coins it pays. */
export type RoadStep = { level: number; items: Item[]; coins: number };
export const ROAD: RoadStep[] = Array.from({ length: 49 }, (_, i) => {
  const level = i + 2;
  return { level, items: ITEMS.filter(it => it.level === level), coins: level % 5 === 0 ? COINS.level5 : COINS.level };
});
/** The next Level-road step with an unlock above `level`. */
export const nextUnlock = (level: number) => ROAD.find(s => s.level > level && s.items.length);
