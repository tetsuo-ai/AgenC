export type SecretInputValue = string | null;

export function getSecretInputValue(
  inputValue: SecretInputValue,
  configuredValue: string,
): string {
  return inputValue ?? configuredValue;
}

export function resolveSecretPatchValue(
  inputValue: SecretInputValue,
  configuredValue: string,
): string {
  if (inputValue === null) {
    return configuredValue;
  }
  if (inputValue.startsWith('****')) {
    return configuredValue;
  }
  return inputValue;
}
