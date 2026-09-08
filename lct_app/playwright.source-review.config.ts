import { defineConfig } from '@playwright/test';
import release from './playwright.release.config';

export default defineConfig({ ...release,
  testMatch: ['source-review-disclosure.spec.ts'],
  outputDir: '../tmp/source-review-browser-results',
  reporter: 'list',
});
