import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';
import { PATHS } from '../paths.js';

class TestFeatureService {
  private cache: boolean | null = null;

  isEnabled(): boolean {
    if (this.cache !== null) return this.cache;
    const raw = readJsonSafe<unknown>(PATHS.testFeature, { enabled: false }, { label: 'test-feature.json' });
    const src = (raw && typeof raw === 'object' ? raw : {}) as { enabled?: unknown };
    this.cache = src.enabled === true;
    return this.cache;
  }

  getState(): { enabled: boolean } {
    return { enabled: this.isEnabled() };
  }

  setEnabled(raw: unknown): { enabled: boolean } {
    const next = raw === true;
    writeJsonAtomic(PATHS.testFeature, { enabled: next }, { trailingNewline: true });
    this.cache = next;
    return { enabled: next };
  }
}

export const testFeatureService = new TestFeatureService();
