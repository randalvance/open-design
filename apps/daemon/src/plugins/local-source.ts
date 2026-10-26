import type Database from 'better-sqlite3';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { getInstalledPlugin } from './registry.js';

/**
 * Resolve the exact record already selected from the local catalogue.
 *
 * PRODUCT INVARIANT: this is local identity resolution, not authorization.
 * The caller named a plugin by id AND by the source it saw in the catalogue;
 * a record whose source has since changed is not the plugin they picked.
 */
export async function resolveLocalPluginBySource(input: {
  db: Database.Database;
  id: string;
  source: string;
  userPluginsRoot: string;
}): Promise<InstalledPluginRecord | null> {
  const { db, id, source } = input;
  const installed = getInstalledPlugin(db, id);
  return installed?.source === source ? installed : null;
}
