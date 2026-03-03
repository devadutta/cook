import { describe, expect, it } from 'bun:test';
import { parseConfirmationInput } from '../src/confirm.ts';

describe('parseConfirmationInput', () => {
  it('approves yes variants', () => {
    expect(parseConfirmationInput('y')).toEqual({ kind: 'approve' });
    expect(parseConfirmationInput('YES')).toEqual({ kind: 'approve' });
    expect(parseConfirmationInput('  Yes  ')).toEqual({ kind: 'approve' });
  });

  it('approves all variants', () => {
    expect(parseConfirmationInput('a')).toEqual({ kind: 'approve_all' });
    expect(parseConfirmationInput('ALL')).toEqual({ kind: 'approve_all' });
    expect(parseConfirmationInput('  all  ')).toEqual({ kind: 'approve_all' });
  });

  it('declines no variants and empty input', () => {
    expect(parseConfirmationInput('n')).toEqual({ kind: 'decline' });
    expect(parseConfirmationInput('No')).toEqual({ kind: 'decline' });
    expect(parseConfirmationInput('   ')).toEqual({ kind: 'decline' });
  });

  it('treats arbitrary non-empty text as guidance', () => {
    expect(parseConfirmationInput('use a different branch name')).toEqual({
      kind: 'guidance',
      text: 'use a different branch name',
    });
  });
});
