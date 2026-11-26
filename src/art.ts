// Card art. Everything is inline SVG so the game has no image files to load.

export const KINDS = ['rock', 'paper', 'scissors'] as const;
export type Kind = (typeof KINDS)[number];

export const ICON: Record<string, string> = {
  rock: `<svg viewBox="0 0 64 64" aria-hidden="true">
    <path d="M10 41 17 21 33 12 49 18 56 35 47 51 24 54Z" fill="currentColor"/>
    <path d="M17 21 33 12 36 28Z" fill="#fff" opacity=".45"/>
    <path d="M33 12 49 18 36 28Z" fill="#fff" opacity=".22"/>
    <path d="M10 41 17 21 36 28 24 54Z" fill="#000" opacity=".06"/>
    <path d="M36 28 56 35 47 51 24 54Z" fill="#000" opacity=".22"/>
    <path d="M36 28 49 18 56 35Z" fill="#000" opacity=".1"/>
  </svg>`,
  paper: `<svg viewBox="0 0 64 64" aria-hidden="true">
    <path d="M15 8h25l11 11v37H15Z" fill="currentColor"/>
    <path d="M40 8v11h11Z" fill="#000" opacity=".22"/>
    <path d="M22 28h22M22 35h22M22 42h15" stroke="#000" stroke-opacity=".2" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M15 8h25v3H15Z" fill="#fff" opacity=".35"/>
  </svg>`,
  scissors: `<svg viewBox="0 0 64 64" aria-hidden="true">
    <path d="M27 38 45 7l4 2.4L33 41Z" fill="currentColor"/>
    <path d="M37 38 19 7l-4 2.4L31 41Z" fill="currentColor"/>
    <path d="M45 7l4 2.4-3 5.2Z" fill="#fff" opacity=".45"/>
    <g fill="none" stroke="currentColor" stroke-width="5.5">
      <circle cx="20" cy="47" r="8.5"/><circle cx="44" cy="47" r="8.5"/>
    </g>
    <circle cx="32" cy="29.5" r="2.8" fill="#000" opacity=".35"/>
  </svg>`,
};

/** The front of a card: coloured face, big icon, name along the bottom. */
export function face(kind: string): string {
  return `<span class="cf k-${kind}"><span class="cic">${ICON[kind]}</span><span class="cnm">${kind}</span></span>`;
}

/** The back of a card. */
export const BACK = `<span class="cb"><span class="cbl">10</span></span>`;

/** A small icon on its own, coloured by kind. */
export const mini = (kind: string) => `<span class="mi k-${kind}">${ICON[kind]}</span>`;

export const TROPHY = `<svg viewBox="0 0 64 64" aria-hidden="true">
  <path d="M18 8h28v14a14 14 0 0 1-28 0Z" fill="currentColor"/>
  <path d="M18 12H8v4a10 10 0 0 0 10 10M46 12h10v4a10 10 0 0 1-10 10" fill="none" stroke="currentColor" stroke-width="4"/>
  <path d="M28 35h8v9h-8Z" fill="currentColor"/>
  <path d="M20 46h24l3 9H17Z" fill="currentColor"/>
  <path d="M24 12h5v12a6 6 0 0 1-5-5Z" fill="#fff" opacity=".4"/>
</svg>`;
export const SKULL = `<svg viewBox="0 0 64 64" aria-hidden="true">
  <path d="M32 7C18 7 9 16 9 29c0 8 4 13 9 16v9h28v-9c5-3 9-8 9-16C55 16 46 7 32 7Z" fill="currentColor"/>
  <circle cx="23" cy="30" r="6" fill="#000" opacity=".55"/><circle cx="41" cy="30" r="6" fill="#000" opacity=".55"/>
  <path d="M29 41h6l-3-6Z" fill="#000" opacity=".5"/>
  <path d="M26 54v-6M32 54v-6M38 54v-6" stroke="#000" stroke-opacity=".4" stroke-width="2.5"/>
</svg>`;
export const SHAKE = `<svg viewBox="0 0 64 64" aria-hidden="true">
  <path d="M4 26l12-8 10 4 8-4 14 2 12 8-8 14-6-2-8 8-6 2-6-4-6 2-6-6-6-2Z" fill="currentColor"/>
  <path d="M22 34l8 8M28 30l9 9M34 27l8 8" stroke="#000" stroke-opacity=".3" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;
export const SPEAKER_ON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4Z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
export const SPEAKER_OFF = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4Z" fill="currentColor"/><path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
export const LOCK = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2.5" fill="currentColor"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>`;
export const CHAT = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5Z" fill="currentColor"/><circle cx="8.5" cy="9.5" r="1.3" fill="#1d1850"/><circle cx="12" cy="9.5" r="1.3" fill="#1d1850"/><circle cx="15.5" cy="9.5" r="1.3" fill="#1d1850"/></svg>`;

// menu icons (stroked, so they take the text colour)
const ic = (body: string) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const GEAR = ic('<path d="M10.03 4.66 L10.58 1.90 L13.42 1.90 L13.97 4.66 A7.6 7.6 0 0 1 15.80 5.42 L18.14 3.85 L20.15 5.86 L18.58 8.20 A7.6 7.6 0 0 1 19.34 10.03 L22.10 10.58 L22.10 13.42 L19.34 13.97 A7.6 7.6 0 0 1 18.58 15.80 L20.15 18.14 L18.14 20.15 L15.80 18.58 A7.6 7.6 0 0 1 13.97 19.34 L13.42 22.10 L10.58 22.10 L10.03 19.34 A7.6 7.6 0 0 1 8.20 18.58 L5.86 20.15 L3.85 18.14 L5.42 15.80 A7.6 7.6 0 0 1 4.66 13.97 L1.90 13.42 L1.90 10.58 L4.66 10.03 A7.6 7.6 0 0 1 5.42 8.20 L3.85 5.86 L5.86 3.85 L8.20 5.42 A7.6 7.6 0 0 1 10.03 4.66Z"/><circle cx="12" cy="12" r="3"/>');
export const EXIT = ic('<path d="M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8M10 12h10M17 8l4 4-4 4"/>');
export const LIST = ic('<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r=".6"/><circle cx="4" cy="12" r=".6"/><circle cx="4" cy="18" r=".6"/>');
export const LOCKER = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="10" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2" transform="rotate(-10 9 13)"/><rect x="10" y="4" width="10" height="14" rx="2" fill="currentColor" opacity=".9" transform="rotate(8 15 11)"/></svg>`;
export const BAG = ic('<path d="M5 8h14l-1.2 12H6.2Z"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/>');
export const PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
export const FLAG = ic('<path d="M6 21V4"/><path d="M6 4h11l-2.5 4L17 12H6"/>');
export const STATS = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V12M12 20V5M19 20v-6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>`;
export const CALENDAR = ic('<rect x="4" y="5.5" width="16" height="14.5" rx="3"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>');
