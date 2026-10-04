import { sb } from './supabase.js';

// Public app_settings (shop info, payment methods, tax ...) cached per page load.
let cache = null;
export function getSettings(force = false) {
  if (!cache || force) {
    cache = sb.from('app_settings').select('key,value').then(({ data, error }) => {
      if (error) throw error;
      return Object.fromEntries((data || []).map(r => [r.key, r.value]));
    }).catch(e => { cache = null; throw e; });
  }
  return cache;
}
