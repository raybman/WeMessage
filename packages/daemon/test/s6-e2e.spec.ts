/**
 * s6-execution Scenario 14 ★ CHECKPOINT — S6 end to end: §4.2's demo, told
 * as ONE narrative.
 *
 * One temp dir, one fixture chat.db, the loopback backend, a hand-driven
 * clock, and the REAL `@wemessage/adapter-echo` running in-process over a
 * real loopback WebSocket against the real composed daemon. Every scope is
 * set through the operator's own route — `POST /v1/schedules`, `POST
 * /v1/rules`, `PUT /v1/contacts/:handle`, `POST /v1/toggles/global-mode` —
 * and the operator's own CLI is driven as a real subprocess where §4.2 says
 * an operator would type it.
 *
 * **What this file adds that no per-scenario suite can.** Scenarios 1-13
 * each proved one mechanism against a store they arranged by hand. This one
 * proves the mechanisms COMPOSE: that a schedule created over HTTP is the
 * same schedule the gate reads, that the arming badge an operator watches
 * and the clamp that withholds autonomy are derived from the same rows, and
 * that a machine's approval and a person's approval reach the backend
 * through the one `dispatchApproved` the whole product has.
 *
 * **The story, in the order it happens.**
 *
 *   A. a schedule with a two-minute window; a rule pointed at it; the
 *      contact and the global mode raised to `auto`. Only now is anything
 *      armed, and `GET /v1/status` says so with the window's close as its
 *      horizon — derived in the SCHEDULE's zone, never the host's.
 *   B. an inbound inside the window: rule.matched -> draft.request -> echo's
 *      deltas -> draft.created -> auto.approved -> draft.approved (system
 *      actor) -> grace -> tick -> loopback send -> draft.sent -> the
 *      `send_verified` feedback frame reaches echo. ONE approval, minted at
 *      the ONE mint site.
 *   C. the window shuts DURING an auto grace (F-72): the draft goes back to
 *      `pending`, is never re-auto-approved, and a human approves it later
 *      and it sends. A clamp withholds autonomy; it does not veto a person.
 *   D. the same traffic OUTSIDE the window: a draft, no approval, still
 *      pending ten ticks later, and the badge reads `outside-window`.
 *   E. a bot-to-bot echo storm inside the next window: three machine turns
 *      go out and the fourth is clamped `loop-detected`.
 *   F. over the per-contact cap: clamped `rate-limited`, and a person sends it.
 *   G. the breaker open: clamped `circuit-open`, and `wemessage resume
 *      --circuit` lifts it.
 *   H. the kill switch mid-grace: the autonomous send dies, and while the
 *      switch is on NOTHING drafts and NOBODY approves — machine and person
 *      alike.
 *   I. `wemessage pause 1h` as a real subprocess: autonomy stops, drafting
 *      continues, a human still sends.
 *   J. a restart in the middle of the pause: the deadline, the schedule, the
 *      rule and every draft state survive, and the reboot announces nothing.
 *   K. `wemessage resume`: the hold lifts and the very next inbound
 *      auto-approves again.
 *   L. the meta-assertions (§4.1 rows 2-8, C-6, C-9).
 *
 * **Three places this file states a fact rather than inheriting the plan's
 * prose. All three are the as-built behaviour that earlier S6 scenarios
 * ratified and pinned; none of them is a beat weakened to make a row pass.**
 *
 *  1. *Sc 14 RED row 3 asks `GET /v1/status` to report "the next open as
 *     `until`" while outside a window.* Sc 11 ratified the opposite and
 *     `arming.spec.ts` pins it: `until` is the earliest REAL horizon among
 *     the pause deadline, the CURRENT window's close and the breaker's
 *     expiry, so a shut window bounds nothing and reports `until: null`
 *     ("shut window alone: outside-window, and nothing bounds it"). Step D
 *     asserts the shipped triple and additionally computes `nextWindowOpen`
 *     from the same schedule, so the fact the plan wanted is still proven —
 *     as a property of the schedule, which is what it is, rather than as a
 *     field the badge does not carry.
 *
 *  2. *Sc 14 RED row 4, and plan §4-S6's demo, say the echo counterpart
 *     "trips `loop-detected` at message 3".* `send.loopConsecutiveAutoMax`
 *     defaults to 3 and the gate compares `>=`, which Sc 8 pinned as "three
 *     machine turns are allowed and the fourth is the one that clamps". So 3
 *     is the LIMIT, not the ordinal of the clamped message. Step E runs the
 *     storm to its real boundary: turns 1-3 send, turn 4 clamps.
 *
 *  3. *Sc 14 RED row 5 says that after a mid-grace kill "drafting still
 *     works ... while auto-approval is withheld".* That was true through S5
 *     and Sc 5 (F-60) deliberately ended it: the kill switch is a DENY at
 *     both gate moments now, so while the switch is on a rule-borne inbound
 *     produces no frame and no draft at all. Step H asserts the current
 *     behaviour (refused at the draft moment, one `gate.denied {kill-switch}`)
 *     and step I carries the "drafting continues while autonomy is withheld"
 *     half where it actually lives: the pause, which is a clamp.
 *
 * **The caps are moved by name, in the test body, and moved back.** F-66:
 * there is no value that disables a cap, and a harness that needs headroom
 * says so where a reviewer can see it. Step E raises the per-contact caps
 * for the storm because the shipped pacing cap would otherwise clamp turn 2
 * as `rate-limited` before the loop breaker could ever be reached; step F
 * restores the shipped defaults and lets the cap do exactly that.
 *
 * Every handle is synthetic (`+1555…`), the only timezone is `UTC` (one of
 * the five `arch.spec.ts` (f) pins), no message body is real, and every
 * instant comes from the injected clock.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ArmingState,
  AuditEvent,
  Draft,
  GateDecision,
  Handle,
  Message,
  Schedule,
} from '@wemessage/core';
import {
  evaluateGate,
  nextWindowOpen,
  parseChatGuid,
  readGateCounters,
  readGateSettings,
  readLoopCandidate,
  verifyChain,
  windowCloseAfter,
  SETTING_CAP_CONTACT_PER_2MIN,
  SETTING_CAP_CONTACT_PER_HOUR,
  SETTING_CAP_GLOBAL_PER_HOUR,
  SETTING_CIRCUIT_OPENED_AT,
} from '@wemessage/core';
import { createInboundDispatch, toGatewayEvent } from '@wemessage/daemon';
import {
  createEchoAdapter,
  type EchoAdapter,
  type EchoSocketFactory,
} from '@wemessage/adapter-echo';
import {
  auditActors,
  auditEvents,
  shutdown,
  CHAT,
  HANDLE,
  type Harness,
} from './helpers/draft-harness.js';
import {
  bootAgent,
  cleanupAgentHarness,
  waitUntil,
  type AgentHarness,
} from './helpers/agent-harness.js';
import { WS_EVENT_VOCABULARY } from './transport-surface.snapshot.js';

const CLI_BIN = fileURLToPath(
  new URL('../../cli/dist/bin.js', import.meta.url),
);
/** Any ANSI escape — which is every colour there is, green included (C-9). */
const ANSI_RE = /\x1b\[/;

const ADAPTER_ID = 'echo-1';
/** F-78's default: `send.autoGraceSeconds` inherits `send.undoGraceSeconds`. */
const GRACE_MS = 10_000;
const PAST_GRACE_MS = 11_000;
/** Inside the grace: a kill has to land while the send is still stoppable. */
const MID_GRACE_MS = 4_000;

/**
 * §4.2's demo timeline, in the schedule's own zone. The two-minute window is
 * the plan's, and it is what makes step C a real event rather than a fiction:
 * an approval taken at 09:01:55 arms a grace that elapses at 09:02:05, five
 * seconds after the window it was authorised under has shut.
 */
const W1_OPEN = '2026-09-01T09:00:00.000Z';
const W1_CLOSE = '2026-09-01T09:02:00.000Z';
const T_EDGE = '2026-09-01T09:01:55.000Z';
const T_SHUT = '2026-09-01T09:05:00.000Z';
const W2_OPEN = '2026-09-01T10:00:00.000Z';
const W2_CLOSE = '2026-09-01T11:00:00.000Z';
const T_STORM = W2_OPEN;
const T_CAPS = '2026-09-01T10:05:00.000Z';
const T_CIRCUIT = '2026-09-01T10:10:00.000Z';
const T_KILL = '2026-09-01T10:15:00.000Z';
const T_PAUSE = '2026-09-01T10:20:00.000Z';

const children: ChildProcess[] = [];
const transcripts: string[] = [];
const openSockets: WebSocket[] = [];
const echoes: EchoAdapter[] = [];

afterEach(async () => {
  for (const echo of echoes.splice(0)) echo.stop();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(
    openSockets.splice(0).map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === ws.CLOSED) return resolve();
          ws.on('close', () => resolve());
          ws.close();
        }),
    ),
  );
  await cleanupAgentHarness();
});

interface Frame {
  type: string;
  payload: Record<string, unknown>;
}

/** A real loopback socket for the real echo adapter, with a frame tap. */
interface EchoRig {
  /** Gateway -> adapter. */
  frames: Frame[];
  factory: EchoSocketFactory;
}

function echoRig(): EchoRig {
  const rig: EchoRig = {
    frames: [],
    factory: (url, handlers) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        openSockets.push(ws);
        ws.on('message', (data) => {
          const raw = String(data);
          rig.frames.push(JSON.parse(raw) as Frame);
          handlers.onMessage(raw);
        });
        ws.on('close', (code) => handlers.onClose(code));
        ws.on('error', reject);
        ws.on('open', () =>
          resolve({
            send: (data) => ws.send(data),
            close: (code) => ws.close(code ?? 1000),
          }),
        );
      }),
  };
  return rig;
}

function framesOf(rig: EchoRig, type: string): Frame[] {
  return rig.frames.filter((f) => f.type === type);
}

/** The daemon's `deliver` in miniature, composed exactly as `daemon.ts` does. */
function deliverer(h: AgentHarness): (message: Message) => Promise<void> {
  const dispatch = createInboundDispatch({
    store: h.store,
    clock: h.clockCtl.clock,
    sink: h.sink,
    reader: h.reader,
    transport: {
      isConnected: (id) => h.server.agentTransport?.isConnected(id) ?? false,
      sendTo: (id, frame) =>
        h.server.agentTransport?.sendTo(id, frame) ?? false,
    },
    issueRequest: (req) => h.server.agentRequests?.issue(req),
  });
  return async (message) => {
    h.store.insertInboundMessage(message);
    h.sink.broadcast(toGatewayEvent(message));
    await dispatch.emitWinner(message, h.store.listRules());
  };
}

let guidSeq = 0;

function inbound(h: AgentHarness, text: string): Message {
  guidSeq += 1;
  const at = h.clockCtl.clock.now();
  return {
    guid: `GUID-S6-${String(guidSeq)}`,
    sourceRowid: 6000 + guidSeq,
    chatGuid: CHAT,
    handle: HANDLE,
    isFromMe: false,
    isGroup: false,
    // Lowercase, always: `Service` is 'imessage' | 'sms' | 'rcs' | 'unknown',
    // and anything but 'imessage' is `sms-auto-forbidden` at the gate. A
    // fixture that spelled it 'iMessage' would clamp every auto row in this
    // file for a reason that has nothing to do with the beat under test.
    service: 'imessage',
    kind: 'text',
    text,
    attachments: [],
    sentAt: at,
    receivedAt: at,
  };
}

/**
 * The QUEUE: `listDrafts({})` deliberately excludes the terminal states
 * ("terminal states are history, not queue"), which is what every `pending`
 * and `approved` assertion below wants.
 */
function drafts(h: Harness): Draft[] {
  return h.store.listDrafts({});
}

/** Every draft ever, terminal ones included, straight off the table. */
function draftStates(h: Harness): Array<{ id: string; state: string }> {
  return h.store.db
    .prepare('SELECT id, state FROM drafts ORDER BY id')
    .all() as Array<{ id: string; state: string }>;
}

function events(h: Harness, type: string): AuditEvent[] {
  return auditEvents(h.store).filter((e) => e.type === type);
}

function allEvents(h: Harness): AuditEvent[] {
  return auditEvents(h.store);
}

function auditTail(h: Harness, from: number): string[] {
  return auditEvents(h.store)
    .slice(from)
    .map((e) => e.type);
}

function approvalsFor(h: Harness, draftId: string): unknown[] {
  return h.store.listApprovals(draftId);
}

/**
 * The gate exactly as `maybeAutoApprove` builds it, so a step can NAME the
 * clamp that withheld autonomy.
 *
 * A clamp writes no audit row (§1.7: a clamp is never audited as a deny), so
 * the only honest way to attribute a withheld approval to a cause is to ask
 * the same pure function the same question with the same inputs. The
 * observable half — no `Approval`, no `auto.approved`, still `pending` — is
 * asserted alongside it every time; this only supplies the WHY.
 */
function decisionFor(h: Harness, draft: Draft): GateDecision {
  const now = h.clockCtl.clock.now();
  const rule = draft.ruleId === null ? null : h.store.getRule(draft.ruleId);
  const scheduleId = rule?.scheduleId ?? null;
  const parsed = parseChatGuid(draft.chatGuid);
  const source =
    draft.inboundGuid === null || draft.inboundGuid === undefined
      ? null
      : h.store.getInboundMessage(draft.inboundGuid);
  const handle: Handle = source?.handle ?? parsed.handle;
  return evaluateGate({
    now,
    settings: readGateSettings(h.store),
    rule,
    schedule: scheduleId === null ? null : h.store.getSchedule(scheduleId),
    contact: h.store.getContactPolicy(handle),
    message: {
      isGroup: parsed.isGroup,
      service: source?.service ?? parsed.service,
      handle,
      chatGuid: draft.chatGuid,
    },
    counters: readGateCounters(h.store, {
      now,
      handle,
      chatGuid: draft.chatGuid,
    }),
    candidate: readLoopCandidate(h.store, {
      chatGuid: draft.chatGuid,
      body: draft.body,
    }),
  });
}

/**
 * The machine streak AS THE GATE SEES IT.
 *
 * `store.consecutiveAutoInChat` is the raw run; the 30-second inbound-pause
 * reset (F-62) is applied in `readGateCounters`, because it is a fact about
 * `now` and the store has no clock. Asserting the raw number would be
 * asserting a different quantity than the one that decides anything.
 */
function streak(h: Harness): number {
  return readGateCounters(h.store, {
    now: h.clockCtl.clock.now(),
    handle: HANDLE,
    chatGuid: CHAT,
  }).consecutiveAutoInChat;
}

function clampOf(h: Harness, draft: Draft): string {
  const decision = decisionFor(h, draft);
  if (!decision.allow) return `denied:${decision.reason}`;
  return decision.clampedBy ?? 'none';
}

function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      env: { ...process.env, ...env },
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      transcripts.push(stdout, stderr);
      resolve({ code, stdout, stderr });
    });
  });
}

function cliEnv(h: AgentHarness): Record<string, string> {
  return {
    WEMESSAGE_PORT: String(Number(new URL(h.baseUrl).port)),
    WEMESSAGE_TOKEN: h.server.token ?? '',
  };
}

async function status(h: AgentHarness): Promise<{
  armed: ArmingState | null;
  killSwitch: boolean | null;
  connectionState: string;
}> {
  const res = await h.server.app.inject({
    method: 'GET',
    url: '/v1/status',
    headers: h.headers,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    armed: ArmingState | null;
    killSwitch: boolean | null;
    connectionState: string;
  };
}

/** A real authenticated `/v1/events` socket — what `wemessage watch` is. */
async function busWatcher(
  h: AgentHarness,
  sink: Array<{ event: string }>,
): Promise<WebSocket> {
  const bus = new WebSocket(`${h.baseUrl}/v1/events`, { headers: h.headers });
  openSockets.push(bus);
  bus.on('message', (d) =>
    sink.push(JSON.parse(String(d)) as { event: string }),
  );
  await new Promise<void>((resolve) => bus.on('open', () => resolve()));
  return bus;
}

/** Connect the REAL echo adapter over a REAL socket and wait for health. */
async function connectEcho(
  h: AgentHarness,
  token: string,
): Promise<{ rig: EchoRig; echo: EchoAdapter }> {
  const rig = echoRig();
  const echo = createEchoAdapter({
    url: `${h.baseUrl}/v1/agent`,
    token,
    adapterId: ADAPTER_ID,
    ws: rig.factory,
    clock: h.clockCtl.clock,
    streaming: true,
    delay: () => Promise.resolve(),
  });
  echoes.push(echo);
  void echo.run();
  await waitUntil(
    () => h.store.getAdapter(ADAPTER_ID)?.health === 'connected',
    'echo connected',
  );
  return { rig, echo };
}

describe('s6 Scenario 14: arming and autonomy, end to end', () => {
  it('runs §4.2: schedule, three scopes, auto-send, requeue, outside, loop, cap, breaker, kill, pause, restart, resume', async () => {
    // ---- A. the schedule, the rule, and the three scopes -----------------
    let h = await bootAgent({ rules: true, startIso: W1_OPEN });
    const before = new Set(readdirSync(h.dir));
    const busFrames: Array<{ event: string }> = [];
    await busWatcher(h, busFrames);

    const registered = await h.server.app.inject({
      method: 'POST',
      url: '/v1/adapters',
      headers: h.headers,
      payload: { id: ADAPTER_ID, kind: 'echo', displayName: 'Echo' },
    });
    expect(registered.statusCode).toBe(201);
    const token = (registered.json() as { token: string }).token;
    let { rig } = await connectEcho(h, token);

    // The window is the plan's two minutes; the second is the room the rest
    // of the narrative needs. Both in UTC, because a schedule's zone is the
    // only zone that ever decides anything (§1.7) and UTC is one of the five
    // `arch.spec.ts` (f) pins.
    const week = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const scheduleRes = await h.server.app.inject({
      method: 'POST',
      url: '/v1/schedules',
      headers: h.headers,
      payload: {
        name: 'demo-window',
        timezone: 'UTC',
        windows: [
          { days: week, start: '09:00', end: '09:02' },
          { days: week, start: '10:00', end: '11:00' },
        ],
        enabled: true,
      },
    });
    expect(scheduleRes.statusCode).toBe(201);
    const schedule = (scheduleRes.json() as { schedule: Schedule }).schedule;
    expect(events(h, 'schedule.created')).toHaveLength(1);

    const ruleRes = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: h.headers,
      payload: {
        name: 'auto demo',
        matcher: { kind: 'keyword', keywords: ['tacos'], mode: 'any' },
        adapterId: ADAPTER_ID,
        respondMode: 'auto',
        scheduleId: schedule.id,
        outsideWindow: 'draft-only',
        // Eight hours, so no row below is secretly asserting the TTL.
        draftTtlMinutes: 480,
      },
    });
    expect(ruleRes.statusCode).toBe(201);
    const ruleId = (ruleRes.json() as { rule: { id: string } }).rule.id;

    // Scope two and scope three. Nothing is auto until all three say so, and
    // the daemon is NOT armed for autonomy before the last of them lands.
    expect(
      (
        await h.server.app.inject({
          method: 'PUT',
          url: `/v1/contacts/${encodeURIComponent(HANDLE)}`,
          headers: h.headers,
          payload: { mode: 'auto' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await h.server.app.inject({
          method: 'POST',
          url: '/v1/toggles/global-mode',
          headers: h.headers,
          payload: { mode: 'auto' },
        })
      ).statusCode,
    ).toBe(200);
    expect(events(h, 'arming.mode-changed')).toEqual([
      { type: 'arming.mode-changed', mode: 'auto' },
    ]);

    /**
     * F-66, by name and in the open, at the top of the narrative rather than
     * buried in a helper: §4.2's demo says more in ten scripted minutes than
     * the shipped pacing cap (ONE auto send per contact per two minutes)
     * allows, so nearly every beat below would clamp `rate-limited` for a
     * reason that has nothing to do with the beat. There is no value that
     * disables a cap and none is used here: these are raised numbers, and
     * step F puts the shipped defaults back and lets the cap do exactly what
     * it is for, on the one beat that is about the cap.
     */
    const raiseCaps = (): void => {
      h.store.setSetting(SETTING_CAP_CONTACT_PER_2MIN, '50');
      h.store.setSetting(SETTING_CAP_CONTACT_PER_HOUR, '50');
      h.store.setSetting(SETTING_CAP_GLOBAL_PER_HOUR, '50');
    };
    raiseCaps();

    // The badge, derived on the request. `until` is the window's close in the
    // SCHEDULE's zone; the host's zone is never read by anything (§1.7).
    expect((await status(h)).armed).toEqual({
      armed: true,
      until: W1_CLOSE,
      reason: 'armed',
    });
    expect(windowCloseAfter(schedule, W1_OPEN)).toBe(W1_CLOSE);

    const deliver = deliverer(h);

    // ---- B. inside the window: the whole autonomous leg, in order --------
    const markB = allEvents(h).length;
    await deliver(inbound(h, 'tacos tonight?'));
    await waitUntil(() => drafts(h).length === 1, 'the first agent draft');
    const first = drafts(h)[0] as Draft;

    // The state change: approved by a machine, with a real grace ahead of it
    // (F-78 refuses a zero grace), and nothing sent yet.
    expect(first.state).toBe('approved');
    expect(first.body).toBe('echo: tacos tonight?');
    expect(h.backend.callCount()).toBe(0);

    // The record: one ordered run on one chain, and exactly ONE approval.
    expect(auditTail(h, markB)).toEqual([
      'rule.matched',
      'draft.created',
      'auto.approved',
      'draft.approved',
    ]);
    expect(approvalsFor(h, first.id)).toHaveLength(1);
    expect(auditActors(h.store, 'draft.approved')).toEqual([
      { kind: 'system', reason: 'auto-respond' },
    ]);
    expect(events(h, 'auto.approved')[0]).toMatchObject({
      type: 'auto.approved',
      draftId: first.id,
      ruleId,
      adapterId: ADAPTER_ID,
      scopes: { global: 'auto', contact: 'auto', rule: 'auto' },
      scheduleId: schedule.id,
      armedUntil: W1_CLOSE,
    });

    // The agent really streamed it, over a real socket, and the operator's
    // own bus really saw the deltas.
    expect(framesOf(rig, 'draft.request')).toHaveLength(1);
    await waitUntil(
      () => busFrames.filter((f) => f.event === 'draft.delta').length === 3,
      'three deltas on the client bus',
    );

    // The grace is real: one tick before it elapses sends nothing.
    h.clockCtl.advance(GRACE_MS - 1);
    await h.scheduler.tick();
    expect(h.backend.callCount()).toBe(0);
    expect(h.store.getDraft(first.id)?.state).toBe('approved');

    h.clockCtl.advance(1);
    await h.scheduler.tick();
    expect(h.store.getDraft(first.id)?.state).toBe('sent');
    expect(h.backend.callCount()).toBe(1);
    expect(auditActors(h.store, 'draft.sent')).toEqual([
      { kind: 'system', reason: 'auto-respond' },
    ]);
    await waitUntil(
      () =>
        framesOf(rig, 'draft.feedback').some(
          (f) => f.payload['kind'] === 'send_verified',
        ),
      'send_verified reached echo',
    );

    // ---- C. the window shuts DURING the grace (F-72) ---------------------
    h.clockCtl.set(T_EDGE);
    const markC = allEvents(h).length;
    await deliver(inbound(h, 'tacos at nine?'));
    await waitUntil(
      () => drafts(h).some((d) => d.state === 'approved'),
      'the edge draft was auto-approved',
    );
    const edge = drafts(h).find((d) => d.state === 'approved') as Draft;
    expect(edge.sendNotBefore).toBe('2026-09-01T09:02:05.000Z');

    // Past the grace, and past the close it was authorised under.
    h.clockCtl.advance(PAST_GRACE_MS);
    expect(h.store.getSchedule(schedule.id)).not.toBeNull();
    await h.scheduler.tick();

    // Not a failure and not a send: back to the queue, for a person.
    expect(h.store.getDraft(edge.id)?.state).toBe('pending');
    expect(h.store.getDraft(edge.id)?.sendNotBefore ?? null).toBeNull();
    expect(h.backend.callCount()).toBe(1);
    expect(auditTail(h, markC)).toEqual([
      'rule.matched',
      'draft.created',
      'auto.approved',
      'draft.approved',
      'arming.changed',
      'draft.requeued',
      'gate.denied',
    ]);
    expect(events(h, 'draft.requeued')).toEqual([
      { type: 'draft.requeued', draftId: edge.id, reason: 'outside-window' },
    ]);
    expect(auditActors(h.store, 'draft.requeued')).toEqual([
      { kind: 'system', reason: 'window-closed' },
    ]);

    // It is never re-auto-approved: autonomy had its shot and missed.
    const autoApprovalsAfterRequeue = events(h, 'auto.approved').length;
    for (let i = 0; i < 5; i += 1) await h.scheduler.tick();
    expect(h.store.getDraft(edge.id)?.state).toBe('pending');
    expect(events(h, 'auto.approved')).toHaveLength(autoApprovalsAfterRequeue);

    // A human still can, and a clamp does not veto a person.
    expect(
      (
        await h.server.app.inject({
          method: 'POST',
          url: `/v1/drafts/${edge.id}/approve`,
          headers: h.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(edge.id)?.state).toBe('sent');
    expect(h.backend.callCount()).toBe(2);

    // ---- D. outside the window: a draft, and nobody but a person ---------
    h.clockCtl.set(T_SHUT);
    const badge = await status(h);
    // Sc 11's ratified triple: a shut window bounds nothing, so `until` is
    // null. The next open is a property of the SCHEDULE, and it is exactly
    // the second window, computed from the same rows the badge read.
    expect(badge.armed).toEqual({
      armed: false,
      until: null,
      reason: 'outside-window',
    });
    expect(nextWindowOpen(schedule, T_SHUT)).toBe(W2_OPEN);

    const markD = allEvents(h).length;
    await deliver(inbound(h, 'tacos tomorrow?'));
    await waitUntil(
      () => drafts(h).some((d) => d.state === 'pending'),
      'the outside-window draft landed',
    );
    const parked = drafts(h).find((d) => d.state === 'pending') as Draft;
    expect(clampOf(h, parked)).toBe('outside-window');
    expect(approvalsFor(h, parked.id)).toEqual([]);
    expect(auditTail(h, markD)).toEqual(['rule.matched', 'draft.created']);

    for (let i = 0; i < 10; i += 1) await h.scheduler.tick();
    expect(h.store.getDraft(parked.id)?.state).toBe('pending');
    expect(h.backend.callCount()).toBe(2);

    // ---- E. the echo storm: three machine turns, then the breaker --------
    h.clockCtl.set(T_STORM);
    expect((await status(h)).armed).toEqual({
      armed: true,
      until: W2_CLOSE,
      reason: 'armed',
    });
    // The headroom from step A is what lets three machine turns land inside
    // one minute at all: `rate-limited` sits ABOVE `loop-detected` in the
    // else-if chain, so at the shipped cap turn 2 would clamp on pacing and
    // the loop breaker would never be reached to be tested.

    let echoedBack = 'tacos, storm 0';
    const stormSends: number[] = [];
    for (let turn = 1; turn <= 3; turn += 1) {
      const sentBefore = h.backend.callCount();
      await deliver(inbound(h, echoedBack));
      await waitUntil(
        () => drafts(h).some((d) => d.state === 'approved'),
        `storm turn ${String(turn)} was auto-approved`,
      );
      const reply = drafts(h).find((d) => d.state === 'approved') as Draft;
      h.clockCtl.advance(PAST_GRACE_MS);
      await h.scheduler.tick();
      expect(h.store.getDraft(reply.id)?.state).toBe('sent');
      stormSends.push(h.backend.callCount() - sentBefore);
      // A true echo counterpart: it says back exactly what we just said.
      echoedBack = reply.body;
    }
    expect(stormSends).toEqual([1, 1, 1]);

    const markE = allEvents(h).length;
    await deliver(inbound(h, echoedBack));
    await waitUntil(
      () => drafts(h).some((d) => d.state === 'pending' && d.id !== parked.id),
      'the fourth turn still drafted',
    );
    const looped = drafts(h).find(
      (d) => d.state === 'pending' && d.id !== parked.id,
    ) as Draft;
    // Three machine turns are allowed; the fourth is the one that clamps.
    expect(streak(h)).toBe(3);
    expect(clampOf(h, looped)).toBe('loop-detected');
    expect(approvalsFor(h, looped.id)).toEqual([]);
    expect(auditTail(h, markE)).toEqual(['rule.matched', 'draft.created']);

    // ---- F. over the cap: clamped, and a person sends it -----------------
    h.clockCtl.set(T_CAPS);
    // The shipped defaults, restored explicitly (F-66). The gap since the
    // storm's last send is four and a half minutes, so the streak has reset
    // and the only limit left in play is the pacing cap.
    h.store.setSetting(SETTING_CAP_CONTACT_PER_2MIN, '1');
    h.store.setSetting(SETTING_CAP_CONTACT_PER_HOUR, '10');
    h.store.setSetting(SETTING_CAP_GLOBAL_PER_HOUR, '30');
    expect(streak(h)).toBe(0);

    await deliver(inbound(h, 'tacos on tuesday?'));
    await waitUntil(
      () => drafts(h).some((d) => d.state === 'approved'),
      'the first inbound of the minute was auto-approved',
    );
    const withinCap = drafts(h).find((d) => d.state === 'approved') as Draft;
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(withinCap.id)?.state).toBe('sent');

    const markF = allEvents(h).length;
    await deliver(inbound(h, 'tacos on wednesday?'));
    await waitUntil(
      () =>
        drafts(h).some(
          (d) =>
            d.state === 'pending' && d.id !== parked.id && d.id !== looped.id,
        ),
      'the over-cap draft landed',
    );
    const capped = drafts(h).find(
      (d) => d.state === 'pending' && d.id !== parked.id && d.id !== looped.id,
    ) as Draft;
    expect(clampOf(h, capped)).toBe('rate-limited');
    expect(approvalsFor(h, capped.id)).toEqual([]);
    expect(auditTail(h, markF)).toEqual(['rule.matched', 'draft.created']);

    // The per-contact cap paces a MACHINE and never a person (§2.4.3).
    expect(
      (
        await h.server.app.inject({
          method: 'POST',
          url: `/v1/drafts/${capped.id}/approve`,
          headers: h.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(capped.id)?.state).toBe('sent');

    // ---- G. the breaker open: clamped, and `resume --circuit` lifts it ---
    h.clockCtl.set(T_CIRCUIT);
    // Headroom again, same chain, same reason: a cap left at 1 from step F
    // would answer `rate-limited` and the breaker's own clamp would never be
    // the one reported.
    raiseCaps();
    // Written straight to the setting the breaker is MADE of, rather than
    // manufacturing five real send failures: the beat under test is what an
    // open breaker does to autonomy, and earning it would cost five failed
    // sends this narrative would then have to explain.
    h.store.setSetting(SETTING_CIRCUIT_OPENED_AT, T_CIRCUIT);
    expect((await status(h)).armed).toEqual({
      armed: false,
      until: '2026-09-01T10:25:00.000Z',
      reason: 'circuit-open',
    });

    const markG = allEvents(h).length;
    await deliver(inbound(h, 'tacos on thursday?'));
    await waitUntil(
      () => drafts(h).filter((d) => d.state === 'pending').length === 3,
      'the breaker-clamped draft landed',
    );
    const broken = drafts(h).find(
      (d) => d.state === 'pending' && d.id !== parked.id && d.id !== looped.id,
    ) as Draft;
    expect(clampOf(h, broken)).toBe('circuit-open');
    expect(approvalsFor(h, broken.id)).toEqual([]);
    expect(auditTail(h, markG)).toEqual(['rule.matched', 'draft.created']);

    const resumeCircuit = await runCli(
      ['resume', '--circuit', '--json'],
      cliEnv(h),
    );
    expect(resumeCircuit.code).toBe(0);
    expect(
      JSON.parse(resumeCircuit.stdout) as { circuitCleared: boolean },
    ).toMatchObject({ circuitCleared: true });
    expect(h.store.getSetting(SETTING_CIRCUIT_OPENED_AT)).toBeNull();
    expect((await status(h)).armed).toMatchObject({
      armed: true,
      reason: 'armed',
    });

    // Lifting the hold does not retro-approve what it withheld: a person does.
    expect(h.store.getDraft(broken.id)?.state).toBe('pending');
    expect(approvalsFor(h, broken.id)).toEqual([]);
    expect(
      (
        await h.server.app.inject({
          method: 'POST',
          url: `/v1/drafts/${broken.id}/approve`,
          headers: h.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(broken.id)?.state).toBe('sent');

    // ---- H. the kill switch: machine and person alike --------------------
    h.clockCtl.set(T_KILL);
    await deliver(inbound(h, 'tacos on friday?'));
    await waitUntil(
      () => drafts(h).some((d) => d.state === 'approved'),
      'the doomed draft was auto-approved',
    );
    const doomed = drafts(h).find((d) => d.state === 'approved') as Draft;
    h.clockCtl.advance(MID_GRACE_MS);
    const sentBeforeKill = h.backend.callCount();
    expect(
      (
        await h.server.app.inject({
          method: 'POST',
          url: '/v1/toggles/kill-switch',
          headers: h.headers,
          payload: { on: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(h.store.getDraft(doomed.id)?.state).toBe('rejected');
    expect(auditActors(h.store, 'draft.rejected')).toContainEqual({
      kind: 'system',
      reason: 'kill-switch',
    });
    await h.scheduler.tick();
    expect(h.backend.callCount()).toBe(sentBeforeKill);

    // The switch is a DENY at the draft moment too (Sc 5, F-60): no frame,
    // no draft, one row naming the message. Not a clamp — nothing survives.
    const requestsWhenKilled = framesOf(rig, 'draft.request').length;
    const draftsWhenKilled = drafts(h).length;
    const killed = inbound(h, 'tacos on saturday?');
    await deliver(killed);
    expect(drafts(h)).toHaveLength(draftsWhenKilled);
    expect(framesOf(rig, 'draft.request')).toHaveLength(requestsWhenKilled);
    expect(
      events(h, 'gate.denied').filter(
        (e) => (e as { guid?: string }).guid === killed.guid,
      ),
    ).toEqual([
      {
        type: 'gate.denied',
        reason: 'kill-switch',
        adapterId: ADAPTER_ID,
        guid: killed.guid,
      },
    ]);

    // And a person cannot approve past it either.
    const refused = await h.server.app.inject({
      method: 'POST',
      url: `/v1/drafts/${parked.id}/approve`,
      headers: h.headers,
      payload: {},
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      error: 'gate-denied',
      reason: 'kill-switch',
    });
    expect(h.store.getDraft(parked.id)?.state).toBe('pending');
    expect(
      (
        await h.server.app.inject({
          method: 'POST',
          url: '/v1/toggles/kill-switch',
          headers: h.headers,
          payload: { on: false },
        })
      ).statusCode,
    ).toBe(200);

    // ---- I. `wemessage pause 1h`: everything holds, a person still sends -
    h.clockCtl.set(T_PAUSE);
    const paused = await runCli(['pause', '1h', '--json'], cliEnv(h));
    expect(paused.code).toBe(0);
    const pauseUntil = (JSON.parse(paused.stdout) as { until: string }).until;
    expect(pauseUntil).toBe('2026-09-01T11:20:00.000Z');

    // The badge names the hold the OPERATOR caused (`paused`, above the
    // schedule in §1.3.6's precedence) but counts down to the earliest real
    // horizon, which here is the window's close rather than the pause's own
    // deadline: an hour's pause set forty minutes before the window shuts
    // ends in a daemon that is still not armed, and a countdown to 11:20
    // would be a promise the schedule does not keep.
    expect((await status(h)).armed).toEqual({
      armed: false,
      until: W2_CLOSE,
      reason: 'paused',
    });
    const cliStatus = await runCli(['status'], cliEnv(h));
    expect(cliStatus.code).toBe(0);
    expect(cliStatus.stdout).toContain(`○ HELD: paused until ${W2_CLOSE}`);
    expect(Date.parse(pauseUntil)).toBeGreaterThan(Date.parse(W2_CLOSE));

    // Drafting continues; autonomy does not. This is the half of Sc 14 row 5
    // that the kill switch stopped being able to demonstrate at Sc 5.
    const markI = allEvents(h).length;
    await deliver(inbound(h, 'tacos on sunday?'));
    await waitUntil(
      () => drafts(h).filter((d) => d.state === 'pending').length === 3,
      'a draft still lands while paused',
    );
    const held = drafts(h).find(
      (d) => d.state === 'pending' && d.id !== parked.id && d.id !== looped.id,
    ) as Draft;
    // F-68: pause reuses the `outside-window` literal rather than minting one.
    expect(clampOf(h, held)).toBe('outside-window');
    expect(approvalsFor(h, held.id)).toEqual([]);
    expect(auditTail(h, markI)).toEqual(['rule.matched', 'draft.created']);

    expect(
      (
        await h.server.app.inject({
          method: 'POST',
          url: `/v1/drafts/${held.id}/approve`,
          headers: h.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(held.id)?.state).toBe('sent');

    // ---- J. a restart, mid-pause -----------------------------------------
    const restartAt = h.clockCtl.clock.now();
    const postureBefore = (await status(h)).armed;
    const armingRowsBefore = events(h, 'arming.changed').length;
    const statesBefore = draftStates(h);
    /**
     * Sends so far, counted two ways that must agree: the in-process backend
     * and the `sent` drafts on disk. Only the second survives the restart —
     * the backend is a process object, not a table — which is exactly why
     * the count is taken here and re-derived from the store afterwards.
     */
    const sendsBefore = h.backend.callCount();
    expect(draftStates(h).filter((d) => d.state === 'sent')).toHaveLength(
      sendsBefore,
    );

    for (const echo of echoes.splice(0)) echo.stop();
    await waitUntil(
      () => (h.server.agentTransport?.openSessions() ?? 0) === 0,
      'the adapter session drained before the restart',
    );
    const dir = h.dir;
    const fixture = h.fixture;
    await shutdown(h);

    h = await bootAgent({
      dir,
      fixture,
      rules: true,
      startIso: restartAt,
    });
    await busWatcher(h, busFrames);
    ({ rig } = await connectEcho(h, token));

    // Everything on disk survived, and nothing was re-announced: a deadline
    // is not a timer, and the on-change witness is a settings row.
    expect((await status(h)).armed).toEqual(postureBefore);
    expect(h.store.getSchedule(schedule.id)).toEqual(schedule);
    expect(h.store.getRule(ruleId)?.respondMode).toBe('auto');
    expect(draftStates(h)).toEqual(statesBefore);
    expect(events(h, 'arming.changed')).toHaveLength(armingRowsBefore);
    await h.scheduler.tick();
    expect(events(h, 'arming.changed')).toHaveLength(armingRowsBefore);

    // ---- K. `wemessage resume`: the hold lifts, autonomy returns ---------
    const resumed = await runCli(['resume', '--json'], cliEnv(h));
    expect(resumed.code).toBe(0);
    expect(
      JSON.parse(resumed.stdout) as { pauseCleared: boolean },
    ).toMatchObject({ pauseCleared: true });
    expect((await status(h)).armed).toEqual({
      armed: true,
      until: W2_CLOSE,
      reason: 'armed',
    });

    const deliverAgain = deliverer(h);
    await deliverAgain(inbound(h, 'tacos once more?'));
    await waitUntil(
      () => drafts(h).some((d) => d.state === 'approved'),
      'autonomy came back with the resume',
    );
    const released = drafts(h).find((d) => d.state === 'approved') as Draft;
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(released.id)?.state).toBe('sent');
    // One send on the NEW process's backend, and one more row on the old
    // disk: the ledger is the thing that carries across a restart.
    expect(h.backend.callCount()).toBe(1);

    // ---- L. the meta-assertions (§4.1 rows 2-8, C-6, C-9) ----------------

    // The chain verifies over the whole mix, in-process and through the CLI.
    const cliVerify = await runCli(['audit', 'verify', '--json'], cliEnv(h));
    expect(cliVerify.code).toBe(0);
    expect(JSON.parse(cliVerify.stdout) as { ok: boolean }).toMatchObject({
      ok: true,
    });
    expect(verifyChain(h.store.readAuditRows(0, 20_000))).toMatchObject({
      ok: true,
    });

    // Nothing green, nothing coloured, no token material, on any surface.
    expect(transcripts.length).toBeGreaterThan(0);
    for (const text of transcripts) {
      expect(ANSI_RE.test(text)).toBe(false);
      expect(text).not.toContain(token);
    }

    // Only vocabulary-listed events reached the operator's bus.
    expect(busFrames.length).toBeGreaterThan(0);
    for (const frame of busFrames) {
      expect(WS_EVENT_VOCABULARY).toContain(frame.event);
    }
    expect(busFrames.map((f) => f.event)).toContain('arming.changed');

    // Every terminal state came through the transition table.
    expect(events(h, 'draft.illegal-transition')).toHaveLength(0);

    // C-6: exactly the reasons this narrative provoked, and no other. A
    // clamp is never audited as a deny, so `rate-limited`, `circuit-open`
    // and `loop-detected` are deliberately ABSENT here — every one of them
    // withheld autonomy without refusing anybody.
    expect(
      new Set(
        events(h, 'gate.denied').map((e) => (e as { reason?: string }).reason),
      ),
    ).toEqual(new Set(['outside-window', 'kill-switch']));

    /**
     * INV-2, over the whole file: nothing reached the backend except through
     * `dispatchApproved` with a validated `Approval`, once.
     *
     * The approval count per sent draft is `1 + requeues`, not a flat 1, and
     * the difference is F-72 rather than a leak. `requeue` withdraws the
     * approval by moving the draft back to `pending` and clearing
     * `sendNotBefore`; it deliberately does NOT delete the row, because the
     * row is the record that a machine once decided to say this, and an
     * audit trail that erases withdrawn decisions is not one. What must
     * still be exactly one is the SEND: one `send_ledger` row per sent
     * draft, first attempt, loopback. So this asserts the invariant in the
     * shape the product actually has, and step C's beat is where the extra
     * approval is accounted for by name.
     */
    const sent = draftStates(h).filter((d) => d.state === 'sent');
    expect(sent.length).toBe(sendsBefore + 1);
    const ledger = h.store.db
      .prepare('SELECT draft_id, attempt, backend FROM send_ledger')
      .all() as Array<{ draft_id: string; attempt: number; backend: string }>;
    expect(ledger).toHaveLength(sent.length);
    const requeues = events(h, 'draft.requeued') as Array<{ draftId: string }>;
    for (const draft of sent) {
      const withdrawn = requeues.filter((e) => e.draftId === draft.id).length;
      expect(approvalsFor(h, draft.id)).toHaveLength(1 + withdrawn);
      expect(ledger.filter((r) => r.draft_id === draft.id)).toEqual([
        { draft_id: draft.id, attempt: 1, backend: 'loopback' },
      ]);
    }
    // And the one draft that was requeued is the only one carrying two.
    expect(requeues.map((e) => e.draftId)).toEqual([edge.id]);

    // The count of system-actor approvals equals the count of `auto.approved`
    // rows, exactly. One mint site, one row per mint, no exceptions.
    const systemApprovals = draftStates(h)
      .flatMap((d) => h.store.listApprovals(d.id))
      .filter(
        (a) => a.actor.kind === 'system' && a.actor.reason === 'auto-respond',
      );
    expect(systemApprovals).toHaveLength(events(h, 'auto.approved').length);
    expect(systemApprovals.length).toBeGreaterThan(0);

    // Zero real network: every socket this narrative opened is loopback, and
    // every send the backend saw belongs to this one conversation.
    for (const ws of openSockets) expect(ws.url).toContain('127.0.0.1');
    for (const call of h.backend.calls()) expect(call.chatGuid).toBe(CHAT);

    // Zero writes outside the temp dir, sqlite's own sidecars excepted.
    const added = readdirSync(dir).filter((e) => !before.has(e));
    expect(added.filter((e) => !/-(wal|shm|journal)$/.test(e))).toEqual([]);
  });
});
