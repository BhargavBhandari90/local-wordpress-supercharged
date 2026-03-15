/**
 * ngrok.process.ts -- Manages ngrok CLI child processes.
 *
 * Tracks running processes in a module-level Map keyed by siteId.
 * Uses child_process.spawn (not Local's Process class) because ngrok
 * is a standalone CLI tool that should not auto-restart.
 */

import * as path from 'path';
import * as http from 'http';
import { spawn, execFileSync, ChildProcess } from 'child_process';

const processes = new Map<string, ChildProcess>();

const isWindows = process.platform === 'win32';

/**
 * Resolves the full path to the ngrok binary. Electron doesn't inherit the
 * user's shell PATH, so a bare `ngrok` would fail with ENOENT. We shell out
 * to the platform's shell once, cache the result, and use the absolute path
 * for all subsequent spawns.
 *
 * - macOS/Linux: runs `$SHELL -l -c 'which ngrok'`, falls back to common paths
 * - Windows: runs `where ngrok` via cmd.exe, falls back to %LOCALAPPDATA%\ngrok
 */
let resolvedNgrokPath: string | null = null;

export function resolveNgrokBin(): string {
	if (resolvedNgrokPath) {
		return resolvedNgrokPath;
	}

	if (isWindows) {
		resolvedNgrokPath = resolveNgrokWindows();
	} else {
		resolvedNgrokPath = resolveNgrokUnix();
	}

	return resolvedNgrokPath;
}

function resolveNgrokUnix(): string {
	const shell = process.env.SHELL || '/bin/sh';

	try {
		return execFileSync(shell, ['-l', '-c', 'which ngrok'], {
			encoding: 'utf8',
			timeout: 5000,
		}).trim();
	} catch {
		// fall through
	}

	const candidates = [
		'/opt/homebrew/bin/ngrok',
		'/usr/local/bin/ngrok',
		'/snap/bin/ngrok',
	];

	for (const candidate of candidates) {
		try {
			execFileSync(candidate, ['version'], { encoding: 'utf8', timeout: 3000 });
			return candidate;
		} catch {
			// try next
		}
	}

	return 'ngrok';
}

function resolveNgrokWindows(): string {
	const comspec = process.env.ComSpec || 'cmd.exe';

	try {
		const result = execFileSync(comspec, ['/c', 'where', 'ngrok'], {
			encoding: 'utf8',
			timeout: 5000,
		}).trim();
		// `where` can return multiple lines; take the first
		return result.split(/\r?\n/)[0];
	} catch {
		// fall through
	}

	const candidates: string[] = [];

	if (process.env.LOCALAPPDATA) {
		candidates.push(path.join(process.env.LOCALAPPDATA, 'ngrok', 'ngrok.exe'));
	}
	if (process.env.ChocolateyInstall) {
		candidates.push(path.join(process.env.ChocolateyInstall, 'bin', 'ngrok.exe'));
	}
	if (process.env.USERPROFILE) {
		candidates.push(path.join(process.env.USERPROFILE, 'scoop', 'shims', 'ngrok.exe'));
	}

	for (const candidate of candidates) {
		try {
			execFileSync(candidate, ['version'], { encoding: 'utf8', timeout: 3000 });
			return candidate;
		} catch {
			// try next
		}
	}

	return 'ngrok.exe';
}

/**
 * Strips protocol and trailing slash from a URL to extract the bare domain.
 * e.g. "https://foo.ngrok-free.dev/" -> "foo.ngrok-free.dev"
 */
export function extractDomain(url: string): string {
	return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

const NGROK_API_BASE = 'http://127.0.0.1:4040';

export interface NgrokTunnel {
	name: string;
	public_url: string;
	config?: { addr?: string };
	[key: string]: any;
}

/**
 * Queries the ngrok agent API for active tunnels.
 * Returns an empty array if the agent is not running (connection refused).
 */
export function fetchNgrokTunnels(): Promise<NgrokTunnel[]> {
	return new Promise((resolve) => {
		const req = http.get(`${NGROK_API_BASE}/api/tunnels`, { timeout: 3000 }, (res) => {
			let body = '';
			res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
			res.on('end', () => {
				try {
					const parsed = JSON.parse(body);
					resolve(Array.isArray(parsed.tunnels) ? parsed.tunnels : []);
				} catch {
					resolve([]);
				}
			});
		});
		req.on('error', () => resolve([]));
		req.on('timeout', () => { req.destroy(); resolve([]); });
	});
}

/**
 * Finds a tunnel by its public domain in the ngrok agent API.
 * Returns the tunnel object if found, undefined otherwise.
 */
export async function findTunnelByDomain(ngrokUrl: string): Promise<NgrokTunnel | undefined> {
	const domain = extractDomain(ngrokUrl);
	const tunnels = await fetchNgrokTunnels();

	return tunnels.find((t) => extractDomain(t.public_url || '') === domain);
}

/**
 * Normalizes a backend address for comparison.
 * The ngrok API returns config.addr as "http://host:port" or "host:port".
 * We strip the protocol to get a bare "host:port" string.
 */
export function normalizeAddr(addr: string): string {
	return addr.replace(/^https?:\/\//, '');
}

/**
 * Deletes a tunnel by name via the ngrok agent API.
 * Resolves on success or if the tunnel doesn't exist. Rejects on error.
 */
export function deleteTunnel(tunnelName: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const url = new URL(`${NGROK_API_BASE}/api/tunnels/${encodeURIComponent(tunnelName)}`);
		const req = http.request({
			hostname: url.hostname,
			port: url.port,
			path: url.pathname,
			method: 'DELETE',
			timeout: 5000,
		}, (res) => {
			// 204 = deleted, 404 = already gone -- both fine
			if (res.statusCode === 204 || res.statusCode === 404) {
				resolve();
			} else {
				reject(new Error(`Failed to delete tunnel: HTTP ${res.statusCode}`));
			}
			res.resume();
		});
		req.on('error', (err) => reject(err));
		req.on('timeout', () => { req.destroy(); reject(new Error('Timeout deleting tunnel')); });
		req.end();
	});
}

/**
 * Spawns `ngrok http --domain=<domain> <siteDomain>:<httpPort>`.
 * Stores the ChildProcess in the Map. Calls onExit when the process exits.
 *
 * Before spawning, checks the ngrok agent API:
 * - If a tunnel with the same domain AND same backend target exists,
 *   skips spawning and returns 'already-running'.
 * - If a tunnel with the same domain but a different backend exists
 *   (e.g. left over from another site), deletes it first via the API.
 *
 * stderr is captured so that error messages can be surfaced to the user.
 *
 * If a process is already running for this siteId, it is killed first.
 */
export async function startNgrokProcess(
	siteId: string,
	ngrokUrl: string,
	siteDomain: string,
	httpPort: number,
	onExit: (siteId: string, error?: string) => void,
): Promise<'started' | 'already-running'> {
	const target = `${siteDomain}:${httpPort}`;
	const existing = await findTunnelByDomain(ngrokUrl);

	if (existing) {
		const existingAddr = normalizeAddr(existing.config?.addr || '');
		if (existingAddr === target) {
			return 'already-running';
		}

		// Tunnel exists but points to a different backend -- tear it down
		await deleteTunnel(existing.name);
	}

	if (processes.has(siteId)) {
		stopNgrokProcess(siteId);
	}

	const domain = extractDomain(ngrokUrl);

	const ngrokBin = resolveNgrokBin();
	const child = spawn(ngrokBin, ['http', `--domain=${domain}`, target], {
		stdio: ['ignore', 'ignore', 'pipe'],
		detached: false,
	});

	processes.set(siteId, child);

	let stderrData = '';

	if (child.stderr) {
		child.stderr.on('data', (chunk: Buffer) => {
			stderrData += chunk.toString();
		});
	}

	let exited = false;
	const cleanup = (codeOrError?: number | NodeJS.ErrnoException | null) => {
		if (exited) {
			return;
		}
		exited = true;
		processes.delete(siteId);

		let errorMsg: string | undefined;
		if (codeOrError instanceof Error) {
			errorMsg = (codeOrError as NodeJS.ErrnoException).code === 'ENOENT'
				? 'ngrok not found -- is it installed and on your PATH?'
				: codeOrError.message;
		} else if (codeOrError != null && codeOrError !== 0) {
			errorMsg = stderrData.trim() || `ngrok exited with code ${codeOrError}`;
		}

		onExit(siteId, errorMsg);
	};

	child.on('exit', (code) => cleanup(code));
	child.on('error', (err) => cleanup(err));

	return 'started';
}

/**
 * Kills the ngrok process for a site (SIGTERM). No-op if not running.
 */
export function stopNgrokProcess(siteId: string): void {
	const child = processes.get(siteId);

	if (child) {
		processes.delete(siteId);
		child.removeAllListeners();
		if (child.stderr) {
			child.stderr.removeAllListeners();
		}
		child.kill('SIGTERM');
	}
}

/**
 * Returns whether an ngrok process is tracked in our Map for the given site.
 */
export function isNgrokProcessRunning(siteId: string): boolean {
	return processes.has(siteId);
}

/**
 * Checks whether a tunnel for the given ngrok URL is active, using
 * both the in-memory Map and the ngrok agent API.
 *
 * When target is provided, the API check also verifies that the tunnel's
 * backend address matches (so a tunnel pointing to a different site is
 * not reported as "running" for this site).
 */
export async function getNgrokProcessStatus(
	siteId: string,
	ngrokUrl?: string,
	target?: string,
): Promise<'running' | 'stopped'> {
	if (processes.has(siteId)) {
		return 'running';
	}

	if (ngrokUrl) {
		const tunnel = await findTunnelByDomain(ngrokUrl);
		if (tunnel) {
			if (!target) {
				return 'running';
			}
			const tunnelAddr = normalizeAddr(tunnel.config?.addr || '');
			if (tunnelAddr === target) {
				return 'running';
			}
		}
	}

	return 'stopped';
}
