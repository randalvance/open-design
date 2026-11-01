import type Database from 'better-sqlite3';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { getInstalledPlugin } from './registry.js';

/**
 * Resolve the exact record already selected from the local catalogue. Local
 * identity resolution only: once a source is supplied, a same-id record from a
 * different source is not substituted.
 */
export async function resolveLocalPluginBySource(input: {
  db: Database.Database;
  id: string;
  source: string;
}): Promise<InstalledPluginRecord | null> {
  const installed = getInstalledPlugin(input.db, input.id);
  return installed?.source === input.source ? installed : null;
}
