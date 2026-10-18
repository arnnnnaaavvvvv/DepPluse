import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';

import {
  parseRequirementsTxt,
  parsePyprojectToml,
  parsePoetryLock,
} from '../../../src/discovery/parsers/python.js';
import { parseCargoToml, parseCargoLock } from '../../../src/discovery/parsers/rust.js';
import { parseGoMod, parseGoSum } from '../../../src/discovery/parsers/golang.js';
import { parseGemfile, parseGemfileLock } from '../../../src/discovery/parsers/ruby.js';
import { parseComposerJson } from '../../../src/discovery/parsers/php.js';
import { parsePomXml, parseBuildGradle } from '../../../src/discovery/parsers/jvm.js';
import { parseCsProj, parsePackagesConfig } from '../../../src/discovery/parsers/dotnet.js';
import { discoverDependencies } from '../../../src/discovery/index.js';

describe('Multi-Language Ecosystem Parsers & Polyglot Discovery', () => {
  it('parses Python requirements.txt correctly', () => {
    const content = `
# Core Web Framework
Flask>=2.0.0,<3.0.0
requests==2.31.0; python_version >= '3.8'
urllib3~=1.26.5
# Dev tools
pytest
-r other.txt
`;
    const deps = parseRequirementsTxt(content, 'requirements.txt');
    expect(deps).toHaveLength(4);
    expect(deps[0]?.name).toBe('flask');
    expect(deps[0]?.declaredRange).toBe('>=2.0.0');
    expect(deps[0]?.ecosystem).toBe('pypi');

    expect(deps[1]?.name).toBe('requests');
    expect(deps[1]?.resolvedVersion).toBe('2.31.0');
    expect(deps[1]?.ecosystem).toBe('pypi');
  });

  it('parses Python pyproject.toml and poetry.lock', () => {
    const tomlContent = `
[project]
name = "api-service"
version = "0.1.0"
dependencies = [
    "fastapi>=0.110.0",
    "uvicorn[standard]==0.29.0",
]
`;
    const deps = parsePyprojectToml(tomlContent, 'pyproject.toml');
    expect(deps).toHaveLength(2);
    expect(deps[0]?.name).toBe('fastapi');
    expect(deps[0]?.ecosystem).toBe('pypi');

    const lockContent = `
[[package]]
name = "fastapi"
version = "0.110.2"

[[package]]
name = "uvicorn"
version = "0.29.0"
`;
    const locked = parsePoetryLock(lockContent);
    expect(locked.get('fastapi')).toBe('0.110.2');
  });

  it('parses Rust Cargo.toml and Cargo.lock', () => {
    const tomlContent = `
[package]
name = "rust-service"
version = "0.1.0"

[dependencies]
serde = "1.0.204"
tokio = { version = "1.38.0", features = ["full"] }

[dev-dependencies]
criterion = "0.5"
`;
    const deps = parseCargoToml(tomlContent, 'Cargo.toml');
    expect(deps).toHaveLength(3);
    const serde = deps.find(d => d.name === 'serde');
    expect(serde?.declaredRange).toBe('1.0.204');
    expect(serde?.type).toBe('prod');
    expect(serde?.ecosystem).toBe('crates');

    const crit = deps.find(d => d.name === 'criterion');
    expect(crit?.type).toBe('dev');

    const lockContent = `
[[package]]
name = "serde"
version = "1.0.204"

[[package]]
name = "tokio"
version = "1.38.0"
`;
    const locked = parseCargoLock(lockContent);
    expect(locked.get('tokio')).toBe('1.38.0');
  });

  it('parses Go go.mod and go.sum', () => {
    const modContent = `
module myapp

go 1.22.0

require (
    github.com/gin-gonic/gin v1.9.1
    github.com/google/uuid v1.6.0 // indirect
)
`;
    const deps = parseGoMod(modContent, 'go.mod');
    expect(deps).toHaveLength(2);
    const gin = deps.find(d => d.name === 'github.com/gin-gonic/gin');
    expect(gin?.isDirect).toBe(true);
    expect(gin?.type).toBe('prod');
    expect(gin?.ecosystem).toBe('golang');

    const uuid = deps.find(d => d.name === 'github.com/google/uuid');
    expect(uuid?.isDirect).toBe(false);
    expect(uuid?.type).toBe('transitive');

    const sumContent = `
github.com/gin-gonic/gin v1.9.1 h1:4+fr/ElTqUqGPrVj0qNCK...
github.com/google/uuid v1.6.0 h1:NIvaJDMO68D6p421zpDt...
`;
    const locked = parseGoSum(sumContent);
    expect(locked.get('github.com/gin-gonic/gin')).toBe('v1.9.1');
  });

  it('parses Ruby Gemfile and Gemfile.lock', () => {
    const gemfile = `
source 'https://rubygems.org'
gem 'rails', '~> 7.1.3'
gem 'pg', '>= 1.5'
`;
    const deps = parseGemfile(gemfile, 'Gemfile');
    expect(deps).toHaveLength(2);
    expect(deps[0]?.name).toBe('rails');
    expect(deps[0]?.ecosystem).toBe('rubygems');

    const lockfile = `
GEM
  remote: https://rubygems.org/
  specs:
    rails (7.1.3.2)
    pg (1.5.6)
`;
    const locked = parseGemfileLock(lockfile);
    expect(locked.get('rails')).toBe('7.1.3.2');
  });

  it('parses PHP composer.json and composer.lock', () => {
    const composer = JSON.stringify({
      require: {
        'symfony/console': '^6.4',
        'guzzlehttp/guzzle': '^7.8',
      },
      'require-dev': {
        'phpunit/phpunit': '^10.5',
      },
    });
    const deps = parseComposerJson(composer, 'composer.json');
    expect(deps).toHaveLength(3);
    const guzzle = deps.find(d => d.name === 'guzzlehttp/guzzle');
    expect(guzzle?.type).toBe('prod');
    expect(guzzle?.ecosystem).toBe('packagist');

    const phpunit = deps.find(d => d.name === 'phpunit/phpunit');
    expect(phpunit?.type).toBe('dev');
  });

  it('parses JVM pom.xml and build.gradle', () => {
    const pom = `
<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>3.2.4</version>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
`;
    const deps = parsePomXml(pom, 'pom.xml');
    expect(deps).toHaveLength(2);
    expect(deps[0]?.name).toBe('org.springframework.boot:spring-boot-starter-web');
    expect(deps[0]?.type).toBe('prod');
    expect(deps[1]?.type).toBe('dev');

    const gradle = `
dependencies {
    implementation 'io.jsonwebtoken:jjwt-api:0.12.5'
    testImplementation "org.mockito:mockito-core:5.11.0"
}
`;
    const gradleDeps = parseBuildGradle(gradle, 'build.gradle');
    expect(gradleDeps).toHaveLength(2);
    expect(gradleDeps[0]?.name).toBe('io.jsonwebtoken:jjwt-api');
  });

  it('parses .NET .csproj and packages.config', () => {
    const csproj = `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
    <PackageReference Include="Serilog" Version="3.1.1" />
  </ItemGroup>
</Project>
`;
    const deps = parseCsProj(csproj, 'test.csproj');
    expect(deps).toHaveLength(2);
    expect(deps[0]?.name).toBe('Newtonsoft.Json');
    expect(deps[0]?.ecosystem).toBe('nuget');

    const config = `
<packages>
  <package id="Dapper" version="2.1.35" targetFramework="net48" />
</packages>
`;
    const configDeps = parsePackagesConfig(config, 'packages.config');
    expect(configDeps).toHaveLength(1);
    expect(configDeps[0]?.name).toBe('Dapper');
  });

  it('executes polyglot discovery in a project directory containing multiple language manifests', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deppulse-polyglot-'));
    try {
      // 1. Add package.json (Node.js)
      await fs.writeFile(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          name: 'fullstack-app',
          version: '1.0.0',
          dependencies: { express: '^4.19.2' },
        }),
      );

      // 2. Add requirements.txt (Python backend/scripts)
      await fs.writeFile(
        path.join(tmpDir, 'requirements.txt'),
        'fastapi==0.110.0\nuvicorn>=0.29.0\n',
      );

      // 3. Add Cargo.toml (Rust core module)
      await fs.writeFile(
        path.join(tmpDir, 'Cargo.toml'),
        '[package]\nname = "core"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1.0.204"\n',
      );

      const discovery = await discoverDependencies(tmpDir);
      expect(discovery.dependencies.length).toBeGreaterThanOrEqual(4);

      const express = discovery.dependencies.find(d => d.name === 'express');
      expect(express?.ecosystem).toBe('npm');

      const fastapi = discovery.dependencies.find(d => d.name === 'fastapi');
      expect(fastapi?.ecosystem).toBe('pypi');

      const serde = discovery.dependencies.find(d => d.name === 'serde');
      expect(serde?.ecosystem).toBe('crates');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
