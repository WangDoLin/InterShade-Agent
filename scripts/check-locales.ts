import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED_LOCALES = ['en', 'vi', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'] as const;
const PLACEHOLDER_REGEX = /\{(\d+)\}/g;

/**
 * Extracts sorted placeholder indices (e.g. "{0}", "{1}") from a translation string.
 */
function extractPlaceholders(text: string): string[] {
  const matches = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_REGEX.exec(text)) !== null) {
    matches.add(match[0]);
  }
  return Array.from(matches).sort();
}

/**
 * Verifies that all 9 locale files have identical key sets and matching interpolation placeholders.
 */
function verifyLocales(): void {
  const localesDir = path.resolve(process.cwd(), 'locales');
  const enPath = path.join(localesDir, 'en.json');
  const enDict = JSON.parse(fs.readFileSync(enPath, 'utf8')) as Record<string, string>;
  const enKeys = Object.keys(enDict);
  const enKeySet = new Set(enKeys);

  let errorCount = 0;

  for (const locale of SUPPORTED_LOCALES) {
    const filePath = path.join(localesDir, `${locale}.json`);
    if (!fs.existsSync(filePath)) {
      console.error(`[FAIL] Missing locale file: ${filePath}`);
      errorCount++;
      continue;
    }

    const dict = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, string>;
    const keys = Object.keys(dict);
    const keySet = new Set(keys);

    const missingKeys = enKeys.filter((k) => !keySet.has(k));
    const extraKeys = keys.filter((k) => !enKeySet.has(k));

    if (missingKeys.length > 0) {
      console.error(`[FAIL] ${locale}.json is missing ${missingKeys.length} key(s): ${missingKeys.join(', ')}`);
      errorCount += missingKeys.length;
    }
    if (extraKeys.length > 0) {
      console.error(`[FAIL] ${locale}.json has ${extraKeys.length} extra key(s): ${extraKeys.join(', ')}`);
      errorCount += extraKeys.length;
    }

    for (const key of enKeys) {
      const val = dict[key];
      if (typeof val !== 'string' || val.trim().length === 0) {
        console.error(`[FAIL] ${locale}.json key "${key}" has empty or non-string value`);
        errorCount++;
        continue;
      }

      const expectedPlaceholders = extractPlaceholders(enDict[key]);
      const actualPlaceholders = extractPlaceholders(val);
      if (expectedPlaceholders.join(',') !== actualPlaceholders.join(',')) {
        console.error(
          `[FAIL] ${locale}.json key "${key}" placeholder mismatch: expected [${expectedPlaceholders.join(', ')}], got [${actualPlaceholders.join(', ')}]`,
        );
        errorCount++;
      }
    }

    if (missingKeys.length === 0 && extraKeys.length === 0) {
      console.log(`[PASS] ${locale}.json (${keys.length}/${enKeys.length} keys, placeholders verified)`);
    }
  }

  if (errorCount > 0) {
    console.error(`\n[I18N-CHECK FAILED]: ${errorCount} issue(s) detected.`);
    process.exit(1);
  }

  console.log(`\n[SUCCESS]: All ${SUPPORTED_LOCALES.length} locales verified (${enKeys.length} keys each).`);
}

verifyLocales();
