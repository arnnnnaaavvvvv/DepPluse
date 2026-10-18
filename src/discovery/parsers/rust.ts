import type { DependencyRecord, DependencyType } from '../../core/types.js';

export function parseCargoToml(content: string, _filePath: string): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  const lines = content.split(/\r?\n/);

  let currentSection: 'dependencies' | 'dev-dependencies' | 'build-dependencies' | 'other' =
    'other';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('#') || !line) continue;

    if (line.startsWith('[')) {
      if (line === '[dependencies]' || line.startsWith('[dependencies.')) {
        currentSection = 'dependencies';
      } else if (line === '[dev-dependencies]' || line.startsWith('[dev-dependencies.')) {
        currentSection = 'dev-dependencies';
      } else if (line === '[build-dependencies]' || line.startsWith('[build-dependencies.')) {
        currentSection = 'build-dependencies';
      } else {
        currentSection = 'other';
      }
      continue;
    }

    if (currentSection !== 'other') {
      const type: DependencyType = currentSection === 'dev-dependencies' ? 'dev' : 'prod';
      // Match simple: serde = "1.0.204"
      // Match inline table: tokio = { version = "1.38.0", features = ["full"] }
      const simpleMatch = /^([a-zA-Z0-9_.-]+)\s*=\s*"([^"]+)"/.exec(line);
      const tableMatch = /^([a-zA-Z0-9_.-]+)\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/.exec(line);

      const match = simpleMatch || tableMatch;
      if (match && match[1] && match[2]) {
        const name = match[1];
        const range = match[2];
        records.push({
          id: `${name}@${range}`,
          name,
          declaredRange: range,
          resolvedVersion: range,
          type,
          source: 'crates',
          ecosystem: 'crates',
          registryUrl: 'https://crates.io',
          isDirect: true,
          dependents: [],
        });
      }
    }
  }

  return records;
}

export function parseCargoLock(content: string): Map<string, string> {
  const locked = new Map<string, string>();
  const blocks = content.split('[[package]]');

  for (const block of blocks) {
    const nameMatch = /name\s*=\s*"([^"]+)"/.exec(block);
    const verMatch = /version\s*=\s*"([^"]+)"/.exec(block);
    if (nameMatch && nameMatch[1] && verMatch && verMatch[1]) {
      locked.set(nameMatch[1], verMatch[1]);
    }
  }

  return locked;
}
