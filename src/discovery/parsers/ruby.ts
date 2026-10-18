import type { DependencyRecord } from '../../core/types.js';

export function parseGemfile(content: string, _filePath: string): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/.exec(line);
    if (match && match[1]) {
      const name = match[1];
      const range = match[2] ?? '*';
      records.push({
        id: `${name}@${range}`,
        name,
        declaredRange: range,
        resolvedVersion: range,
        type: 'prod',
        source: 'rubygems',
        ecosystem: 'rubygems',
        registryUrl: 'https://rubygems.org',
        isDirect: true,
        dependents: [],
      });
    }
  }

  return records;
}

export function parseGemfileLock(content: string): Map<string, string> {
  const locked = new Map<string, string>();
  const lines = content.split(/\r?\n/);

  let inSpecs = false;

  for (const line of lines) {
    if (line.trim() === 'specs:') {
      inSpecs = true;
      continue;
    }

    if (inSpecs) {
      if (line && !line.startsWith(' ') && !line.startsWith('\t')) {
        inSpecs = false;
        continue;
      }

      const match = /^\s{4,6}([a-zA-Z0-9_.-]+)\s+\(([^)]+)\)/.exec(line);
      if (match && match[1] && match[2]) {
        locked.set(match[1], match[2]);
      }
    }
  }

  return locked;
}
