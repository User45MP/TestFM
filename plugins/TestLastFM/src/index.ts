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

// --- 1. NOW PLAYING NOTIFICATION ---
unloads.add(
    MediaItem.onMediaTransition(unloads, (mediaItem) => {
        makeScrobbleOpts(mediaItem)
            .then(LastFM.updateNowPlaying)
            .catch(trace.msg.err.withContext(`Failed to updateNowPlaying!`));
    })
);

// --- 2. STATE VARIABLES ---
let currentMediaItem: MediaItem | undefined;
let lastPlayStart: number | undefined = Date.now();
let cumulativePlaytime: number = 0;
let alreadyScrobbled: boolean = false;

const MIN_SCROBBLE_DURATION = 240000; // 4 minutes
const MIN_SCROBBLE_PERCENTAGE = 0.5;  // 50%

// Initialize first song
MediaItem.fromPlaybackContext().then(item => { 
    currentMediaItem = item;
    trace.log("LastFM Plugin Loaded. First song initialized.");
});

// --- 3. PAUSE/PLAY TRACKER ---
unloads.add(
    redux.intercept("playbackControls/SET_PLAYBACK_STATE", unloads, (state) => {
        if (state === "PLAYING") {
            // Resume counting
            lastPlayStart = Date.now();
        } else {
            // Pause counting: save what we have so far
            if (lastPlayStart !== undefined) {
                cumulativePlaytime += Date.now() - lastPlayStart;
            }
            lastPlayStart = undefined;
        }
    })
);

// --- 4. SCROBBLE LOGIC (Handles Repeat One) ---
unloads.add(
    MediaItem.onMediaTransition(unloads, async (mediaItem) => {
        trace.log("Transition detected!");

        // A. Scrobble the PREVIOUS track
        if (currentMediaItem !== undefined && !alreadyScrobbled) {
            
            // Add the final chunk of time from the song that just finished
            if (lastPlayStart !== undefined) {
                cumulativePlaytime += Date.now() - lastPlayStart;
            }

            if (currentMediaItem.duration !== undefined) {
                const totalTimeMs = cumulativePlaytime;
                const requiredTimeMs = currentMediaItem.duration * MIN_SCROBBLE_PERCENTAGE * 1000;
                
                trace.log(`Check: Listened ${totalTimeMs}ms / Required ${requiredTimeMs}ms`);

                const longerThan4min = totalTimeMs >= MIN_SCROBBLE_DURATION;
                const moreThan50Percent = totalTimeMs >= requiredTimeMs;

                if (longerThan4min || moreThan50Percent) {
                    try {
                        const opts = await makeScrobbleOpts(currentMediaItem);
                        const res = await LastFM.scrobble(opts);
                        if (res?.scrobbles) trace.log("Scrobbled", opts);
                        alreadyScrobbled = true;
                    } catch (e) {
                        trace.msg.err.withContext("Failed to scrobble!")(e);
                    }
                } else {
                    trace.log("Not enough playtime to scrobble.");
                }
            }
        }

        // B. RESET EVERYTHING for the NEW track (or the repeat loop)
        currentMediaItem = mediaItem;
        cumulativePlaytime = 0;          // <--- Reset timer to 0
        lastPlayStart = Date.now();      // <--- Start timer NOW
        alreadyScrobbled = false;        // <--- Reset flag
    })
);
