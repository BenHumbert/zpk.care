/**
 * Interactive Demo Routes — HTTP handlers for the interactive demo.
 *
 * Registers endpoints on L2RpcServer:
 *   GET  /interactive/state          — current session state
 *   GET  /interactive/console        — SSE stream of console events
 *   POST /interactive/enroll         — execute member enrollment
 *   POST /interactive/enroll-family  — enroll subscriber + all dependents
 *   POST /interactive/assign-pcp     — assign PCP with consent proof
 *   GET  /interactive/member-history  — get member's Rx history (PCP-gated)
 *   GET  /interactive/family-history  — get family-level history + pooled accumulators
 *   POST /interactive/request-prior-auth — prescriber requests PA for PA-required med
 *   POST /interactive/approve-prior-auth — insurer approves PA (generates provePriorAuth proof)
 *   POST /interactive/deny-prior-auth    — insurer denies PA request
 *   POST /interactive/prescribe          — create prescription with proofs (enforces PA)
 *   POST /interactive/fill               — kick off async fill (returns 202, poll fill-status)
 *   GET  /interactive/fill-status       — poll fill job status
 *   POST /interactive/update-rx-status   — cancel/reject prescription (state machine enforced)
 *   POST /interactive/reverse            — reverse a filled prescription (ZK proof + accumulator rollback)
 *   POST /interactive/terminate-member   — terminate a member (revoke credential, cancel Rx)
 *   POST /interactive/terminate-group    — terminate all members in a group
 *   POST /interactive/send-message       — send encrypted message (any party → any party)
 *   POST /interactive/decrypt-thread    — batch decrypt messages in a thread
 *   GET  /interactive/threads           — get conversation threads for a wallet
 *   POST /interactive/create-delegation  — create delegation (member → member, ZK proof)
 *   POST /interactive/generate-credential — generate portable credential (ZK proof)
 *   POST /interactive/verify-credential   — verify portable credential offline
 *   POST /interactive/update-formulary    — modify/remove/add formulary entries (cascades to credentials)
 *   POST /interactive/plan-year-rollover  — reset accumulators for new plan year
 *   GET  /interactive/step-therapy-check  — check step therapy eligibility for a medication
 *   POST /interactive/reset              — reset session state
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { L2RpcServer } from '../../src/l2/l2-rpc-server.js';
import type { InteractiveDemoService, ConsoleEvent } from './interactive-service.js';

export function registerInteractiveRoutes(
  server: L2RpcServer,
  service: InteractiveDemoService,
): void {
  // Console SSE clients
  const consoleSseClients: Set<ServerResponse> = new Set();

  // Bridge console events from the service to SSE clients
  const consoleEmitter = (event: ConsoleEvent): void => {
    const data = JSON.stringify(event);
    for (const client of consoleSseClients) {
      try {
        client.write(`event: console\ndata: ${data}\n\n`);
      } catch {
        consoleSseClients.delete(client);
      }
    }
    // Also log to server console for debugging
    const ts = new Date(event.timestamp).toLocaleTimeString();
    const elapsed = event.elapsedMs ? ` (${(event.elapsedMs / 1000).toFixed(2)}s)` : '';
    console.log(`[${ts}] [${event.type}] ${event.message}${elapsed}`);
  };

  // GET /interactive/console — SSE stream
  server.registerRoute('GET', '/interactive/console', async (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    consoleSseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

    req.on('close', () => {
      consoleSseClients.delete(res);
    });
  });

  // GET /interactive/state
  server.registerRoute('GET', '/interactive/state', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const state = service.getState();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(state, 'getState'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[/interactive/state] Error:', message);
      sendError(res, 500, message);
    }
  });

  // ─── Async Enrollment ─────────────────────────────────────
  // Enrollment runs ZK proof generation which can take 30-60s.
  // We fire-and-forget, then the client polls for status every 15s.
  const enrollmentJobs = new Map<number, { status: 'pending' | 'complete' | 'error'; result?: unknown; error?: string }>();

  // POST /interactive/enroll — kicks off enrollment, returns immediately
  server.registerRoute('POST', '/interactive/enroll', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);
      const memberIndex = params.memberIndex;

      if (typeof memberIndex !== 'number') {
        sendError(res, 400, 'Missing or invalid memberIndex');
        return;
      }

      // If already running or complete, return current status
      const existing = enrollmentJobs.get(memberIndex);
      if (existing) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(safeJsonStringify(existing, 'enroll'));
        return;
      }

      // Mark as pending and kick off in background
      enrollmentJobs.set(memberIndex, { status: 'pending' });

      service.getL2Node().withProvingLock(() => service.enrollMember(memberIndex))
        .then((result) => {
          enrollmentJobs.set(memberIndex, { status: 'complete', result });
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          enrollmentJobs.set(memberIndex, { status: 'error', error: message });
        });

      res.writeHead(202, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({ status: 'pending', memberIndex }, 'enroll'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /interactive/enroll-status?memberIndex=N — poll for enrollment result
  server.registerRoute('GET', '/interactive/enroll-status', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const memberIndex = parseInt(url.searchParams.get('memberIndex') ?? '', 10);

      if (isNaN(memberIndex)) {
        sendError(res, 400, 'Missing or invalid memberIndex query parameter');
        return;
      }

      const job = enrollmentJobs.get(memberIndex);
      if (!job) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ status: 'not_started' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });

      // Clear completed/errored jobs so re-enrollment is possible after reset
      if (job.status === 'complete' || job.status === 'error') {
        enrollmentJobs.delete(memberIndex);
      }

      res.end(safeJsonStringify(job, 'enroll-status'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/request-prior-auth
  server.registerRoute('POST', '/interactive/request-prior-auth', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.memberWalletId !== 'string' ||
          typeof params.prescriberIndex !== 'number' ||
          typeof params.medicationIndex !== 'number') {
        sendError(res, 400, 'Missing required fields: memberWalletId, prescriberIndex, medicationIndex');
        return;
      }

      const result = service.requestPriorAuth({
        memberWalletId: params.memberWalletId,
        prescriberIndex: params.prescriberIndex,
        medicationIndex: params.medicationIndex,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/approve-prior-auth
  server.registerRoute('POST', '/interactive/approve-prior-auth', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.priorAuthId !== 'string') {
        sendError(res, 400, 'Missing required field: priorAuthId');
        return;
      }

      const result = await service.getL2Node().withProvingLock(() => service.approvePriorAuth(params.priorAuthId));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/deny-prior-auth
  server.registerRoute('POST', '/interactive/deny-prior-auth', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.priorAuthId !== 'string') {
        sendError(res, 400, 'Missing required field: priorAuthId');
        return;
      }

      const result = service.denyPriorAuth(params.priorAuthId);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/prescribe
  server.registerRoute('POST', '/interactive/prescribe', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.prescriberIndex !== 'number' ||
          typeof params.memberWalletId !== 'string' ||
          typeof params.medicationIndex !== 'number' ||
          typeof params.pharmacyIndex !== 'number') {
        sendError(res, 400, 'Missing required fields: prescriberIndex, memberWalletId, medicationIndex, pharmacyIndex');
        return;
      }

      const result = await service.getL2Node().withProvingLock(() => service.createPrescription({
        prescriberIndex: params.prescriberIndex,
        memberWalletId: params.memberWalletId,
        medicationIndex: params.medicationIndex,
        pharmacyIndex: params.pharmacyIndex,
        quantity: params.quantity ?? 30,
        refills: params.refills ?? 3,
      }));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/fill — async fire-and-forget (poll fill-status for result)
  const fillJobs = new Map<string, { status: 'pending' | 'complete' | 'error'; result?: unknown; error?: string }>();

  server.registerRoute('POST', '/interactive/fill', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.prescriptionId !== 'string') {
        sendError(res, 400, 'Missing required field: prescriptionId');
        return;
      }
      if (typeof params.credentialJson !== 'string') {
        sendError(res, 400, 'Missing required field: credentialJson (member holding proof)');
        return;
      }

      const jobKey = params.prescriptionId;

      // If already running or complete, return current status
      const existing = fillJobs.get(jobKey);
      if (existing) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(safeJsonStringify(existing, 'fill'));
        return;
      }

      // Mark as pending and kick off in background
      fillJobs.set(jobKey, { status: 'pending' });

      service.getL2Node().withProvingLock(() => service.fillPrescription({
        prescriptionId: params.prescriptionId,
        credentialJson: params.credentialJson,
        quantityDispensed: params.quantityDispensed,
        ingredientCostCents: params.ingredientCostCents,
        dispensingFeeCents: params.dispensingFeeCents,
      }))
        .then((result) => {
          fillJobs.set(jobKey, { status: 'complete', result });
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          fillJobs.set(jobKey, { status: 'error', error: message });
        });

      res.writeHead(202, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({ status: 'pending', prescriptionId: jobKey }, 'fill'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /interactive/fill-status?prescriptionId=X — poll for fill result
  server.registerRoute('GET', '/interactive/fill-status', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const prescriptionId = url.searchParams.get('prescriptionId') ?? '';

      if (!prescriptionId) {
        sendError(res, 400, 'Missing prescriptionId query parameter');
        return;
      }

      const job = fillJobs.get(prescriptionId);

      if (!job) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ status: 'not_started' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });

      // Clear completed/errored jobs so re-fill is possible
      if (job.status === 'complete' || job.status === 'error') {
        fillJobs.delete(prescriptionId);
      }

      res.end(safeJsonStringify(job, 'fill-status'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/update-rx-status
  server.registerRoute('POST', '/interactive/update-rx-status', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.prescriptionId !== 'string' ||
          typeof params.newStatus !== 'string' ||
          typeof params.role !== 'string' ||
          typeof params.actorIndex !== 'number') {
        sendError(res, 400, 'Missing required fields: prescriptionId, newStatus, role, actorIndex');
        return;
      }

      if (!['CANCELLED', 'REJECTED', 'COMPLETED', 'DISPENSED'].includes(params.newStatus)) {
        sendError(res, 400, 'newStatus must be CANCELLED, REJECTED, COMPLETED, or DISPENSED');
        return;
      }

      if (!['prescriber', 'pharmacy'].includes(params.role)) {
        sendError(res, 400, 'role must be prescriber or pharmacy');
        return;
      }

      const result = service.updateRxStatus({
        prescriptionId: params.prescriptionId,
        newStatus: params.newStatus,
        role: params.role,
        actorIndex: params.actorIndex,
        note: params.note,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/reverse
  server.registerRoute('POST', '/interactive/reverse', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.prescriptionId !== 'string') {
        sendError(res, 400, 'Missing required field: prescriptionId');
        return;
      }

      const result = await service.getL2Node().withProvingLock(() => service.reversePrescription({
        prescriptionId: params.prescriptionId,
        fillIndex: params.fillIndex,
        reason: params.reason,
      }));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/assign-pcp
  server.registerRoute('POST', '/interactive/assign-pcp', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.memberWalletId !== 'string' || typeof params.prescriberIndex !== 'number') {
        sendError(res, 400, 'Missing required fields: memberWalletId, prescriberIndex');
        return;
      }

      const result = await service.getL2Node().withProvingLock(() => service.assignPcp({
        memberWalletId: params.memberWalletId,
        prescriberIndex: params.prescriberIndex,
      }));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /interactive/member-history
  server.registerRoute('GET', '/interactive/member-history', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const walletId = url.searchParams.get('walletId');

      if (!walletId) {
        sendError(res, 400, 'Missing required query parameter: walletId');
        return;
      }

      const result = service.getMemberHistory({ memberWalletId: walletId });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/enroll-family
  server.registerRoute('POST', '/interactive/enroll-family', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);
      const subscriberIndex = params.subscriberIndex;

      if (typeof subscriberIndex !== 'number') {
        sendError(res, 400, 'Missing or invalid subscriberIndex');
        return;
      }

      const result = await service.getL2Node().withProvingLock(() => service.enrollFamily(subscriberIndex));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /interactive/family-history
  server.registerRoute('GET', '/interactive/family-history', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const walletId = url.searchParams.get('walletId');

      if (!walletId) {
        sendError(res, 400, 'Missing required query parameter: walletId');
        return;
      }

      const result = service.getFamilyHistory({ memberWalletId: walletId });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/terminate-member
  server.registerRoute('POST', '/interactive/terminate-member', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.memberWalletId !== 'string') {
        sendError(res, 400, 'Missing required field: memberWalletId');
        return;
      }

      const result = service.terminateMember({
        memberWalletId: params.memberWalletId,
        terminationDate: params.terminationDate,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/terminate-group
  server.registerRoute('POST', '/interactive/terminate-group', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.groupId !== 'string') {
        sendError(res, 400, 'Missing required field: groupId');
        return;
      }

      const result = service.terminateGroup({
        groupId: params.groupId,
        terminationDate: params.terminationDate,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/send-message
  server.registerRoute('POST', '/interactive/send-message', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (!params.senderType || !params.recipientType || !params.subject || !params.body) {
        sendError(res, 400, 'Missing required fields: senderType, recipientType, subject, body');
        return;
      }

      const result = await service.getL2Node().withProvingLock(() => service.sendMessage(params));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/decrypt-thread — batch decrypt messages in a thread
  server.registerRoute('POST', '/interactive/decrypt-thread', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (!Array.isArray(params.messageIndices) || !params.walletId) {
        sendError(res, 400, 'Missing required fields: messageIndices (array), walletId');
        return;
      }

      const result = service.decryptThread(params.messageIndices, params.walletId);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /interactive/threads — get conversation threads for a wallet
  server.registerRoute('GET', '/interactive/threads', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
      const walletId = url.searchParams.get('walletId');

      if (!walletId) {
        sendError(res, 400, 'Missing required query parameter: walletId');
        return;
      }

      const result = service.getThreads(walletId);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/create-delegation
  server.registerRoute('POST', '/interactive/create-delegation', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (!params.delegatorWalletId || !params.delegateWalletId ||
          typeof params.scopeFlags !== 'number' || typeof params.relationshipCode !== 'number') {
        sendError(res, 400, 'Missing required fields: delegatorWalletId, delegateWalletId, scopeFlags, relationshipCode');
        return;
      }

      const result = await service.getL2Node().withProvingLock(() => service.createDelegation(params));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // ─── Async Credential Generation ──────────────────────────
  // Credential generation runs ZK proofs (ProofGate + CredentialProgram) which can take 30-60s.
  // Same fire-and-forget + poll pattern as enrollment.
  const credentialJobs = new Map<string, { status: 'pending' | 'complete' | 'error'; result?: unknown; error?: string }>();

  // POST /interactive/generate-credential — kicks off, returns immediately
  server.registerRoute('POST', '/interactive/generate-credential', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);
      if (!params.walletId) {
        sendError(res, 400, 'Missing required field: walletId');
        return;
      }

      const proofType = params.proofType || 'holding';
      const jobKey = `${params.walletId}:${proofType}`;

      // If already running or complete, return current status
      const existing = credentialJobs.get(jobKey);
      if (existing) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(safeJsonStringify(existing, 'generate-credential'));
        return;
      }

      // Mark as pending and kick off in background
      credentialJobs.set(jobKey, { status: 'pending' });

      service.getL2Node().withProvingLock(() => service.generateCredential(params.walletId, proofType))
        .then((result) => {
          credentialJobs.set(jobKey, { status: 'complete', result });
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          credentialJobs.set(jobKey, { status: 'error', error: message });
        });

      res.writeHead(202, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({ status: 'pending', walletId: params.walletId, proofType }, 'generate-credential'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /interactive/credential-status?walletId=X&proofType=Y — poll for credential result
  server.registerRoute('GET', '/interactive/credential-status', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const walletId = url.searchParams.get('walletId') ?? '';
      const proofType = url.searchParams.get('proofType') ?? 'holding';

      if (!walletId) {
        sendError(res, 400, 'Missing walletId query parameter');
        return;
      }

      const jobKey = `${walletId}:${proofType}`;
      const job = credentialJobs.get(jobKey);

      if (!job) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ status: 'not_started' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });

      // Clear completed/errored jobs so regeneration is possible
      if (job.status === 'complete' || job.status === 'error') {
        credentialJobs.delete(jobKey);
      }

      res.end(safeJsonStringify(job, 'credential-status'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/verify-credential
  server.registerRoute('POST', '/interactive/verify-credential', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);
      if (!params.credentialJson) {
        sendError(res, 400, 'Missing required field: credentialJson');
        return;
      }
      const result = await service.getL2Node().withProvingLock(() => service.verifyCredential(params.credentialJson));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/update-formulary
  server.registerRoute('POST', '/interactive/update-formulary', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.medicationIndex !== 'number' ||
          !['MODIFY', 'REMOVE', 'ADD'].includes(params.action)) {
        sendError(res, 400, 'Missing required fields: medicationIndex, action (MODIFY|REMOVE|ADD)');
        return;
      }

      const result = await service.getL2Node().withProvingLock(() => service.updateFormularyEntry(params));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/update-provider-network
  server.registerRoute('POST', '/interactive/update-provider-network', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.prescriberWalletId !== 'string' ||
          !['ADD', 'REMOVE'].includes(params.action)) {
        sendError(res, 400, 'Missing required fields: prescriberWalletId, action (ADD|REMOVE)');
        return;
      }

      const result = await service.getL2Node().withProvingLock(() => service.updateProviderNetwork(params));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/plan-year-rollover
  server.registerRoute('POST', '/interactive/plan-year-rollover', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.newPlanYear !== 'string') {
        sendError(res, 400, 'Missing required field: newPlanYear');
        return;
      }

      const result = await service.getL2Node().withProvingLock(() => service.planYearRollover(params));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /interactive/step-therapy-check
  server.registerRoute('GET', '/interactive/step-therapy-check', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const walletId = url.searchParams.get('memberWalletId');
      const medIdx = url.searchParams.get('medicationIndex');

      if (!walletId || !medIdx) {
        sendError(res, 400, 'Missing query params: memberWalletId, medicationIndex');
        return;
      }

      const result = service.checkStepTherapy(walletId, parseInt(medIdx, 10));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // ─── L2 Chain Routes ──────────────────────────────────────

  // GET /interactive/l2-status
  server.registerRoute('GET', '/interactive/l2-status', async (_req: IncomingMessage, res: ServerResponse) => {
    const rawStatus = service.getL2Node().getStatus();
    const seq = service.getL2Node().getSequencer();
    // Sanitize bigints for JSON serialization
    const status = {
      ...rawStatus,
      inFlightBatch: rawStatus.inFlightBatch !== null ? Number(rawStatus.inFlightBatch) : null,
    };
    const receipts = seq.getAllReceipts().map(r => ({
      ...r,
      sequenceNumber: Number(r.sequenceNumber),
      l2BlockNumber: r.l2BlockNumber !== undefined ? Number(r.l2BlockNumber) : undefined,
      l1BatchNumber: r.l1BatchNumber !== undefined ? Number(r.l1BatchNumber) : undefined,
      claimLeafIndex: r.claimLeafIndex !== undefined ? Number(r.claimLeafIndex) : undefined,
    }));
    const batches = seq.getAllBatches().map(b => ({
      ...b,
      batchNumber: Number(b.batchNumber),
      blockNumbers: b.blockNumbers.map(Number),
      blockHeight: b.blockHeight !== undefined ? Number(b.blockHeight) : undefined,
    }));
    const auditLog = seq.getAuditLog();
    const sanitizedEvents = auditLog.events.map(e => ({
      ...e,
      sequenceNumber: Number(e.sequenceNumber),
      l2BlockNumber: e.l2BlockNumber !== undefined ? Number(e.l2BlockNumber) : undefined,
      l1BatchNumber: e.l1BatchNumber !== undefined ? Number(e.l1BatchNumber) : undefined,
    }));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(safeJsonStringify({
      status,
      receipts,
      batches,
      auditLog: { ...auditLog, events: sanitizedEvents, eventCount: Number(auditLog.eventCount) },
    }, 'l2-status'));
  });

  // POST /interactive/force-batch
  server.registerRoute('POST', '/interactive/force-batch', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const batch = await service.forceBatch();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({
        ok: true,
        batch: batch ? { batchNumber: Number((batch as any).batchNumber), transitionCount: (batch as any).transitionCount } : null,
        message: batch ? 'Batch built and settled' : 'No pending proofs to batch',
      }, 'force-batch'));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  });

  // POST /interactive/save-checkpoint
  server.registerRoute('POST', '/interactive/save-checkpoint', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const filename = await service.saveCheckpoint();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({ ok: true, filename, message: filename ? `Checkpoint saved: ${filename}` : 'No checkpoint store configured' }, 'save-checkpoint'));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  });

  // POST /interactive/retry-batch
  server.registerRoute('POST', '/interactive/retry-batch', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const seq = service.getL2Node().getSequencer();
      // Auto-detect latest failed batch if no body provided
      let batchNumber: bigint;
      const rawBody = await readBody(req);
      if (rawBody.trim()) {
        const body = JSON.parse(rawBody);
        batchNumber = BigInt(body.batchNumber);
      } else {
        const failedBatch = seq.getAllBatches().find(b => b.l1Status === 'failed');
        if (!failedBatch) throw new Error('No failed batches to retry');
        batchNumber = failedBatch.batchNumber;
      }
      const batch = seq.retryBatch(batchNumber);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({ ok: true, batchNumber: Number(batch.batchNumber), l1Status: batch.l1Status, message: `Batch ${batch.batchNumber} retried` }, 'retry-batch'));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  });

  // POST /interactive/simulate-batch-failure
  server.registerRoute('POST', '/interactive/simulate-batch-failure', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const seq = service.getL2Node().getSequencer();
      // Auto-detect latest settled batch if no body provided
      let batchNumber: bigint;
      const rawBody = await readBody(req);
      if (rawBody.trim()) {
        const body = JSON.parse(rawBody);
        batchNumber = BigInt(body.batchNumber);
      } else {
        const allBatches = seq.getAllBatches();
        const settledBatch = [...allBatches].reverse().find(b => b.l1Status === 'settled');
        if (!settledBatch) throw new Error('No settled batches to simulate failure on');
        batchNumber = settledBatch.batchNumber;
      }
      seq.markBatchFailed(batchNumber, 'Simulated L1 settlement failure');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({ ok: true, message: `Batch ${batchNumber} marked as failed` }, 'simulate-failure'));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  });

  // POST /interactive/reset
  server.registerRoute('POST', '/interactive/reset', async (_req: IncomingMessage, res: ServerResponse) => {
    service.reset();
    enrollmentJobs.clear();
    credentialJobs.clear();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(safeJsonStringify({ ok: true, message: 'Session reset. Ready for new enrollments.' }, 'reset'));
  });

  // ─── Entity Node Dashboard Routes ────────────────────────

  // GET /node/state — session state + demo data for entity dashboards
  server.registerRoute('GET', '/node/state', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const state = service.getState();
      // Import demo data dynamically
      const { DEMO_PRESCRIBERS } = await import('../../src/demo/prescribers.js');
      const { DEMO_PHARMACIES } = await import('../../src/demo/pharmacies.js');
      const { DEMO_MEDICATIONS } = await import('../../src/demo/medications.js');

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({
        ...state,
        prescribers: DEMO_PRESCRIBERS.map((p, i) => ({
          index: i,
          firstName: p.firstName,
          lastName: p.lastName,
          credential: p.credential,
          specialty: p.specialty,
          npi: p.localData.prescriberId,
          state: p.state,
        })),
        pharmacies: DEMO_PHARMACIES.map((p, i) => ({
          index: i,
          storeName: p.storeName,
          chain: p.chain,
          pharmacyType: p.pharmacyTypeDesc,
          npi: p.localData.serviceProviderId,
          ncpdpId: p.ncpdpProviderId,
          city: p.city,
          state: p.state,
        })),
        medications: DEMO_MEDICATIONS.map((m, i) => ({
          index: i,
          brandName: m.brandName,
          genericName: m.genericName,
          strength: m.strength,
          ndc: m.ndc,
          tier: m.formularyEntry.tierLevel,
        })),
      }, 'node-state'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/claims-by-member?walletId=X — claim history for a member
  server.registerRoute('GET', '/node/claims-by-member', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const walletId = url.searchParams.get('walletId');

      if (!walletId) {
        sendError(res, 400, 'Missing required query parameter: walletId');
        return;
      }

      const seq = service.getL2Node().getSequencer();
      const claims = seq.getClaimsByMember(walletId);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({ claims }, 'claims-by-member'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/claims-by-prescriber?walletId=X — claims by prescriber
  server.registerRoute('GET', '/node/claims-by-prescriber', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const walletId = url.searchParams.get('walletId');

      if (!walletId) {
        sendError(res, 400, 'Missing required query parameter: walletId');
        return;
      }

      const seq = service.getL2Node().getSequencer();
      const claims = seq.getClaimsByPrescriber(walletId);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({ claims }, 'claims-by-prescriber'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/claims-by-pharmacy?walletId=X — claims by pharmacy
  server.registerRoute('GET', '/node/claims-by-pharmacy', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const walletId = url.searchParams.get('walletId');

      if (!walletId) {
        sendError(res, 400, 'Missing required query parameter: walletId');
        return;
      }

      const seq = service.getL2Node().getSequencer();
      const claims = seq.getClaimsByPharmacy(walletId);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({ claims }, 'claims-by-pharmacy'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/claims-by-ndc?ndcHash=X — claims by drug
  server.registerRoute('GET', '/node/claims-by-ndc', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const ndcHash = url.searchParams.get('ndcHash');

      if (!ndcHash) {
        sendError(res, 400, 'Missing required query parameter: ndcHash');
        return;
      }

      const seq = service.getL2Node().getSequencer();
      const claims = seq.getClaimsByNdc(ndcHash);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({ claims }, 'claims-by-ndc'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/receipts-by-wallet?walletId=X — receipts for a wallet
  server.registerRoute('GET', '/node/receipts-by-wallet', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const walletId = url.searchParams.get('walletId');

      if (!walletId) {
        sendError(res, 400, 'Missing required query parameter: walletId');
        return;
      }

      const seq = service.getL2Node().getSequencer();
      const receipts = seq.getReceiptsByWallet(walletId);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({ receipts }, 'receipts-by-wallet'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/dur?memberWalletId=X — cross-pharmacy DUR for a patient
  server.registerRoute('GET', '/node/dur', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const memberWalletId = url.searchParams.get('memberWalletId');

      if (!memberWalletId) {
        sendError(res, 400, 'Missing required query parameter: memberWalletId');
        return;
      }

      const seq = service.getL2Node().getSequencer();
      // DUR is essentially the member's claim history across all pharmacies
      const claims = seq.getClaimsByMember(memberWalletId);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({
        memberWalletId,
        claims,
        claimCount: claims.length,
      }, 'dur'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/claim-proof?leafIndex=N — claim + Merkle proof
  server.registerRoute('GET', '/node/claim-proof', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const leafIndexStr = url.searchParams.get('leafIndex');

      if (!leafIndexStr) {
        sendError(res, 400, 'Missing required query parameter: leafIndex');
        return;
      }

      const leafIndex = BigInt(leafIndexStr);
      const seq = service.getL2Node().getSequencer();
      const result = seq.getClaimWithProof(leafIndex);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(result, 'claim-proof'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/formulary?planIdHash=X — formulary data for a plan
  server.registerRoute('GET', '/node/formulary', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const planIdHash = url.searchParams.get('planIdHash');

      if (!planIdHash) {
        sendError(res, 400, 'Missing required query parameter: planIdHash');
        return;
      }

      const seq = service.getL2Node().getSequencer();
      const formulary = seq.getFormulary(planIdHash);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(formulary, 'formulary'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/all-receipts — all receipts (insurer view)
  server.registerRoute('GET', '/node/all-receipts', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const seq = service.getL2Node().getSequencer();
      const receipts = seq.getAllReceipts();

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({ receipts }, 'all-receipts'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/all-batches — all batches (insurer view)
  server.registerRoute('GET', '/node/all-batches', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const seq = service.getL2Node().getSequencer();
      const batches = seq.getAllBatches();

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({ batches }, 'all-batches'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/audit-log — audit log (insurer view)
  server.registerRoute('GET', '/node/audit-log', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const seq = service.getL2Node().getSequencer();
      const auditLog = seq.getAuditLog();
      const sanitized = {
        ...auditLog,
        eventCount: Number(auditLog.eventCount),
        events: auditLog.events.map(e => ({
          ...e,
          sequenceNumber: Number(e.sequenceNumber),
          l2BlockNumber: e.l2BlockNumber !== undefined ? Number(e.l2BlockNumber) : undefined,
          l1BatchNumber: e.l1BatchNumber !== undefined ? Number(e.l1BatchNumber) : undefined,
        })),
      };

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(sanitized, 'audit-log'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/chain-proof — latest chain proof
  server.registerRoute('GET', '/node/chain-proof', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const seq = service.getL2Node().getSequencer();
      const chainProofJson = seq.getLatestChainProofJson();
      const globalStateRoot = seq.getCurrentGlobalStateRoot().toString();
      const blockHeight = Number(seq.getCurrentBlockHeight().toBigInt());

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({
        chainProofJson,
        globalStateRoot,
        blockHeight,
        available: chainProofJson !== null,
      }, 'chain-proof'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/chain-state — chain state (roots, counts)
  server.registerRoute('GET', '/node/chain-state', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const seq = service.getL2Node().getSequencer();
      const chainState = {
        currentRegistryRoot: seq.getCurrentRegistryRoot().toString(),
        currentLifecycleRoot: seq.getCurrentLifecycleRoot().toString(),
        currentWalletCount: Number(seq.getCurrentWalletCount().toBigInt()),
        lastSettledRegistryRoot: seq.getLastSettledRegistryRoot().toString(),
        lastSettledLifecycleRoot: seq.getLastSettledLifecycleRoot().toString(),
        lastSettledWalletCount: Number(seq.getLastSettledWalletCount().toBigInt()),
        globalStateRoot: seq.getCurrentGlobalStateRoot().toString(),
        blockHeight: Number(seq.getCurrentBlockHeight().toBigInt()),
        chainProofEnabled: seq.isChainProofEnabled(),
        latestBatchNumber: seq.getLatestBatchNumber() !== null ? Number(seq.getLatestBatchNumber()) : null,
        latestSequenceNumber: Number(seq.getLatestSequenceNumber()),
        claimAccumulatorRoot: seq.getClaimAccumulatorRoot(),
        claimLeafCount: Number(seq.getClaimLeafCount()),
      };

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify(chainState, 'chain-state'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /node/force-batch — force batch settlement
  server.registerRoute('POST', '/node/force-batch', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const batch = await service.forceBatch();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({
        ok: true,
        batch: batch ? { batchNumber: Number((batch as any).batchNumber), transitionCount: (batch as any).transitionCount } : null,
        message: batch ? 'Batch built and settled' : 'No pending proofs to batch',
      }, 'node-force-batch'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /node/publish-formulary — publish formulary for a plan
  server.registerRoute('POST', '/node/publish-formulary', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.planIdHash !== 'string' ||
          typeof params.formularyRoot !== 'string' ||
          typeof params.entriesJson !== 'string') {
        sendError(res, 400, 'Missing required fields: planIdHash, formularyRoot, entriesJson');
        return;
      }

      const seq = service.getL2Node().getSequencer();
      // Store formulary in sequencer's registry
      seq.getFormulary(params.planIdHash); // This will create it if it doesn't exist

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(safeJsonStringify({
        ok: true,
        message: `Formulary published for plan ${params.planIdHash}`,
      }, 'publish-formulary'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // Return the emitter so the startup script can wire it to the service
  (server as any).__interactiveConsoleEmitter = consoleEmitter;
  (server as any).__interactiveConsoleSseClients = consoleSseClients;
}

/**
 * Get the console emitter that was installed by registerInteractiveRoutes.
 * This allows the startup script to wire it before creating the service.
 */
export function getConsoleEmitter(server: L2RpcServer): (event: ConsoleEvent) => void {
  return (server as any).__interactiveConsoleEmitter;
}

// ─── Helpers ────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ error: message }));
}

/**
 * BigInt-safe JSON serializer — safety net for missed BigInt conversions.
 *
 * JSON.stringify() throws "Do not know how to serialize a BigInt" when it
 * encounters BigInt values (common in o1js Field.toBigInt() and L2 types).
 * Callers should convert BigInts explicitly before reaching this function.
 * Any BigInt that leaks through is logged as a warning so we can fix the source.
 */
function safeJsonStringify(data: unknown, _context?: string): string {
  return JSON.stringify(data, (_key: string, value: unknown): unknown => {
    if (typeof value === 'bigint') {
      return Number(value);
    }
    return value;
  });
}
