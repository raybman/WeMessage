/**
 * v2 S6a: the bundler moved to tools/release/bin/bundle-daemon.mjs, so that
 * the Swift pack lane no longer reaches into apps/desktop. This file keeps
 * `pnpm --filter @wemessage/desktop run bundle:daemon` (and bundle.spec,
 * which runs this path) building exactly what they built before, until S6c
 * deletes apps/desktop and this file with it.
 */
import { pathToFileURL } from 'node:url';
import { bundleDaemon } from '../../../tools/release/bin/bundle-daemon.mjs';

export { bundleDaemon };

const invokedAs = process.argv[1];
if (
  invokedAs !== undefined &&
  import.meta.url === pathToFileURL(invokedAs).href
) {
  bundleDaemon(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
