import 'jest-extended';

import * as LocalMain from '@getflywheel/local/main';
import { registerNgrokIpc, NgrokIpcDeps } from './ngrok.ipc';
import { IPC_CHANNELS } from '../../shared/types';
import { createMockSite, createMockWpCli, createMockSiteData, createMockLogger } from '../../test/mockCreators';

describe('registerNgrokIpc', () => {
	let wpCli: ReturnType<typeof createMockWpCli>;
	let siteData: ReturnType<typeof createMockSiteData>;
	let logger: ReturnType<typeof createMockLogger>;
	let deps: NgrokIpcDeps;
	let handlers: Record<string, Function>;

	beforeEach(() => {
		jest.clearAllMocks();

		wpCli = createMockWpCli();
		siteData = createMockSiteData();
		logger = createMockLogger();
		deps = { wpCli: wpCli as any, siteData: siteData as any, logger };

		handlers = {};
		(LocalMain.addIpcAsyncListener as jest.Mock).mockImplementation(
			(channel: string, handler: Function) => { handlers[channel] = handler; },
		);

		registerNgrokIpc(deps);
	});

	it('registers 4 IPC listeners', () => {
		expect(LocalMain.addIpcAsyncListener).toHaveBeenCalledTimes(4);
	});

	describe('GET_NGROK', () => {
		it('returns cached state', async () => {
			siteData.getSite.mockReturnValue(createMockSite({
				id: 's1',
				superchargedAddon: { ngrok: { enabled: true, url: 'x1' } },
			}));

			const result = await handlers[IPC_CHANNELS.GET_NGROK]('s1');
			expect(result).toEqual({ enabled: true, url: 'x1' });
		});

		it('returns defaults when no cache', async () => {
			siteData.getSite.mockReturnValue(createMockSite({ id: 's1' }));

			const result = await handlers[IPC_CHANNELS.GET_NGROK]('s1');
			expect(result).toEqual({ enabled: false, url: '' });
		});
	});

	describe('APPLY_NGROK', () => {
		it('writes URL to cache without touching wp-config.php', async () => {
			siteData.getSite.mockReturnValue(createMockSite({ id: 's1' }));

			await handlers[IPC_CHANNELS.APPLY_NGROK]('s1', 'x1');

			expect(siteData.updateSite).toHaveBeenCalled();
			expect(siteData.updateSite.mock.calls[0][1].superchargedAddon.ngrok).toEqual({ enabled: false, url: 'x1' });
			expect(wpCli.run).not.toHaveBeenCalled();
		});
	});

	describe('ENABLE_NGROK -- enabling', () => {
		beforeEach(() => {
			wpCli.run.mockResolvedValue(undefined);
			siteData.getSites.mockReturnValue({});
		});

		it('sets WP_HOME and WP_SITEURL', async () => {
			const site = createMockSite({ id: 's1' });
			siteData.getSite.mockReturnValue(site);

			await handlers[IPC_CHANNELS.ENABLE_NGROK]('s1', true, 'x1');

			const allArgs = wpCli.run.mock.calls.map((c: any[]) => c[1]);
			expect(allArgs).toContainEqual(['config', 'set', 'WP_HOME', 'x1', '--add', `--path=${site.path}`]);
			expect(allArgs).toContainEqual(['config', 'set', 'WP_SITEURL', 'x1', '--add', `--path=${site.path}`]);
		});

		it('writes enabled cache', async () => {
			siteData.getSite.mockReturnValue(createMockSite({ id: 's1' }));

			await handlers[IPC_CHANNELS.ENABLE_NGROK]('s1', true, 'x1');

			const args = siteData.updateSite.mock.calls[0][1];
			expect(args.superchargedAddon.ngrok).toEqual({ enabled: true, url: 'x1' });
		});
	});

	describe('ENABLE_NGROK -- disabling', () => {
		it('removes WP_HOME and WP_SITEURL, preserves URL in cache', async () => {
			const site = createMockSite({ id: 's1' });
			siteData.getSite.mockReturnValue(site);
			wpCli.run.mockResolvedValue(undefined);

			await handlers[IPC_CHANNELS.ENABLE_NGROK]('s1', false, 'x1');

			const allArgs = wpCli.run.mock.calls.map((c: any[]) => c[1]);
			expect(allArgs).toContainEqual(['config', 'delete', 'WP_HOME', `--path=${site.path}`]);
			expect(allArgs).toContainEqual(['config', 'delete', 'WP_SITEURL', `--path=${site.path}`]);

			const cacheArgs = siteData.updateSite.mock.calls[0][1];
			expect(cacheArgs.superchargedAddon.ngrok).toEqual({ enabled: false, url: 'x1' });
		});
	});

	describe('ENABLE_NGROK -- collision', () => {
		it('disables conflicting site and removes its constants', async () => {
			const conflict = createMockSite({
				id: 's1',
				superchargedAddon: { ngrok: { enabled: true, url: 'x1' } },
			});
			const current = createMockSite({ id: 's2' });

			siteData.getSite.mockImplementation((id: string) => id === 's1' ? conflict : current);
			siteData.getSites.mockReturnValue({ 's1': conflict, 's2': current });
			wpCli.run.mockResolvedValue(undefined);

			await handlers[IPC_CHANNELS.ENABLE_NGROK]('s2', true, 'x1');

			// 2 deletes for conflict + 2 sets for current = 4
			expect(wpCli.run).toHaveBeenCalledTimes(4);

			// Conflict cache: disabled, URL preserved
			const firstUpdate = siteData.updateSite.mock.calls[0];
			expect(firstUpdate[0]).toBe('s1');
			expect(firstUpdate[1].superchargedAddon.ngrok).toEqual({ enabled: false, url: 'x1' });

			// IPC event sent for conflict
			expect(LocalMain.sendIPCEvent).toHaveBeenCalledWith(IPC_CHANNELS.NGROK_CHANGED, 's1', false);
		});

		it('does not send events when no conflicts', async () => {
			siteData.getSite.mockReturnValue(createMockSite({ id: 's1' }));
			siteData.getSites.mockReturnValue({ 's1': createMockSite({ id: 's1' }) });
			wpCli.run.mockResolvedValue(undefined);

			await handlers[IPC_CHANNELS.ENABLE_NGROK]('s1', true, 'x1');

			expect(LocalMain.sendIPCEvent).not.toHaveBeenCalled();
		});
	});

	describe('CLEAR_NGROK', () => {
		it('removes constants if enabled, then clears cache', async () => {
			siteData.getSite.mockReturnValue(createMockSite({
				id: 's1',
				superchargedAddon: { ngrok: { enabled: true, url: 'x1' } },
			}));
			wpCli.run.mockResolvedValue(undefined);

			await handlers[IPC_CHANNELS.CLEAR_NGROK]('s1');

			expect(wpCli.run).toHaveBeenCalledTimes(2);
			const args = siteData.updateSite.mock.calls[0][1];
			expect(args.superchargedAddon).not.toHaveProperty('ngrok');
		});

		it('skips constant removal if not enabled', async () => {
			siteData.getSite.mockReturnValue(createMockSite({
				id: 's1',
				superchargedAddon: { ngrok: { enabled: false, url: 'x1' } },
			}));

			await handlers[IPC_CHANNELS.CLEAR_NGROK]('s1');

			expect(wpCli.run).not.toHaveBeenCalled();
			expect(siteData.updateSite).toHaveBeenCalled();
		});
	});
});
