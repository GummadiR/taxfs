/**
 * Root .env loader — the TaxOS-habit shim. Found on a real machine: the
 * operator copied .env/.env.local from TaxOS to the TaxFS repo ROOT (where
 * TaxOS read them) and Next.js silently ignored them. The loader honors
 * root files without ever overriding the real environment.
 */
import { describe, expect, it } from 'vitest';
import { applyEnv, parseEnvFile } from '../src/server/load-env';

describe('root .env loading', () => {
  it('parses KEY=VALUE lines, skipping comments, blanks, and malformed keys', () => {
    const vars = parseEnvFile(
      [
        '# TaxOS-era comment',
        '',
        'ANTHROPIC_API_KEY=sk-ant-test-123',
        'QUOTED="with spaces"',
        "SINGLE='single'",
        'EQ_IN_VALUE=postgresql://u:p@h/db?sslmode=require',
        'not a key=nope',
        '=novalue',
      ].join('\n'),
    );
    expect(vars['ANTHROPIC_API_KEY']).toBe('sk-ant-test-123');
    expect(vars['QUOTED']).toBe('with spaces');
    expect(vars['SINGLE']).toBe('single');
    expect(vars['EQ_IN_VALUE']).toBe('postgresql://u:p@h/db?sslmode=require');
    expect(Object.keys(vars)).toHaveLength(4);
  });

  it('NEVER overrides a variable the process already has (env > file)', () => {
    const key = 'TAXFS_LOADENV_TEST_VAR';
    process.env[key] = 'from-real-env';
    try {
      applyEnv({ [key]: 'from-file', TAXFS_LOADENV_TEST_NEW: 'lands' });
      expect(process.env[key]).toBe('from-real-env');
      expect(process.env['TAXFS_LOADENV_TEST_NEW']).toBe('lands');
    } finally {
      delete process.env[key];
      delete process.env['TAXFS_LOADENV_TEST_NEW'];
    }
  });
});
