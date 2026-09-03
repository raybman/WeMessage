/**
 * §1.6 route: GET /v1/doctor (s3-execution Scenario 8). A thin wrapper over
 * the Scenario 7 degradation engine (`../doctor.js`'s `runDoctor`) — same
 * probe-derive-persist-audit-broadcast behavior, only-on-change included.
 * The daemon itself only ever calls `runDoctor` reactively (boot, and on a
 * scan-loop EPERM/EACCES); this route is the on-demand trigger an operator
 * or `wemessage doctor` (CLI, S3 Scenario 10) needs on top of that.
 */
import type { FastifyInstance } from 'fastify';
import type { Clock, Store } from '@wemessage/core';
import type { AuditSink } from '../audit-sink.js';
import { runDoctor, type DoctorProbes } from '../doctor.js';

export interface DoctorRouteDeps {
  probes: DoctorProbes;
  store: Store;
  sink: Pick<AuditSink, 'append' | 'broadcast'>;
  clock: Clock;
}

export function registerDoctorRoutes(
  app: FastifyInstance,
  deps: DoctorRouteDeps,
): void {
  app.get('/v1/doctor', () => runDoctor(deps));
}
