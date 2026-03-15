import { EventEmitter } from 'events';
import {
	extractDomain,
	normalizeAddr,
	startNgrokProcess,
	stopNgrokProcess,
	isNgrokProcessRunning,
	resolveNgrokBin,
	fetchNgrokTunnels,
	findTunnelByDomain,
	deleteTunnel,
	getNgrokProcessStatus,
} from './ngrok.process';

jest.mock('child_process', () => ({
	spawn: jest.fn(),
	execFileSync: jest.fn(() => '/opt/homebrew/bin/ngrok\n'),
}));

jest.mock('http', () => ({
	get: jest.fn(),
	request: jest.fn(),
}));

import { spawn } from 'child_process';
import * as http from 'http';

function createMockChild(): EventEmitter & { kill: jest.Mock; stderr: EventEmitter } {
	const emitter = new EventEmitter();
	(emitter as any).kill = jest.fn();
	(emitter as any).stderr = new EventEmitter();
	return emitter as any;
}

/**
 * Sets up http.get to return a mock response with the given JSON body.
 */
function mockHttpGetResponse(body: any): void {
	const res = new EventEmitter();
	(http.get as jest.Mock).mockImplementation((_url: string, _opts: any, cb: Function) => {
		cb(res);
		res.emit('data', Buffer.from(JSON.stringify(body)));
		res.emit('end');
		const req = new EventEmitter();
		return req;
	});
}

/**
 * Sets up http.get to emit an error (connection refused).
 */
function mockHttpGetError(): void {
	(http.get as jest.Mock).mockImplementation((_url: string, _opts: any, _cb: Function) => {
		const req = new EventEmitter();
		process.nextTick(() => req.emit('error', new Error('connect ECONNREFUSED')));
		return req;
	});
}

/**
 * Sets up http.request to return a response with the given status code.
 */
function mockHttpRequestResponse(statusCode: number): void {
	(http.request as jest.Mock).mockImplementation((_opts: any, cb: Function) => {
		const res = new EventEmitter() as any;
		res.statusCode = statusCode;
		res.resume = jest.fn();
		const req = new EventEmitter() as any;
		req.end = jest.fn(() => {
			process.nextTick(() => cb(res));
		});
		return req;
	});
}

describe('extractDomain', () => {
	it('strips https:// and trailing slash', () => {
		expect(extractDomain('https://foo.ngrok-free.dev/')).toBe('foo.ngrok-free.dev');
	});

	it('strips http://', () => {
		expect(extractDomain('http://bar.ngrok.io')).toBe('bar.ngrok.io');
	});

	it('handles bare domain', () => {
		expect(extractDomain('baz.ngrok-free.dev')).toBe('baz.ngrok-free.dev');
	});
});

describe('normalizeAddr', () => {
	it('strips http:// prefix', () => {
		expect(normalizeAddr('http://mysite.local:80')).toBe('mysite.local:80');
	});

	it('strips https:// prefix', () => {
		expect(normalizeAddr('https://mysite.local:443')).toBe('mysite.local:443');
	});

	it('passes through bare host:port', () => {
		expect(normalizeAddr('mysite.local:80')).toBe('mysite.local:80');
	});
});

describe('fetchNgrokTunnels', () => {
	it('returns tunnels from the API', async () => {
		mockHttpGetResponse({
			tunnels: [{ name: 't1', public_url: 'https://foo.ngrok-free.dev', config: { addr: 'http://localhost:80' } }],
		});

		const tunnels = await fetchNgrokTunnels();
		expect(tunnels).toHaveLength(1);
		expect(tunnels[0].public_url).toBe('https://foo.ngrok-free.dev');
	});

	it('returns empty array on connection error', async () => {
		mockHttpGetError();

		const tunnels = await fetchNgrokTunnels();
		expect(tunnels).toEqual([]);
	});

	it('returns empty array on invalid JSON', async () => {
		const res = new EventEmitter();
		(http.get as jest.Mock).mockImplementation((_url: string, _opts: any, cb: Function) => {
			cb(res);
			res.emit('data', Buffer.from('not json'));
			res.emit('end');
			const req = new EventEmitter();
			return req;
		});

		const tunnels = await fetchNgrokTunnels();
		expect(tunnels).toEqual([]);
	});
});

describe('findTunnelByDomain', () => {
	it('returns tunnel when domain matches', async () => {
		mockHttpGetResponse({
			tunnels: [
				{ name: 't1', public_url: 'https://foo.ngrok-free.dev', config: { addr: 'http://site1.local:80' } },
			],
		});

		const tunnel = await findTunnelByDomain('https://foo.ngrok-free.dev');
		expect(tunnel).toBeDefined();
		expect(tunnel!.name).toBe('t1');
	});

	it('returns undefined when no domain matches', async () => {
		mockHttpGetResponse({
			tunnels: [
				{ name: 't1', public_url: 'https://bar.ngrok-free.dev', config: { addr: 'http://site1.local:80' } },
			],
		});

		const tunnel = await findTunnelByDomain('https://foo.ngrok-free.dev');
		expect(tunnel).toBeUndefined();
	});
});

describe('deleteTunnel', () => {
	it('resolves on 204 response', async () => {
		mockHttpRequestResponse(204);
		await expect(deleteTunnel('my-tunnel')).resolves.toBeUndefined();
	});

	it('resolves on 404 response (already gone)', async () => {
		mockHttpRequestResponse(404);
		await expect(deleteTunnel('my-tunnel')).resolves.toBeUndefined();
	});

	it('rejects on other status codes', async () => {
		mockHttpRequestResponse(500);
		await expect(deleteTunnel('my-tunnel')).rejects.toThrow('HTTP 500');
	});
});

describe('startNgrokProcess', () => {
	let mockChild: ReturnType<typeof createMockChild>;

	beforeEach(() => {
		jest.clearAllMocks();
		mockChild = createMockChild();
		(spawn as jest.Mock).mockReturnValue(mockChild);
		mockHttpGetError(); // default: no agent running
	});

	afterEach(() => {
		stopNgrokProcess('s1');
		stopNgrokProcess('s2');
	});

	it('spawns ngrok with resolved path, correct args and piped stderr', async () => {
		const ngrokBin = resolveNgrokBin();
		await startNgrokProcess('s1', 'https://foo.ngrok-free.dev', 'mysite.local', 80, jest.fn());

		expect(spawn).toHaveBeenCalledWith(
			ngrokBin,
			['http', '--domain=foo.ngrok-free.dev', 'mysite.local:80'],
			{ stdio: ['ignore', 'ignore', 'pipe'], detached: false },
		);
	});

	it('returns started and marks process as running', async () => {
		const result = await startNgrokProcess('s1', 'https://foo.ngrok-free.dev', 'mysite.local', 80, jest.fn());
		expect(result).toBe('started');
		expect(isNgrokProcessRunning('s1')).toBe(true);
	});

	it('returns already-running when tunnel with same domain AND same target exists', async () => {
		mockHttpGetResponse({
			tunnels: [{
				name: 't1',
				public_url: 'https://foo.ngrok-free.dev',
				config: { addr: 'http://mysite.local:80' },
			}],
		});

		const result = await startNgrokProcess('s1', 'https://foo.ngrok-free.dev', 'mysite.local', 80, jest.fn());
		expect(result).toBe('already-running');
		expect(spawn).not.toHaveBeenCalled();
	});

	it('deletes stale tunnel and spawns new one when domain matches but target differs', async () => {
		// Tunnel pointing to site1, but we want site2
		mockHttpGetResponse({
			tunnels: [{
				name: 'old-tunnel',
				public_url: 'https://foo.ngrok-free.dev',
				config: { addr: 'http://site1.local:80' },
			}],
		});
		mockHttpRequestResponse(204); // DELETE succeeds

		const result = await startNgrokProcess(
			's2', 'https://foo.ngrok-free.dev', 'site2.local', 8080, jest.fn(),
		);

		expect(result).toBe('started');
		expect(http.request).toHaveBeenCalled();
		expect(spawn).toHaveBeenCalled();
	});

	it('calls onExit without error on clean exit (code 0)', async () => {
		const onExit = jest.fn();
		await startNgrokProcess('s1', 'https://foo.ngrok-free.dev', 'mysite.local', 80, onExit);

		mockChild.emit('exit', 0);

		expect(onExit).toHaveBeenCalledWith('s1', undefined);
		expect(isNgrokProcessRunning('s1')).toBe(false);
	});

	it('calls onExit with stderr on non-zero exit', async () => {
		const onExit = jest.fn();
		await startNgrokProcess('s1', 'https://foo.ngrok-free.dev', 'mysite.local', 80, onExit);

		mockChild.stderr.emit('data', Buffer.from('auth token invalid'));
		mockChild.emit('exit', 1);

		expect(onExit).toHaveBeenCalledWith('s1', 'auth token invalid');
		expect(isNgrokProcessRunning('s1')).toBe(false);
	});

	it('calls onExit with ENOENT message when ngrok is not found', async () => {
		const onExit = jest.fn();
		await startNgrokProcess('s1', 'https://foo.ngrok-free.dev', 'mysite.local', 80, onExit);

		const err = new Error('spawn ngrok ENOENT') as NodeJS.ErrnoException;
		err.code = 'ENOENT';
		mockChild.emit('error', err);

		expect(onExit).toHaveBeenCalledWith('s1', 'ngrok not found -- is it installed and on your PATH?');
	});

	it('only calls onExit once when both error and exit fire', async () => {
		const onExit = jest.fn();
		await startNgrokProcess('s1', 'https://foo.ngrok-free.dev', 'mysite.local', 80, onExit);

		const err = new Error('spawn ngrok ENOENT') as NodeJS.ErrnoException;
		err.code = 'ENOENT';
		mockChild.emit('error', err);
		mockChild.emit('exit', 1);

		expect(onExit).toHaveBeenCalledTimes(1);
	});

	it('kills existing process before starting new one', async () => {
		const child1 = createMockChild();
		const child2 = createMockChild();
		(spawn as jest.Mock).mockReturnValueOnce(child1).mockReturnValueOnce(child2);

		await startNgrokProcess('s1', 'https://a.ngrok-free.dev', 'a.local', 80, jest.fn());
		await startNgrokProcess('s1', 'https://b.ngrok-free.dev', 'b.local', 80, jest.fn());

		expect(child1.kill).toHaveBeenCalledWith('SIGTERM');
		expect(isNgrokProcessRunning('s1')).toBe(true);
	});
});

describe('stopNgrokProcess', () => {
	let mockChild: ReturnType<typeof createMockChild>;

	beforeEach(() => {
		jest.clearAllMocks();
		mockChild = createMockChild();
		(spawn as jest.Mock).mockReturnValue(mockChild);
		mockHttpGetError();
	});

	it('kills the process and removes from tracking', async () => {
		await startNgrokProcess('s1', 'https://foo.ngrok-free.dev', 'mysite.local', 80, jest.fn());

		stopNgrokProcess('s1');

		expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
		expect(isNgrokProcessRunning('s1')).toBe(false);
	});

	it('is a no-op when no process is running', () => {
		expect(() => stopNgrokProcess('nonexistent')).not.toThrow();
	});
});

describe('getNgrokProcessStatus', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		(spawn as jest.Mock).mockReturnValue(createMockChild());
		mockHttpGetError();
	});

	afterEach(() => {
		stopNgrokProcess('s1');
	});

	it('returns running when process is in the Map', async () => {
		await startNgrokProcess('s1', 'https://foo.ngrok-free.dev', 'mysite.local', 80, jest.fn());

		const status = await getNgrokProcessStatus('s1', 'https://foo.ngrok-free.dev');
		expect(status).toBe('running');
	});

	it('returns running when API tunnel matches domain and target', async () => {
		mockHttpGetResponse({
			tunnels: [{
				name: 't1',
				public_url: 'https://foo.ngrok-free.dev',
				config: { addr: 'http://mysite.local:80' },
			}],
		});

		const status = await getNgrokProcessStatus('s1', 'https://foo.ngrok-free.dev', 'mysite.local:80');
		expect(status).toBe('running');
	});

	it('returns stopped when API tunnel matches domain but has different target', async () => {
		mockHttpGetResponse({
			tunnels: [{
				name: 't1',
				public_url: 'https://foo.ngrok-free.dev',
				config: { addr: 'http://other-site.local:80' },
			}],
		});

		const status = await getNgrokProcessStatus('s1', 'https://foo.ngrok-free.dev', 'mysite.local:80');
		expect(status).toBe('stopped');
	});

	it('returns running when API tunnel matches domain and no target specified', async () => {
		mockHttpGetResponse({
			tunnels: [{
				name: 't1',
				public_url: 'https://foo.ngrok-free.dev',
				config: { addr: 'http://other-site.local:80' },
			}],
		});

		const status = await getNgrokProcessStatus('s1', 'https://foo.ngrok-free.dev');
		expect(status).toBe('running');
	});

	it('returns stopped when neither Map nor API has the tunnel', async () => {
		const status = await getNgrokProcessStatus('s1', 'https://foo.ngrok-free.dev', 'mysite.local:80');
		expect(status).toBe('stopped');
	});
});
