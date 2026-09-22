#!/usr/bin/env node
// Turns shared/locales/*.json — the one place a translation is written —
// into the iOS String Catalogue. The web client reads the same JSON
// directly, so this script is the only bridge either client needs.
//
// It validates first, because the failure it guards against is silent: a
// translation that drops a %@ renders as a sentence with a hole in it, or
// crashes String(format:) on a type mismatch.
//
//   node scripts/build-locales.mjs          # validate and generate
//   node scripts/build-locales.mjs --check  # validate only

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localesDir = path.join(root, 'shared/locales');
const catalogPath = path.join(root, 'ios-app/GoGame/Localizable.xcstrings');

const SOURCE = 'en';
// Order is the order Xcode will list them in.
const LANGUAGES = ['en', 'pl', 'uk', 'ru', 'de', 'fr', 'it', 'zh-Hans', 'ja'];

const load = (lang) => JSON.parse(fs.readFileSync(path.join(localesDir, `${lang}.json`), 'utf8'));

// The placeholders a string takes, as a sorted list of their types. A
// translation may reorder them — languages put the subject in different
// places — so "%1$@ %2$lld" counts as the same set as "%@ %lld"; what it
// may not do is drop one or change @ to lld, which is what breaks at
// runtime.
function placeholders(value) {
  const found = [...value.matchAll(/%(?:(\d+)\$)?(@|lld|ld|d)/g)];
  const positional = found.filter(([, position]) => position !== undefined);
  if (positional.length > 0 && positional.length !== found.length) {
    return ['mixed positional and sequential placeholders'];
  }
  if (positional.length > 0) {
    const positions = positional.map(([, position]) => Number(position)).sort((a, b) => a - b);
    const expected = positions.map((_, index) => index + 1);
    if (positions.join() !== expected.join()) {
      return [`positions ${positions.join(',')} are not 1..${found.length}`];
    }
    // Compared by type in positional order, which is the order the
    // arguments are passed in.
    return positional
      .slice()
      .sort(([, a], [, b]) => Number(a) - Number(b))
      .map(([, , type]) => type)
      .sort();
  }
  return found.map(([, , type]) => type).sort();
}

const source = load(SOURCE);
const problems = [];

for (const lang of LANGUAGES) {
  if (lang === SOURCE) continue;
  const translations = load(lang);

  for (const key of Object.keys(source)) {
    if (!(key in translations)) {
      problems.push(`${lang}: missing "${key}"`);
      continue;
    }
    const expected = placeholders(key);
    const actual = placeholders(translations[key]);
    if (expected.join(',') !== actual.join(',')) {
      problems.push(
        `${lang}: "${key}" expects ${expected.join(' ') || 'no placeholders'}, got ${actual.join(' ') || 'none'}`,
      );
    }
  }
  for (const key of Object.keys(translations)) {
    if (!(key in source)) {
      problems.push(`${lang}: "${key}" is not in ${SOURCE}.json`);
    }
  }
}

// The checks above compare the nine files against each other, which says
// nothing about the strings the apps actually ask for: a key the code uses
// but no file has ships as English, silently (that is exactly how "Black to
// move" reached a Polish phone). So the sources get read too.
//
// Deliberately a plain scan for literals in the places these two codebases
// put user-visible text, not a parser: it can miss an unusual call, but it
// never has to be kept in step with a build system, and a missed key is no
// worse than the nothing this checked before.
const SOURCE_PATTERNS = [
  // Swift: Text("…"), Button("…"), String(localized: "…") and friends.
  {
    dir: 'ios-app/GoGame',
    extensions: ['.swift'],
    pattern:
      /(?:Text|Button|Toggle|Label|Section|TextField|SecureField|navigationTitle|confirmationDialog|ContentUnavailableView|accessibilityLabel|String\(localized:)\(\s*"((?:[^"\\]|\\.)+)"/g,
  },
  // Web: t('…') — the one way the client reaches the catalogue.
  {
    dir: 'client/src',
    extensions: ['.ts', '.tsx'],
    pattern: /\bt\(\s*'((?:[^'\\]|\\.)+)'/g,
  },
  // Server: fail(res, status, '…') sends the key the clients translate.
  {
    dir: 'server/src',
    extensions: ['.ts'],
    pattern: /\bfail\(\s*res\s*,\s*\d+\s*,\s*'((?:[^'\\]|\\.)+)'/g,
  },
];

// Literals that are formatting or data rather than anything to translate.
const NOT_TRANSLATABLE = /^[\s\p{P}\p{S}\d]*$/u;
const ALLOWED_UNTRANSLATED = new Set(['Igo5', '00:00']);

function sourceFiles(dir, extensions) {
  const found = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(relative, extensions));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      found.push(relative);
    }
  }
  return found;
}

for (const { dir, extensions, pattern } of SOURCE_PATTERNS) {
  for (const file of sourceFiles(dir, extensions)) {
    const contents = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of contents.matchAll(pattern)) {
      // The literal as written escapes whatever quote wraps it; the
      // catalogue key is the string it stands for.
      const key = match[1].replace(/\\(['"\\])/g, '$1');
      // A literal carrying an interpolation isn't the key itself — the
      // call passes the key separately.
      if (key.includes('\\(') || key.includes('${')) continue;
      if (NOT_TRANSLATABLE.test(key) || ALLOWED_UNTRANSLATED.has(key)) continue;
      if (!(key in source)) {
        problems.push(`${file}: "${key}" is used in code but missing from ${SOURCE}.json`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`${Object.keys(source).length} strings × ${LANGUAGES.length} languages: consistent.`);

if (process.argv.includes('--check')) {
  process.exit(0);
}

const catalog = { sourceLanguage: SOURCE, strings: {}, version: '1.0' };
for (const key of Object.keys(source).sort()) {
  const localizations = {};
  for (const lang of LANGUAGES) {
    const value = load(lang)[key];
    localizations[lang] = { stringUnit: { state: 'translated', value } };
  }
  catalog.strings[key] = { extractionState: 'manual', localizations };
}

fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`wrote ${path.relative(root, catalogPath)}`);
