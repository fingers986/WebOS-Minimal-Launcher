// Minimal luna-service2 bridge for webOS web apps — no webOSTV.js dependency.
// webOS injects window.PalmServiceBridge into every web app; each call is a
// fresh bridge whose single response arrives on `onservicecallback`.

type Params = Record<string, unknown>;

interface PalmBridge {
	onservicecallback: ((msg: string) => void) | null;
	call (uri: string, params: string): void;
	cancel? (): void;
}
declare global {
	interface Window {
		PalmServiceBridge?: {new (): PalmBridge};
	}
}

export function isWebOS (): boolean {
	return typeof window !== 'undefined' && typeof window.PalmServiceBridge === 'function';
}

/** One-shot luna call. Resolves the parsed response, rejects on returnValue:false,
 *  bad JSON, a thrown bridge error, or timeout. */
export function lunaCall<T = unknown> (service: string, method: string, params: Params = {}, timeoutMs = 4000): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const Bridge = typeof window !== 'undefined' ? window.PalmServiceBridge : undefined;
		if (!Bridge) { reject(new Error('PalmServiceBridge unavailable (not on webOS)')); return; }

		const bridge = new Bridge();
		let done = false;
		let timer = 0;
		const finish = (fn: () => void) => {
			if (done) return;
			done = true;
			window.clearTimeout(timer);
			try { bridge.cancel?.(); } catch { /* noop */ }
			fn();
		};

		bridge.onservicecallback = (msg) => {
			let data: unknown;
			try { data = JSON.parse(msg); }
			catch (e) { finish(() => reject(e as Error)); return; }
			const rv = (data as {returnValue?: boolean}).returnValue;
			if (rv === false) {
				const err = (data as {errorText?: string}).errorText || `luna ${service}/${method} failed`;
				finish(() => reject(new Error(err)));
			} else {
				finish(() => resolve(data as T));
			}
		};

		try { bridge.call(`luna://${service}/${method}`, JSON.stringify(params)); }
		catch (e) { finish(() => reject(e as Error)); return; }

		timer = window.setTimeout(() => finish(() => reject(new Error(`luna ${service}/${method} timeout`))), timeoutMs);
	});
}

/** Launch (or switch input to) an app by webOS appId. */
export function launchApp (id: string, params: Params = {}): Promise<unknown> {
	return lunaCall('com.webos.applicationManager', 'launch', {id, params});
}

/** Ids of the apps installed on this TV (from the helper, which may list them). */

/** Apps installed on this TV, including their launch-point metadata. */
export interface InstalledApp {
    id: string;
    title: string;
    icon: string;
    artwork: string;
    launchPointId: string;
    visible: boolean;
    lptype: string;
}


interface HomebrewExecResponse {
    stdoutString?: string;
    error?: string;
}

interface LaunchPoint {
    id: string;
    title?: string;
    icon?: string;
    largeIcon?: string;
    bgImage?: string;
    bgImages?: string[];
    bgColor?: string;
    launchPointId?: string;
    hidden?: boolean;
    lptype?: string;
}

const HBCHANNEL_SERVICE = 'org.webosbrew.hbchannel.service';
const SAFE_ICON_PATH = /^\/[A-Za-z0-9._\/+@-]+$/;
const iconCache: Record<string, string> = {};
const artworkCache: Record<string, string> = {};

function shellQuote(value: string): string {
    return "'" + value.replace(/'/g, "'\\''") + "'";
}

function homebrewExec(
    command: string,
    timeoutMs = 8000
): Promise<string> {
    return lunaCall<HomebrewExecResponse>(
        HBCHANNEL_SERVICE,
        'exec',
        { command },
        timeoutMs
    ).then((response) => {
        if (response.error) {
            throw new Error(response.error);
        }

        return response.stdoutString || '';
    });
}


export function installedApps(): Promise<InstalledApp[]> {
    const command =
        "luna-send -n 1 -f " +
        "'luna://com.webos.applicationManager/listLaunchPoints' '{}'";

    return homebrewExec(command).then((stdout) => {
        const result = JSON.parse(stdout) as {
            returnValue?: boolean;
            launchPoints?: LaunchPoint[];
        };

        if (
            result.returnValue !== true ||
            !Array.isArray(result.launchPoints)
        ) {
            throw new Error('Unable to read webOS launch points');
        }

        const points = result.launchPoints.filter(
            (app) =>
                app &&
                !!app.id &&
                app.hidden !== true &&
                app.id !== 'tld.my.minimalhome'
        );

        const missingIcons: { id: string; path: string }[] = [];
        const missingArtwork: { id: string; path: string }[] = [];

        for (const app of points) {
            const iconPath = app.largeIcon || app.icon || '';
            const artworkPath = app.bgImage || '';

            if (
                iconPath &&
                SAFE_ICON_PATH.test(iconPath) &&
                !iconCache[app.id]
            ) {
                missingIcons.push({ id: app.id, path: iconPath });
            }

            if (
                artworkPath &&
                SAFE_ICON_PATH.test(artworkPath) &&
                !artworkCache[app.id]
            ) {
                missingArtwork.push({
                    id: app.id,
                    path: artworkPath
                });
            }
        }

        const loadImages = (
            items: { id: string; path: string }[],
            cache: Record<string, string>
        ): Promise<void> => {
            if (!items.length) return Promise.resolve();

            const script = items
                .map(
                    (item, index) =>
                        `printf '%d ' ${index}; base64 ${shellQuote(item.path)} 2>/dev/null | tr -d '\\n'; echo`
                )
                .join('; ');

            return homebrewExec(script, 30000).then((output) => {
                for (const line of output.split('\n')) {
                    const match = /^(\d+) ([A-Za-z0-9+/=]+)$/.exec(line);
                    if (!match) continue;

                    const item = items[Number(match[1])];
                    if (!item) continue;

                    const extension =
                        item.path.match(/\.([A-Za-z0-9]+)(?:[?#].*)?$/)?.[1]
                            .toLowerCase() || 'png';

                    const mime =
                        extension === 'jpg' || extension === 'jpeg'
                            ? 'image/jpeg'
                            : extension === 'webp'
                              ? 'image/webp'
                              : extension === 'gif'
                                ? 'image/gif'
                                : 'image/png';

                    cache[item.id] = `data:${mime};base64,${match[2]}`;
                }
            });
        };

        return loadImages(missingIcons, iconCache)
            .then(() => loadImages(missingArtwork, artworkCache))
            .then(() =>
                points.map((app) => ({
                    id: app.id,
                    title: app.title || app.id,
                    icon: iconCache[app.id] || '',
                    artwork: artworkCache[app.id] || '',
                    launchPointId: app.launchPointId || '',
                    visible: app.hidden !== true,
                    lptype: app.lptype || 'default'
                }))
            );
    });
}


/** The server Jellyfin Native is signed in to (only the address - the helper never hands out its token). */
export function jellyfinServerFromNative (): Promise<string> {
	return lunaCall<{server?: string}>('tld.my.minimalhome.service', 'jellyfinServer', {}, 3000).then((r) => r.server || '');
}

/** Open a Jellyfin item in Jellyfin Native and resume it. Goes through the helper, which first closes a copy of the app that
 *  is still running in the background (the native app reads launch parameters only at start); without the helper, a plain
 *  launch still works whenever the app isn't running. */
export function openJellyfinItem (appId: string, itemId: string): Promise<unknown> {
	return lunaCall('tld.my.minimalhome.service', 'openItem', {itemId, play: true}, 6000)
		.catch(() => launchApp(appId, {itemId, play: true}));
}

/**
 * Ask the helper service to switch the panel off (OLED care after a long idle). The helper only does it while the launcher is
 * in front and the TV is Active. Best effort; any remote key brings the picture back.
 */
export function panelOff (): Promise<unknown> {
	return lunaCall('tld.my.minimalhome.service', 'screenOff', {});
}

/** One HDMI port as the TV's external-input manager sees it. */
export interface InputPort {id: string; appId: string; label: string; renamed: boolean; plugged: boolean}

interface EimDevice {id?: string; appId?: string; label?: string; modified?: boolean; hdmiPlugIn?: boolean}

function toPorts (msg: string): InputPort[] | null {
	try {
		const d = JSON.parse(msg) as {returnValue?: boolean; devices?: EimDevice[]};
		if (d.returnValue === false || !Array.isArray(d.devices)) return null;
		return d.devices.filter((x) => x.id && x.appId).map((x) => ({
			id: x.id!, appId: x.appId!, label: x.label || x.id!, renamed: x.modified === true, plugged: x.hdmiPlugIn === true
		}));
	} catch { return null; }
}

/**
 * Live HDMI plug state (com.webos.service.eim/getAllInputStatus; `hdmiPlugIn` = a powered device on the cable). Subscribes,
 * and also re-reads whenever `refresh()` is called (the launcher does that on return and every few seconds while shown,
 * because a push on plug/unplug isn't verified on this firmware). Returns {refresh, cancel}; no-op off webOS.
 */
export function watchInputs (onPorts: (ports: InputPort[]) => void): {refresh: () => void; cancel: () => void} {
	const Bridge = typeof window !== 'undefined' ? window.PalmServiceBridge : undefined;
	if (!Bridge) return {refresh: () => { /* not on webOS */ }, cancel: () => { /* not on webOS */ }};
	const sub = new Bridge();
	sub.onservicecallback = (msg) => { const p = toPorts(msg); if (p) onPorts(p); };
	try { sub.call('luna://com.webos.service.eim/getAllInputStatus', JSON.stringify({subscribe: true})); } catch { /* noop */ }
	return {
		refresh: () => {
			lunaCall('com.webos.service.eim', 'getAllInputStatus', {})
				.then((d) => { const p = toPorts(JSON.stringify(d)); if (p) onPorts(p); })
				.catch(() => { /* keep the last known state */ });
		},
		cancel: () => { try { sub.cancel?.(); } catch { /* noop */ } }
	};
}
