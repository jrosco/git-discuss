export function resolveIdentifier(input: string, ids: string[], label: string): string {
  const prefix = input.toLowerCase();
  if (!/^[a-f0-9][a-f0-9-]{3,35}$/.test(prefix)) {
    throw new Error(`${label}: use a full UUID or an ID prefix of at least 4 characters.`);
  }
  const matches = ids.filter(id => id.startsWith(prefix));
  if (matches.length === 0) throw new Error(`${label} does not exist: ${input}`);
  if (matches.length > 1) throw new Error(`${label} prefix "${input}" is ambiguous. Use more characters: ${matches.join(', ')}`);
  return matches[0];
}

export function shortIdentifier(id: string, ids: string[]): string {
  let length = 8;
  while (length < id.length && ids.some(other => other !== id && other.startsWith(id.slice(0, length)))) length++;
  return id.slice(0, length);
}
