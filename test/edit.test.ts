import { describe, expect, it } from 'bun:test';
import { applyFindReplaceEdits } from '../src/tools/edit.ts';

describe('applyFindReplaceEdits', () => {
  it('applies multiple find/replace blocks', () => {
    const result = applyFindReplaceEdits(
      'alpha beta beta',
      [
        { find: 'beta', replace: 'gamma' },
        { find: 'alpha', replace: 'omega' },
      ],
    );

    expect(result.output).toBe('omega gamma gamma');
    expect(result.totalReplacements).toBe(3);
    expect(result.replacementsPerEdit).toEqual([2, 1]);
  });

  it('throws when an edit does not match', () => {
    expect(() =>
      applyFindReplaceEdits('hello', [{ find: 'world', replace: 'x' }]),
    ).toThrow('did not find');
  });

  it('validates expected replacement count', () => {
    expect(() =>
      applyFindReplaceEdits('a a a', [{ find: 'a', replace: 'b' }], 2),
    ).toThrow('expected 2 replacements, got 3');
  });
});
