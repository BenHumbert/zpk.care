/*
 * Copyright 2026 Ben Humbert
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * ProofDelegateClient + ProofDelegateServer — proof generation delegation.
 *
 * For slow devices (phones, low-power PCs) that can't generate ZK proofs
 * fast enough, the proof work can be delegated to a dedicated prover node.
 *
 * Security model:
 *   - The prover receives HASHED preimage Fields (Poseidon hash outputs),
 *     NOT raw PHI/PII. The enrollment key hash is irreversible.
 *   - The prover cannot learn the user's identity from the Fields.
 *   - The entity node can verify the returned proof locally (~5ms) before
 *     submitting to the sequencer.
 *
 * The server compiles ZkPrograms once at startup and generates proofs
 * on behalf of entity nodes via HTTP JSON-RPC.
 */
import http from 'http';
import { Field } from 'o1js';
import {
  StateTransitionProgram,
  type StateTransitionProof,
} from '../engine/state-transition.js';
import { WalletRegistryWitness } from '../wallets/wallet-state.js';
import { LifecycleWitness } from '../engine/lifecycle.js';
import { l2Stringify, l2Parse } from '../l2/l2-json.js';

// ─── Types ──────────────────────────────────────────────────

interface ProverStatus {
  available: boolean;
  compiled: boolean;
  queueDepth: number;
  avgProofTimeMs: number;
}

interface ProofRequest {
  method: 'proveRegistration' | 'proveWalletUpdate';
  params: {
    /** 6-element array of Field decimal strings: [domainTag, f0, f1, f2, f3, f4] */
    preimage: string[];
    registryWitnessJson: string;
    lifecycleWitnessJson: string;
    currentRegistryRoot: string;
    currentLifecycleRoot: string;
    // Additional fields for proveWalletUpdate:
    oldCredentialRoot?: string;
    oldNonce?: string;
    newCredentialRoot?: string;
    currentLifecycle?: string;
  };
}

interface ProofResponse {
  success: boolean;
  proofJson?: string;
  error?: string;
  proofTimeMs?: number;
}

// ─── ProofDelegateClient ─────────────────────────────────────

/**
 * Client for delegating proof generation to a remote prover.
 *
 * Entity nodes use this when local proof generation is too slow.
 * The prover receives only hashed Field values — no PHI leakage.
 */
export class ProofDelegateClient {
  private proverUrl: string;
  private timeoutMs: number;
  private apiKey?: string;

  constructor(proverUrl: string, timeoutMs?: number, apiKey?: string) {
    this.proverUrl = proverUrl;
    this.timeoutMs = timeoutMs ?? 120_000;
    this.apiKey = apiKey;
  }

  /** Check if the prover is available and compiled */
  async getProverStatus(): Promise<ProverStatus> {
    const body = await this.httpGet('/status');
    return l2Parse<ProverStatus>(body);
  }

  /** Request a registration proof from the prover */
  async requestRegistrationProof(
    preimage: Field[],
    registryWitness: WalletRegistryWitness,
    lifecycleWitness: LifecycleWitness,
    currentRegistryRoot: Field,
    currentLifecycleRoot: Field,
  ): Promise<{ proofJson: string; proofTimeMs: number }> {
    const req: ProofRequest = {
      method: 'proveRegistration',
      params: {
        preimage: preimage.map((f) => f.toString()),
        registryWitnessJson: JSON.stringify(registryWitness.toJSON()),
        lifecycleWitnessJson: JSON.stringify(lifecycleWitness.toJSON()),
        currentRegistryRoot: currentRegistryRoot.toString(),
        currentLifecycleRoot: currentLifecycleRoot.toString(),
      },
    };

    const res = await this.httpPost('/prove', l2Stringify(req));
    const result = l2Parse<ProofResponse>(res);

    if (!result.success || !result.proofJson) {
      throw new Error(`Prover error: ${result.error ?? 'unknown'}`);
    }

    return {
      proofJson: result.proofJson,
      proofTimeMs: result.proofTimeMs ?? 0,
    };
  }

  /** Request a wallet update proof from the prover */
  async requestWalletUpdateProof(
    preimage: Field[],
    oldCredentialRoot: Field,
    oldNonce: Field,
    newCredentialRoot: Field,
    registryWitness: WalletRegistryWitness,
    lifecycleWitness: LifecycleWitness,
    currentRegistryRoot: Field,
    currentLifecycleRoot: Field,
    currentLifecycle: Field,
  ): Promise<{ proofJson: string; proofTimeMs: number }> {
    const req: ProofRequest = {
      method: 'proveWalletUpdate',
      params: {
        preimage: preimage.map((f) => f.toString()),
        registryWitnessJson: JSON.stringify(registryWitness.toJSON()),
        lifecycleWitnessJson: JSON.stringify(lifecycleWitness.toJSON()),
        currentRegistryRoot: currentRegistryRoot.toString(),
        currentLifecycleRoot: currentLifecycleRoot.toString(),
        oldCredentialRoot: oldCredentialRoot.toString(),
        oldNonce: oldNonce.toString(),
        newCredentialRoot: newCredentialRoot.toString(),
        currentLifecycle: currentLifecycle.toString(),
      },
    };

    const res = await this.httpPost('/prove', l2Stringify(req));
    const result = l2Parse<ProofResponse>(res);

    if (!result.success || !result.proofJson) {
      throw new Error(`Prover error: ${result.error ?? 'unknown'}`);
    }

    return {
      proofJson: result.proofJson,
      proofTimeMs: result.proofTimeMs ?? 0,
    };
  }

  // ─── HTTP Transport ──────────────────────────────────────

  private httpGet(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.proverUrl);
      const req = http.get(url, { timeout: this.timeoutMs }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) resolve(data);
          else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  }

  private httpPost(path: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.proverUrl);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiKey) {
        headers['X-Api-Key'] = this.apiKey;
      }
      const req = http.request(
        url,
        {
          method: 'POST',
          headers,
          timeout: this.timeoutMs,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode === 200) resolve(data);
            else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(body);
      req.end();
    });
  }
}

// ─── ProofDelegateServer ─────────────────────────────────────

/**
 * Dedicated proof generation server.
 *
 * Compiles all ZkPrograms once at startup, then accepts proof requests
 * from entity nodes via HTTP. Runs on a powerful machine (server, GPU node).
 */
export class ProofDelegateServer {
  private compiled = false;
  private server: http.Server | null = null;
  private port: number;
  private apiKey?: string;
  private queueDepth = 0;
  private totalProofs = 0;
  private totalProofTimeMs = 0;

  constructor(options?: number | { port?: number; apiKey?: string }) {
    if (typeof options === 'number') {
      this.port = options;
    } else {
      this.port = options?.port ?? 4040;
      this.apiKey = options?.apiKey;
    }
  }

  /** Compile all required ZkPrograms (one-time, ~30-120s) */
  async compile(): Promise<void> {
    await StateTransitionProgram.compile();
    this.compiled = true;
  }

  /** Start accepting proof requests */
  async start(): Promise<void> {
    if (!this.compiled) {
      throw new Error('Must call compile() before start()');
    }

    this.server = http.createServer(async (req, res) => {
      try {
        if (req.method === 'GET' && req.url === '/status') {
          const status: ProverStatus = {
            available: true,
            compiled: this.compiled,
            queueDepth: this.queueDepth,
            avgProofTimeMs:
              this.totalProofs > 0
                ? Math.round(this.totalProofTimeMs / this.totalProofs)
                : 0,
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(l2Stringify(status));
          return;
        }

        if (req.method === 'POST' && req.url === '/prove') {
          // H13 fix: API key authentication for proof generation endpoint
          if (this.apiKey) {
            const clientKey = req.headers['x-api-key'];
            if (clientKey !== this.apiKey) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(l2Stringify({ success: false, error: 'Unauthorized: invalid or missing API key' }));
              return;
            }
          }
          const body = await readBody(req);
          const request = l2Parse<ProofRequest>(body);
          const result = await this.handleProofRequest(request);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(l2Stringify(result));
          return;
        }

        res.writeHead(404);
        res.end('Not Found');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(l2Stringify({ success: false, error: msg }));
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, '0.0.0.0', resolve);
    });
  }

  /** Shutdown the server */
  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }

  /** Get the port this server is listening on */
  getPort(): number {
    return this.port;
  }

  /** Check if the server is compiled and running */
  isRunning(): boolean {
    return this.server !== null && this.compiled;
  }

  // ─── Internal ─────────────────────────────────────────────

  private async handleProofRequest(request: ProofRequest): Promise<ProofResponse> {
    this.queueDepth++;
    const start = Date.now();

    try {
      const preimage = request.params.preimage.map((s) => Field(BigInt(s)));
      const registryWitness = WalletRegistryWitness.fromJSON(
        JSON.parse(request.params.registryWitnessJson),
      );
      const lifecycleWitness = LifecycleWitness.fromJSON(
        JSON.parse(request.params.lifecycleWitnessJson),
      );
      const currentRegistryRoot = Field(BigInt(request.params.currentRegistryRoot));
      const currentLifecycleRoot = Field(BigInt(request.params.currentLifecycleRoot));

      let proofJson: string;

      if (request.method === 'proveRegistration') {
        const result = await StateTransitionProgram.proveRegistration(
          preimage[0], preimage[1], preimage[2],
          preimage[3], preimage[4], preimage[5], preimage[6],
          registryWitness,
          lifecycleWitness,
          currentRegistryRoot,
          currentLifecycleRoot,
        );
        proofJson = JSON.stringify(result.proof.toJSON());
      } else if (request.method === 'proveWalletUpdate') {
        const oldCredentialRoot = Field(BigInt(request.params.oldCredentialRoot!));
        const oldNonce = Field(BigInt(request.params.oldNonce!));
        const newCredentialRoot = Field(BigInt(request.params.newCredentialRoot!));
        const currentLifecycle = Field(BigInt(request.params.currentLifecycle!));

        const result = await StateTransitionProgram.proveWalletUpdate(
          preimage[0], preimage[1], preimage[2],
          preimage[3], preimage[4], preimage[5], preimage[6],
          oldCredentialRoot, oldNonce, newCredentialRoot,
          registryWitness,
          lifecycleWitness,
          currentRegistryRoot, currentLifecycleRoot,
          currentLifecycle,
        );
        proofJson = JSON.stringify(result.proof.toJSON());
      } else {
        return { success: false, error: `Unknown method: ${request.method}` };
      }

      const elapsed = Date.now() - start;
      this.totalProofs++;
      this.totalProofTimeMs += elapsed;

      return { success: true, proofJson, proofTimeMs: elapsed };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    } finally {
      this.queueDepth--;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function readBody(req: http.IncomingMessage, maxBytes: number = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
