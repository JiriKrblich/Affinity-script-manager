// icons.js — monochrome 16×16 line icons. stroke 1.25 default, linecap/linejoin round.
// Single-path icons: path-data string keyed by name.
const ICONS = {
  folder:   'M1.5 4.5a1 1 0 0 1 1-1h3.2l1.3 1.4h6.5a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4.5Z',
  file:     'M4 1.5h5.5l2.5 2.5V14a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5ZM9.5 1.5V4h2.5',
  plug:     'M5.5 1v3M10.5 1v3M4 4h8v3.5a4 4 0 0 1-8 0V4ZM8 11.5V15',
  book:     'M2.5 2.5h4a2 2 0 0 1 2 2v9a1.5 1.5 0 0 0-1.5-1.5h-4.5v-9.5ZM13.5 2.5h-4a2 2 0 0 0-2 2v9a1.5 1.5 0 0 1 1.5-1.5h4.5v-9.5Z',
  upload:   'M8 11V2.5M4.5 6 8 2.5 11.5 6M2.5 11v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11',
  download: 'M8 2v8M5 7l3 3 3-3M3 12v1.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V12',
  push:     'M8 10V3M5 6l3-3 3 3M3 11v1.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V11',
  trash:    'M2.5 3.5h11M5.5 3.5v-1a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1M4 3.5l.6 10a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-10M7 6v6M9 6v6',
  plus:     'M8 3v10M3 8h10',
  code:     'M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9.5 3.5 6.5 12.5',
  terminal: 'M2 3.5h12v9H2zM4.5 6 7 8.5 4.5 11M8.5 11h3.5',
  list:     'M2 4h12M2 8h12M2 12h12',
  grid:     'M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z',
  chevronR: 'M6 3.5 10.5 8 6 12.5',
  chevronD: 'M3.5 6 8 10.5 12.5 6',
  check:    'M3 8.5 6.5 12l7-7.5',
  close:    'M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5',
  min:      'M3 8h10',
  max:      'M3.5 3.5h9v9h-9z',
  tag:      'M2.5 2.5h5l6 6-5 5-6-6v-5ZM5.2 5.2a.6.6 0 1 1-.85-.85.6.6 0 0 1 .85.85Z',
  star:     'M8 2 9.76 5.56l3.93.57-2.84 2.77.67 3.9L8 10.97l-3.52 1.83.67-3.9L2.31 6.13l3.93-.57L8 2Z',
  github:   'M8 1.5a6.5 6.5 0 0 0-2.05 12.67c.32.06.44-.14.44-.31v-1.1c-1.8.4-2.18-.86-2.18-.86-.3-.75-.73-.95-.73-.95-.6-.4.04-.4.04-.4.66.05 1 .68 1 .68.58 1 1.53.71 1.9.54.06-.42.23-.71.42-.87-1.44-.16-2.95-.72-2.95-3.2 0-.7.25-1.28.66-1.73-.07-.16-.29-.82.06-1.7 0 0 .54-.17 1.77.66a6.1 6.1 0 0 1 3.22 0c1.23-.83 1.77-.66 1.77-.66.35.88.13 1.54.06 1.7.41.45.66 1.03.66 1.74 0 2.48-1.51 3.03-2.95 3.2.23.2.44.58.44 1.18v1.75c0 .17.12.38.44.31A6.5 6.5 0 0 0 8 1.5Z',
  edit:     'M11.5 1.8 14.2 4.5 5.2 13.5H2.5v-2.7ZM10 3.3l2.7 2.7',
};

// Multi-path icons: full inner-SVG markup.
const MULTI = {
  compass: '<circle cx="8" cy="8" r="6.2"/><path d="M10.5 5.5 9 9l-3.5 1.5L7 7l3.5-1.5Z"/>',
  search:  '<circle cx="7" cy="7" r="4.5"/><path d="m10.4 10.4 3.1 3.1"/>',
  gear:    '<path d="M9.4 1.5l.3 1.4a5 5 0 0 1 1.1.5l1.1-.9 1.6 1.6-.9 1.1a5 5 0 0 1 .5 1.1l1.4.3v2.2l-1.4.3a5 5 0 0 1-.5 1.1l.9 1.1-1.6 1.6-1.1-.9a5 5 0 0 1-1.1.5l-.3 1.4H6.6l-.3-1.4a5 5 0 0 1-1.1-.5l-1.1.9-1.6-1.6.9-1.1a5 5 0 0 1-.5-1.1L1.5 9.1V6.9l1.4-.3a5 5 0 0 1 .5-1.1l-.9-1.1 1.6-1.6 1.1.9a5 5 0 0 1 1.1-.5l.3-1.4h2.8z"/><circle cx="8" cy="8" r="2.5"/>',
  clock:   '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.2 1.5"/>',
  external:'<path d="M5 3h-2a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/><path d="M9 2h5v5"/><path d="M14 2 8 8"/>',
};

function createIcon(name, { size = 14, sw = 1.25 } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', sw);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.style.display = 'block';
  svg.style.flexShrink = '0';

  if (name === 'github') {
    // github is a filled glyph, no stroke
    svg.innerHTML = `<path d="${ICONS.github}" fill="currentColor" stroke="none"/>`;
  } else if (MULTI[name]) {
    svg.innerHTML = MULTI[name];
  } else if (ICONS[name]) {
    svg.innerHTML = `<path d="${ICONS[name]}"/>`;
  } else {
    console.warn(`Unknown icon: ${name}`);
  }
  return svg;
}

window.Icons = { createIcon };
