/**
 * A conformant adapter that also reports on its own environment, so the token
 * rows can be answered from the CHILD's side rather than from the kit's.
 *
 * It checks the two things that matter and then deliberately misbehaves: it
 * prints its own token. The kit cannot stop a stranger's process from doing
 * that, and pretending otherwise would be the wrong lesson. What it can do is
 * refuse to relay the secret into an operator's terminal or a CI log, which
 * is the surface it actually controls, so the transcript comes back redacted.
 */
const token = process.env.WEMESSAGE_ADAPTER_TOKEN ?? '';
const argv = process.argv.join(' ');

process.stdout.write(
  `ENV_HAS_TOKEN=${String(/^wm_[0-9a-f]{64}$/.test(token))}\n`,
);
process.stdout.write(`ARGV_HAS_TOKEN=${String(argv.includes(token))}\n`);
process.stdout.write(`LEAK_ATTEMPT=${token}\n`);

await import('../../examples/reference-adapter.mjs');
