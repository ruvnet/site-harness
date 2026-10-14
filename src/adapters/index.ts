import { nativeOperations } from './catalog.js';
import { executeProductHunt } from './producthunt.js';
import { executeReddit } from './reddit.js';
import { AdapterError } from './types.js';
import type { NativeOptions } from './types.js';
import { validateParameters } from './validation.js';

export { nativeOperations } from './catalog.js';
export { AdapterError } from './types.js';
export type { AdapterErrorCode, NativeOperation, NativeOptions, NativeSite } from './types.js';

export async function executeNativeOperation(site: string, name: string, args: unknown = {}, options: NativeOptions = {}): Promise<unknown> {
  const operation = nativeOperations.find((entry) => entry.site === site && entry.name === name);
  if (!operation) throw new AdapterError('UNKNOWN_OPERATION', 'Unknown native operation. List available operations for this site.');
  const parameters = validateParameters(operation, args);
  return operation.site === 'producthunt' ? executeProductHunt(name, parameters, options) : executeReddit(name, parameters, options);
}
