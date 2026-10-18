import type { DependencyRecord, DependencyType } from '../../core/types.js';

export function parsePomXml(content: string, _filePath: string): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  const depBlocks = content.split('<dependency>');

  for (let i = 1; i < depBlocks.length; i++) {
    const block = depBlocks[i]?.split('</dependency>')[0];
    if (!block) continue;

    const groupMatch = /<groupId>([^<]+)<\/groupId>/.exec(block);
    const artifactMatch = /<artifactId>([^<]+)<\/artifactId>/.exec(block);
    const versionMatch = /<version>([^<]+)<\/version>/.exec(block);
    const scopeMatch = /<scope>([^<]+)<\/scope>/.exec(block);

    if (groupMatch && groupMatch[1] && artifactMatch && artifactMatch[1]) {
      const name = `${groupMatch[1].trim()}:${artifactMatch[1].trim()}`;
      const version = versionMatch ? versionMatch[1]!.trim() : '*';
      const scope = scopeMatch ? scopeMatch[1]!.trim() : 'compile';
      const type: DependencyType = scope === 'test' ? 'dev' : 'prod';

      records.push({
        id: `${name}@${version}`,
        name,
        declaredRange: version,
        resolvedVersion: version,
        type,
        source: 'maven',
        ecosystem: 'maven',
        registryUrl: 'https://search.maven.org',
        isDirect: true,
        dependents: [],
      });
    }
  }

  return records;
}

export function parseBuildGradle(content: string, _filePath: string): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('//') || !line) continue;

    // Matches: implementation 'org.springframework:spring-core:6.1.5'
    // Matches: testImplementation("junit:junit:4.13.2")
    const match =
      /(?:implementation|api|compile|testImplementation|runtimeOnly)\s*\(?['"]([^:'"]+):([^:'"]+):?([^'")]*)['"]\)?/.exec(
        line,
      );
    if (match && match[1] && match[2]) {
      const group = match[1];
      const artifact = match[2];
      const ver = match[3] ? match[3] : '*';
      const name = `${group}:${artifact}`;
      const type: DependencyType = line.includes('test') ? 'dev' : 'prod';

      records.push({
        id: `${name}@${ver}`,
        name,
        declaredRange: ver,
        resolvedVersion: ver,
        type,
        source: 'maven',
        ecosystem: 'maven',
        registryUrl: 'https://search.maven.org',
        isDirect: true,
        dependents: [],
      });
    }
  }

  return records;
}
