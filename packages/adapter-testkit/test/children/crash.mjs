/**
 * Dies before it ever greets anybody. The other half of row 5.
 *
 * From the socket's point of view this is indistinguishable from `hang.mjs`:
 * no `hello` arrives either way. From the process's point of view it is not
 * remotely the same bug, so the kit reports `crashed` and the exit code
 * rather than `timeout`.
 */
process.stderr.write('reference child: configuration error, exiting\n');
process.exit(3);
