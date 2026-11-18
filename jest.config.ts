import type { Config } from 'jest';
import { pathsToModuleNameMapper } from 'ts-jest';

const { compilerOptions } = require('./tsconfig.base.json');
const workspacePaths = Object.fromEntries(
  Object.entries(compilerOptions.paths as Record<string, string[]>).filter(
    ([name]) => name.startsWith('@gitroom/')
  )
);

const config: Config = {
  roots: ['<rootDir>/apps', '<rootDir>/libraries'],
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/\\.next/'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      { tsconfig: { ...compilerOptions, isolatedModules: true } },
    ],
  },
  moduleNameMapper: pathsToModuleNameMapper(workspacePaths, {
    prefix: '<rootDir>/',
  }),
};

export default config;
