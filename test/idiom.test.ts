import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function sources(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

const SOURCES = sources(join(ROOT, 'src'));

const at = (absolute: string): string => relative(ROOT, absolute);
const text = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** Every `file:line` under src/ whose line matches `pattern`. */
function sites(pattern: RegExp): readonly string[] {
  const hits: string[] = [];
  for (const file of SOURCES) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${at(file)}:${index + 1}`);
    });
  }
  return hits;
}

describe('no Japanese in source', () => {
  it('carries no CJK character in any src/**/*.ts', () => {
    const offenders = sites(/[぀-ヿ一-鿿]/u);
    expect(
      offenders,
      `CJK characters must not appear in src/. Offending lines (${offenders.length}):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('no ported ceremony', () => {
  const NAMESPACE = /^\s+static readonly [A-Z]\w* = \w+;$/m;

  for (const path of ['src/machine.ts', 'src/machine/ledger.ts', 'src/receipt.ts']) {
    it(`${path} re-exports nothing through a static class namespace`, () => {
      const lines = text(path)
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => NAMESPACE.test(line))
        .map(({ line, index }) => `${path}:${index + 1}: ${line.trim()}`);
      expect(
        lines,
        `${path} still carries ported static class-namespace re-exports; import the names directly instead:\n${lines.join('\n')}`,
      ).toEqual([]);
    });
  }

  it('src/clock/index.ts keeps no dead RANDOM_* aliases', () => {
    const body = text('src/clock/index.ts');
    for (const alias of ['RANDOM_TAG', 'RANDOM_PAYLOAD', 'RANDOM_RESULT']) {
      expect(
        new RegExp(`^export const ${alias} = `, 'm').test(body),
        `src/clock/index.ts still exports the dead alias ${alias}; delete it and keep only the CLOCK_RANDOM_* names`,
      ).toBe(false);
    }
  });

  it('src/journal.ts keeps no SCHEMA alias', () => {
    expect(
      /^export const SCHEMA = /m.test(text('src/journal.ts')),
      'src/journal.ts still exports the dead alias SCHEMA; delete it and keep only EntrySchema',
    ).toBe(false);
  });

  it('defines stableJson exactly once across src', () => {
    const defs = sites(/function stableJson/);
    expect(
      defs,
      `stableJson must be defined once and shared, not copied per module. Definitions (${defs.length}):\n${defs.join('\n')}`,
    ).toHaveLength(1);
  });

  for (const name of ['tickSelected', 'tagSet']) {
    it(`defines ${name} exactly once across src`, () => {
      const defs = sites(new RegExp(`function ${name}\\b`));
      expect(
        defs,
        `${name} must be defined once and shared. Definitions (${defs.length}):\n${defs.join('\n')}`,
      ).toHaveLength(1);
    });
  }
});

describe('typed json boundary', () => {
  const CASES: readonly {
    readonly file: string;
    readonly what: string;
    readonly expected: RegExp;
    readonly declaration: string;
    readonly untyped: RegExp;
  }[] = [
    {
      file: 'src/journal.ts',
      what: 'Entry payload',
      expected: /^\s+readonly payload: JsonObject;$/m,
      declaration: 'readonly payload: JsonObject;',
      untyped: /^\s+readonly payload: (?:unknown|Readonly<Record<string, unknown>>);$/m,
    },
    {
      file: 'src/admission/request.ts',
      what: 'Request payload',
      expected: /^\s+readonly payload: JsonValue;$/m,
      declaration: 'readonly payload: JsonValue;',
      untyped: /^\s+readonly payload: unknown;$/m,
    },
    {
      file: 'src/machine/intake.ts',
      what: 'Submission focus',
      expected: /^\s+readonly focus: JsonValue;$/m,
      declaration: 'readonly focus: JsonValue;',
      untyped: /^  readonly focus: unknown;$/m,
    },
    {
      file: 'src/machine/ledger.ts',
      what: 'Record payload',
      expected: /^\s+readonly payload: JsonObject;$/m,
      declaration: 'readonly payload: JsonObject;',
      untyped: /^\s+readonly payload: (?:unknown|Readonly<globalThis\.Record<string, unknown>>);$/m,
    },
  ];

  for (const testCase of CASES) {
    it(`${testCase.file} declares ${testCase.what} as a typed JSON value`, () => {
      const body = text(testCase.file);
      expect(
        testCase.expected.test(body),
        `${testCase.file} must declare ${testCase.what} as \`${testCase.declaration}\``,
      ).toBe(true);
      expect(
        testCase.untyped.test(body),
        `${testCase.file} still declares ${testCase.what} with unknown; use \`${testCase.declaration}\``,
      ).toBe(false);
    });
  }
});
