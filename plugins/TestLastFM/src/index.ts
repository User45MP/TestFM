import { Tracer, type LunaUnload } from "@luna/core";
import { MediaItem, PlayState, redux } from "@luna/lib";

export const { trace, errSignal } = Tracer("[last.fm]");

import { LastFM, ScrobbleOpts } from "./LastFM";

// --- CONFIGURATION ---
redux.actions["lastFm/DISCONNECT"]();

const delUndefined = <O extends Record<any, any>>(obj: O) => {
    for (const key in obj) if (obj[key] === undefined) delete obj[key];
};

const makeScrobbleOpts = async (mediaItem: MediaItem): Promise<ScrobbleOpts> => {
    const album = await mediaItem.album();
    const scrobbleOpts: Partial<ScrobbleOpts> = {
        track: await mediaItem.title(),
        artist: (await mediaItem.artist())?.name,
        album: await album?.title(),
        albumArtist: (await album?.artist())?.name,
        trackNumber: mediaItem.trackNumber?.toString(),
        mbid: await mediaItem.brainzId(),
        timestamp: (Date.now() / 1000).toFixed(0),
    };
    delUndefined(scrobbleOpts);
    return scrobbleOpts as ScrobbleOpts;
};

export { Settings } from "./Settings";

export const unloads = new Set<LunaUnload>();

// --- 1. NOW PLAYING NOTIFICATION (Standard Behavior) ---
unloads.add(
    MediaItem.onMediaTransition(unloads, (mediaItem) => {
        makeScrobbleOpts(mediaItem)
            .then(LastFM.updateNowPlaying)
            .catch(trace.msg.err.withContext(`Failed to updateNowPlaying!`));
    })
);

// --- 2. STATE VARIABLES FOR SCROBBLING ---
let currentMediaItem: MediaItem | undefined;
let lastPlayStart: number | undefined = Date.now();
let cumulativePlaytime: number = 0;
let alreadyScrobbled: boolean = false;

const MIN_SCROBBLE_DURATION = 240000; // 4 minutes (ms)
const MIN_SCROBBLE_PERCENTAGE = 0.5;  // 50%

// Initialize immediately
MediaItem.fromPlaybackContext().then(item => { currentMediaItem = item; });

// --- 3. PAUSE/PLAY TRACKER (Fixes timing issues) ---
unloads.add(
    redux.intercept("playbackControls/SET_PLAYBACK_STATE", unloads, (state) => {
        if (state === "PLAYING") {
            lastPlayStart = Date.now();
        } else {
            // If we pause, add the time we just listened to the total
            if (lastPlayStart !== undefined) {
                cumulativePlaytime += Date.now() - lastPlayStart;
            }
            lastPlayStart = undefined;
        }
    })
);

// --- 4. SCROBBLE LOGIC (Handles "Repeat One" correctly) ---
unloads.add(
    MediaItem.onMediaTransition(unloads, async (mediaItem) => {
        
        // A. Check if the PREVIOUS song should be scrobbled
        if (currentMediaItem !== undefined && !alreadyScrobbled) {
            
            // Add any remaining time from the last session
            if (lastPlayStart !== undefined) {
                cumulativePlaytime += Date.now() - lastPlayStart;
            }

            if (currentMediaItem.duration !== undefined) {
                const longerThan4min = cumulativePlaytime >= MIN_SCROBBLE_DURATION;
                const minPlayTime = currentMediaItem.duration * MIN_SCROBBLE_PERCENTAGE * 1000;
                const moreThan50Percent = cumulativePlaytime >= minPlayTime;

                if (longerThan4min || moreThan50Percent) {
                    try {
                        const opts = await makeScrobbleOpts(currentMediaItem);
                        const res = await LastFM.scrobble(opts);
                        if (res?.scrobbles) trace.log("Scrobbled", opts, res.scrobbles.scrobble);
                        alreadyScrobbled = true;
                    } catch (e) {
                        trace.msg.err.withContext("Failed to scrobble!")(e);
                    }
                }
            }
        }

        // B. Reset state for the NEW song
        currentMediaItem = mediaItem;
        cumulativePlaytime = 0;
        lastPlayStart = Date.now(); 
        alreadyScrobbled = false;
    })
);