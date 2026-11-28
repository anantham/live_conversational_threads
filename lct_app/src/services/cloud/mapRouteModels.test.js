// Test intent (review fix, 2026-11-27): the model a route sends is the one its own Settings row names.
// A row set back to "Site default", or a second row on the same provider, never borrows another model.
import { describe, expect, it } from 'vitest';
import { normalizeProviderPreferences } from './sitesProviderPreferences';
import { configuredMapRoutes } from './openRouterClient';

describe('map route models', () => {
  it('uses the site configuration, not the old model, once a row is set back to Site default', () => {
    let preferences = normalizeProviderPreferences({ mapChain: [{ backend: 'openrouter', model: 'vendor/model-x' }] });
    expect(preferences.models.openrouter).toBe('vendor/model-x');
    preferences = normalizeProviderPreferences({ ...preferences, mapChain: [{ backend: 'openrouter', model: '' }] });
    expect(preferences.models.openrouter).toBeUndefined();
    // The Settings row says "Site default"; the step goes to the site's configuration, not the personal key.
    expect(configuredMapRoutes({ preferences, keys: { openrouter: 'synthetic-key' } })).toEqual([{ backend: 'openrouter' }]);
  });

  it('does not let a second row on the same provider borrow the first row\'s model', () => {
    const preferences = normalizeProviderPreferences({ mapChain: [{ backend: 'openrouter', model: 'vendor/model-x' }, { backend: 'openrouter', model: '', provider: 'fixture' }] });
    expect(configuredMapRoutes({ preferences, keys: { openrouter: 'synthetic-key' } })).toEqual([{ backend: 'openrouter', key: 'synthetic-key', model: 'vendor/model-x' }, { backend: 'openrouter' }]);
  });

  it('still reads the model from preferences saved before the chain existed', () => {
    const preferences = normalizeProviderPreferences({ map: ['openrouter'], models: { openrouter: 'vendor/legacy' } });
    expect(preferences.mapChain).toEqual([{ backend: 'openrouter', model: 'vendor/legacy' }]);
  });
});
