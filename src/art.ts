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
