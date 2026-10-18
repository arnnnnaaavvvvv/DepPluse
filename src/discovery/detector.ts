import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { SupportedEcosystem } from '../core/types.js';

export interface DetectedManifest {
  readonly ecosystem: SupportedEcosystem;
  readonly manifestPath: string;
  readonly lockfilePath?: string | undefined;
}

export async function detectEcosystemManifests(projectDir: string): Promise<DetectedManifest[]> {
  const manifests: DetectedManifest[] = [];

  const checkFile = async (name: string): Promise<boolean> => {
    try {
      const s = await fs.stat(path.join(projectDir, name));
      return s.isFile();
    } catch {
      return false;
    }
  };

  // 1. Node.js (npm / yarn / pnpm)
  if (await checkFile('package.json')) {
    let lockfile: string | undefined;
    if (await checkFile('package-lock.json')) lockfile = path.join(projectDir, 'package-lock.json');
    else if (await checkFile('npm-shrinkwrap.json'))
      lockfile = path.join(projectDir, 'npm-shrinkwrap.json');
    else if (await checkFile('pnpm-lock.yaml')) lockfile = path.join(projectDir, 'pnpm-lock.yaml');
    else if (await checkFile('yarn.lock')) lockfile = path.join(projectDir, 'yarn.lock');

    manifests.push({
      ecosystem: 'npm',
      manifestPath: path.join(projectDir, 'package.json'),
      lockfilePath: lockfile,
    });
  }

  // 2. Python (requirements.txt, pyproject.toml, Pipfile)
  if (await checkFile('requirements.txt')) {
    manifests.push({
      ecosystem: 'pypi',
      manifestPath: path.join(projectDir, 'requirements.txt'),
    });
  } else if (await checkFile('pyproject.toml')) {
    let lockfile: string | undefined;
    if (await checkFile('poetry.lock')) lockfile = path.join(projectDir, 'poetry.lock');
    manifests.push({
      ecosystem: 'pypi',
      manifestPath: path.join(projectDir, 'pyproject.toml'),
      lockfilePath: lockfile,
    });
  } else if (await checkFile('Pipfile')) {
    let lockfile: string | undefined;
    if (await checkFile('Pipfile.lock')) lockfile = path.join(projectDir, 'Pipfile.lock');
    manifests.push({
      ecosystem: 'pypi',
      manifestPath: path.join(projectDir, 'Pipfile'),
      lockfilePath: lockfile,
    });
  }

  // 3. Rust (Cargo.toml)
  if (await checkFile('Cargo.toml')) {
    let lockfile: string | undefined;
    if (await checkFile('Cargo.lock')) lockfile = path.join(projectDir, 'Cargo.lock');
    manifests.push({
      ecosystem: 'crates',
      manifestPath: path.join(projectDir, 'Cargo.toml'),
      lockfilePath: lockfile,
    });
  }

  // 4. Go (go.mod)
  if (await checkFile('go.mod')) {
    let lockfile: string | undefined;
    if (await checkFile('go.sum')) lockfile = path.join(projectDir, 'go.sum');
    manifests.push({
      ecosystem: 'golang',
      manifestPath: path.join(projectDir, 'go.mod'),
      lockfilePath: lockfile,
    });
  }

  // 5. Ruby (Gemfile)
  if (await checkFile('Gemfile')) {
    let lockfile: string | undefined;
    if (await checkFile('Gemfile.lock')) lockfile = path.join(projectDir, 'Gemfile.lock');
    manifests.push({
      ecosystem: 'rubygems',
      manifestPath: path.join(projectDir, 'Gemfile'),
      lockfilePath: lockfile,
    });
  }

  // 6. PHP (composer.json)
  if (await checkFile('composer.json')) {
    let lockfile: string | undefined;
    if (await checkFile('composer.lock')) lockfile = path.join(projectDir, 'composer.lock');
    manifests.push({
      ecosystem: 'packagist',
      manifestPath: path.join(projectDir, 'composer.json'),
      lockfilePath: lockfile,
    });
  }

  // 7. Java / JVM (pom.xml, build.gradle)
  if (await checkFile('pom.xml')) {
    manifests.push({
      ecosystem: 'maven',
      manifestPath: path.join(projectDir, 'pom.xml'),
    });
  } else if (await checkFile('build.gradle')) {
    manifests.push({
      ecosystem: 'maven',
      manifestPath: path.join(projectDir, 'build.gradle'),
    });
  } else if (await checkFile('build.gradle.kts')) {
    manifests.push({
      ecosystem: 'maven',
      manifestPath: path.join(projectDir, 'build.gradle.kts'),
    });
  }

  // 8. .NET (packages.config)
  if (await checkFile('packages.config')) {
    manifests.push({
      ecosystem: 'nuget',
      manifestPath: path.join(projectDir, 'packages.config'),
    });
  }

  return manifests;
}
