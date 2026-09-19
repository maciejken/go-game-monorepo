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
