import { describe, expect, it } from 'bun:test';
import { resolveScopedPath } from '../src/policy.ts';

describe('resolveScopedPath', () => {
  it('resolves in-scope paths', () => {
    const root = '/tmp/work';
    const resolved = resolveScopedPath(root, 'src/file.ts', false);
    expect(resolved).toBe('/tmp/work/src/file.ts');
  });

  it('blocks outside paths when restricted', () => {
    const root = '/tmp/work';
    expect(() => resolveScopedPath(root, '../outside.txt', false)).toThrow(
      'outside current workspace',
    );
  });

  it('allows outside paths when override is set', () => {
    const root = '/tmp/work';
    const resolved = resolveScopedPath(root, '../outside.txt', true);
    expect(resolved).toBe('/tmp/outside.txt');
  });
});
