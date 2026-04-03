// api/menu.js — Serverless function for Vercel (Node.js 18+)
// Fetches and parses weekly menus from Region Värmland automatically.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache 24h on CDN — menyn ändras inte mitt i veckan.
  // stale-while-revalidate=86400 innebär att gammal data kan servas ytterligare
  // ett dygn medan en ny hämtning sker i bakgrunden.
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');

  try {
    const [solHtml, gulHtml] = await Promise.all([
      fetchPage('https://www.regionvarmland.se/regionvarmland/halsa--vard/mat-och-restaurang'),
      fetchPage('https://www.regionvarmland.se/regionvarmland/halsa--vard/patienthotell/guldkornet-kok-och-kafe'),
    ]);

    const solsidan   = parseMenus(solHtml,  'solsidan');
    const guldkornet = parseMenus(gulHtml,  'guldkornet');

    // Merge weeks from both restaurants
    const allWeekNums = Array.from(
      new Set([...Object.keys(solsidan), ...Object.keys(guldkornet)])
    ).map(Number).sort((a, b) => a - b);

    res.status(200).json({
      solsidan,
      guldkornet,
      weekNums: allWeekNums,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Menu fetch error:', err);
    res.status(500).json({ error: 'Kunde inte hämta matsedeln. Försök igen senare.' });
  }
};

// ── HTTP ──────────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CSK-Lunch-Bot/2.0)',
      'Accept-Language': 'sv-SE,sv;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

// ── HTML → TOKENS ─────────────────────────────────────────────────────────────

/**
 * Converts raw HTML into an array of typed tokens:
 *   { type: 'heading' | 'item' | 'text', value: string }
 */
function tokenise(html) {
  const tokens = [];

  // Strip irrelevant blocks
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '');

  // Annotate meaningful tags
  const annotated = cleaned
    .replace(/<h[1-6][^>]*>/gi,  '\x01H\x01')
    .replace(/<\/h[1-6]>/gi,      '\x02')
    .replace(/<li[^>]*>/gi,        '\x01L\x01')
    .replace(/<\/li>/gi,           '\x02')
    .replace(/<br\s*\/?>/gi,       '\n')
    .replace(/<[^>]+>/g,           '');

  // Decode entities
  const decoded = annotated
    .replace(/&amp;/g,  '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

  // Split into token lines
  const parts = decoded.split(/[\x01\x02]/).map(p => p.trim()).filter(Boolean);

  let nextType = 'text';
  for (const part of parts) {
    if (part === 'H') { nextType = 'heading'; continue; }
    if (part === 'L') { nextType = 'item';    continue; }

    // Multi-line parts: split and emit each non-empty line
    for (const line of part.split('\n')) {
      const v = line.trim();
      if (v) tokens.push({ type: nextType, value: v });
    }
    nextType = 'text';
  }

  return tokens;
}

// ── PARSER ────────────────────────────────────────────────────────────────────

const DAY_MAP = {
  måndag: 'mon', tisdag: 'tue', onsdag: 'wed',
  torsdag: 'thu', fredag: 'fri', lördag: 'sat', söndag: 'sun',
};

// Words that signal we've left the menu section
const STOP_WORDS = [
  'buffémeny', 'prisinformation', 'kontaktinformation',
  'relaterat', 'hitta snabbt', 'om webbplatsen', 'följ oss',
  'cafeteria', 'sjukhuset arvika', 'sjukhuset torsby',
  'molkoms folkhögskola', 'vårdcentralen',
];

/**
 * Parses weeks → days → dishes from HTML.
 * Returns: { [weekNum]: { [dayKey]: string[] } }
 */
function parseMenus(html, source) {
  const tokens  = tokenise(html);
  const weeks   = {};

  let currentWeek = null;
  let currentDay  = null;
  let inMenuArea  = false;

  for (const { type, value } of tokens) {
    const lc = value.toLowerCase();

    // Guard: stop at non-menu sections
    if (STOP_WORDS.some(w => lc.includes(w))) {
      inMenuArea = false;
      currentWeek = null;
      currentDay  = null;
      continue;
    }

    // ── Week detection ────────────────────────────────────────────────
    const wm = lc.match(/vecka\s+(\d+)/);
    if (wm && (type === 'heading' || type === 'text')) {
      const wn = parseInt(wm[1], 10);
      if (wn >= 1 && wn <= 53) {
        currentWeek = wn;
        currentDay  = null;
        inMenuArea  = true;
        if (!weeks[wn]) weeks[wn] = {};
        continue;
      }
    }

    if (!inMenuArea || currentWeek === null) continue;

    // ── Day detection ─────────────────────────────────────────────────
    const dayKey = DAY_MAP[lc];
    if (dayKey) {
      currentDay = dayKey;
      if (!weeks[currentWeek][dayKey]) weeks[currentWeek][dayKey] = [];
      continue;
    }

    if (!currentDay) continue;

    // ── Closed day ────────────────────────────────────────────────────
    if (lc.includes('stängt')) {
      // Only mark closed if no dishes added yet for this day
      if (weeks[currentWeek][currentDay].length === 0) {
        weeks[currentWeek][currentDay] = ['STÄNGT'];
      }
      continue;
    }

    // ── Dish (list item) ──────────────────────────────────────────────
    if (type === 'item' && value.length > 3) {
      // Don't add if already marked closed
      if (weeks[currentWeek][currentDay][0] !== 'STÄNGT') {
        weeks[currentWeek][currentDay].push(value);
      }
    }
  }

  // Remove empty weeks / days
  for (const wk of Object.keys(weeks)) {
    if (Object.keys(weeks[wk]).length === 0) delete weeks[wk];
  }

  return weeks;
}
