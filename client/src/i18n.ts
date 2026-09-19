import de from 'shared/locales/de.json';
import en from 'shared/locales/en.json';
import fr from 'shared/locales/fr.json';
import it from 'shared/locales/it.json';
import ja from 'shared/locales/ja.json';
import pl from 'shared/locales/pl.json';
import ru from 'shared/locales/ru.json';
import uk from 'shared/locales/uk.json';
import zhHans from 'shared/locales/zh-Hans.json';

// The same catalogues the iOS String Catalogue is generated from (see
// scripts/build-locales.mjs), so a wording fix lands in both clients at
// once. All nine ship in the bundle rather than being fetched per
// language: they total a few tens of kilobytes, and fetching them would
// mean either a blank first paint or a second offline story for the
// service worker to get right.
type Catalogue = Record<string, string>;

const CATALOGUES: Record<string, Catalogue> = { en, pl, uk, ru, de, fr, it, 'zh-Hans': zhHans, ja };

// Matches a browser tag against what we ship: exact first ("zh-Hans"),
// then the bare language ("pl-PL" -> "pl"). Any Chinese lands on
// Simplified, which is the only Chinese script translated so far.
function resolve(tag: string): string | null {
  if (CATALOGUES[tag]) {
    return tag;
  }
  const base = tag.split('-')[0];
  if (base === 'zh') {
    return 'zh-Hans';
  }
  return CATALOGUES[base] ? base : null;
}

export const language =
  (typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]))
    .map(resolve)
    .find((match): match is string => match !== null) ?? 'en';

const catalogue = CATALOGUES[language];

if (typeof document !== 'undefined') {
  document.documentElement.lang = language;
}

// Keys are the English source text, and the placeholders are iOS format
// specifiers (%@, %lld) because the same catalogue feeds a String
// Catalogue, where that is the required spelling. Positional forms
// (%1$@) work too, for languages that reorder the sentence.
export function t(key: keyof typeof en, ...args: (string | number)[]): string {
  const template: string = catalogue[key] ?? key;
  let next = 0;
  return template.replace(/%(?:(\d+)\$)?(?:@|lld|ld|d)/g, (_match, position?: string) => {
    const value = args[position ? Number(position) - 1 : next++];
    return value === undefined ? '' : String(value);
  });
}
