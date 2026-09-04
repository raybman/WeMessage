/**
 * s5-execution Scenario 13 — the shapes an adapter under test must present.
 *
 * The kit never opens a socket and never spawns a process. An adapter is a
 * function of an injected socket factory, a clock and a backoff, exactly as
 * `@wemessage/adapter-echo` and `@wemessage/adapter-sol` are built, and the
 * kit hands it a factory wired to an in-memory mock gateway. That is the
 * whole reason the suite is deterministic: there is no port, no listener and
 * no wall clock between the check and the frame it is asserting on.
 *
 * A transport-level runner (`--transport ws --cmd "python my_adapter.py"`,
 * plan §3.7) is a strictly larger surface built on this one, and it ships
 * with the public packaging in S7 (F-52). Nothing here presumes it.
 */

/** The bit of a socket the kit and every first-party adapter actually use. */
export interface TestkitSocket {
  send(data: string): void;
  close(code?: number): void;
}

/** Callbacks a socket factory wires up before it resolves. */
export interface TestkitSocketHandlers {
  onMessage(raw: string): void;
  onClose(code: number): void;
}

export type TestkitSocketFactory = (
  url: string,
  handlers: TestkitSocketHandlers,
) => Promise<TestkitSocket>;

/** What the kit injects into the adapter it is testing. */
export interface AdapterStartContext {
  url: string;
  /** The id the kit expects in `hello`. Injected so the mock can be strict. */
  adapterId: string;
  token: string;
  ws: TestkitSocketFactory;
  /** Fail-closed ceiling the kit asserts against in check 5. */
  maxAttempts: number;
  /** Injected backoff: the kit resolves immediately, so nothing sleeps. */
  delay(ms: number): Promise<void>;
  clock: { now(): string };
}

/** The running adapter. `run()` resolves with a process exit code. */
export interface AdapterHandle {
  run(): Promise<number>;
  stop(): void;
}

/**
 * A third party implements exactly this to run the kit against its adapter.
 * `start` is called once per check with a fresh mock gateway; an adapter that
 * cannot be started twice in one process is an adapter with global state,
 * which is itself worth finding out about.
 */
export interface AdapterUnderTest {
  name: string;
  start(ctx: AdapterStartContext): AdapterHandle;
}
