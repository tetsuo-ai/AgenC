import { describe, expect, it } from 'vitest';
import { getSecretInputValue, resolveSecretPatchValue } from './secretInput';

describe('secretInput helpers', () => {
  it('shows configured masked value until the input is touched', () => {
    expect(getSecretInputValue(null, '****0p1l')).toBe('****0p1l');
  });

  it('keeps the configured value when the input was never edited', () => {
    expect(resolveSecretPatchValue(null, '****0p1l')).toBe('****0p1l');
  });

  it('allows clearing a configured secret by saving an empty string', () => {
    expect(resolveSecretPatchValue('', '****0p1l')).toBe('');
  });

  it('ignores masked placeholder values when building the patch', () => {
    expect(resolveSecretPatchValue('****0p1l', '****0p1l')).toBe('****0p1l');
  });
});
