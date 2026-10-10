/** 测试公共加载器：注册表、合成夹具与夹具路径。 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchemasFromDir } from '../../packages/contracts/src/schema-registry.ts';

const helpersDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = dirname(dirname(helpersDir));
export const schemasDir = join(repoRoot, 'packages/contracts/schemas');
export const fixturesDir = join(repoRoot, 'tests/fixtures/synthetic');

export const registry = loadSchemasFromDir(schemasDir);

export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as T;
}

export function readRaw(name: string): string {
  return readFileSync(join(fixturesDir, 'raw', name), 'utf8');
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const IDS = {
  task: 'urn:tju-mas:contracts:task',
  documentIr: 'urn:tju-mas:contracts:document-ir',
  snapshot: 'urn:tju-mas:contracts:evidence-snapshot',
  evidenceInput: 'urn:tju-mas:contracts:evidence-input',
  evidenceOutput: 'urn:tju-mas:contracts:evidence-output',
  reviewInput: 'urn:tju-mas:contracts:review-input',
  reviewReport: 'urn:tju-mas:contracts:review-report',
  reviewOutput: 'urn:tju-mas:contracts:review-output',
  informationPlan: 'urn:tju-mas:contracts:information-plan',
  pageSpec: 'urn:tju-mas:contracts:page-spec',
  pageVersion: 'urn:tju-mas:contracts:page-version',
  changeSet: 'urn:tju-mas:contracts:change-set',
  designInput: 'urn:tju-mas:contracts:design-input',
  designOutput: 'urn:tju-mas:contracts:design-output',
} as const;

export const PLACEHOLDER_IDS = [
  IDS.informationPlan,
  IDS.pageSpec,
  IDS.pageVersion,
  IDS.changeSet,
  IDS.designInput,
  IDS.designOutput,
  'urn:tju-mas:contracts:component-engineer-input',
  'urn:tju-mas:contracts:component-engineer-output',
];