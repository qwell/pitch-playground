'use strict';

const DEFAULT_A4 = 440;
const DEFAULT_MIDI = 69;

const TUNER_ANALYSIS_INTERVAL_MS = 50;
const TUNER_SMOOTHING = 0.18;
const TUNER_MIN_RMS = 0.006;
const TUNER_STABLE_FRAMES = 3;
const TUNER_YIN_THRESHOLD = 0.15;
const TUNER_HISTORY_LENGTH = 5;

const TUNER_MIN_HZ = 50;
const TUNER_MAX_HZ = 4200;

const METRONOME_LOOKAHEAD_MS = 25;
const METRONOME_SCHEDULE_AHEAD_SECONDS = 0.1;
const METRONOME_CLICK_DURATION = 0.035;
const METRONOME_NORMAL_HZ = 800;
const METRONOME_GROUP_HZ = 1000;
const METRONOME_FIRST_HZ = 1200;

const METRONOME_METERS = {
    '2/4': [2, 0],
    '3/4': [2, 0, 0],
    '4/4': [2, 0, 0, 0],

    '2/2': [2, 0],
    '3/8': [2, 0, 0],

    '6/8': [2, 0, 0, 1, 0, 0],
    '9/8': [2, 0, 0, 1, 0, 0, 1, 0, 0],
    '12/8': [2, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0],

    '5/4': [2, 0, 0, 1, 0],
    '7/8': [2, 0, 1, 0, 1, 0, 0],
};

const PICK_STATS_KEY = 'pitchPlayground.pickStats.v7';
const PLACEMENT_STATS_KEY = 'pitchPlayground.placementStats.v1';
const PLACEMENT_ADVANCE_DELAY = 3000;
const ADAPTIVE_WINDOW_SIZE = 5;
const ADAPTIVE_NARROW_FACTOR = 0.8;
const ADAPTIVE_WIDEN_FACTOR = 1.25;
const DEFAULT_VOLUME = 0.8;
const VOICE_GAIN = 0.25;

const NOTE_NAMES = [
    'C',
    'C♯ / D♭',
    'D',
    'D♯ / E♭',
    'E',
    'F',
    'F♯ / G♭',
    'G',
    'G♯ / A♭',
    'A',
    'A♯ / B♭',
    'B',
];

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function readNumber(input, fallback) {
    const rawValue = input.value.trim();

    if (rawValue === '') {
        return fallback;
    }

    const value = Number(rawValue);

    if (!Number.isFinite(value)) {
        return fallback;
    }

    const minimum = input.hasAttribute('min')
        ? Number(input.getAttribute('min'))
        : -Infinity;

    const maximum = input.hasAttribute('max')
        ? Number(input.getAttribute('max'))
        : Infinity;

    return clamp(value, minimum, maximum);
}

function signed(value, decimalPlaces = 1) {
    return `${value >= 0 ? '+' : ''}${value.toFixed(decimalPlaces)}`;
}

function frequencyFromCents(referenceHz, cents) {
    return referenceHz * 2 ** (cents / 1200);
}

function centsBetween(frequencyHz, referenceHz) {
    return 1200 * Math.log2(frequencyHz / referenceHz);
}

function getA4() {
    return readNumber(
        document.querySelector('[data-control="a4"]'),
        DEFAULT_A4
    );
}

function midiFrequency(midi) {
    return getA4() * 2 ** ((midi - 69) / 12);
}

function midiToNoteName(midi) {
    const roundedMidi = Math.round(midi);
    const pitchClass = ((roundedMidi % 12) + 12) % 12;
    const octave = Math.floor(roundedMidi / 12) - 1;

    return `${NOTE_NAMES[pitchClass]}${octave}`;
}

function selectedNoteFrequency(select) {
    return midiFrequency(Number(select.value));
}

// Audio

const audio = (() => {
    let context = null;
    let masterGain = null;

    const transientVoices = new Set();

    function ensureContext() {
        if (!context) {
            const AudioContextClass =
                window.AudioContext || window.webkitAudioContext;

            if (!AudioContextClass) {
                throw new Error('Web Audio API is unavailable.');
            }

            context = new AudioContextClass();

            masterGain = context.createGain();
            masterGain.gain.value = masterVolume;
            masterGain.connect(context.destination);
        }

        if (context.state === 'suspended') {
            void context.resume();
        }

        return context;
    }

    function currentTime() {
        return ensureContext().currentTime;
    }

    function cancelAndHold(parameter, time) {
        if (typeof parameter.cancelAndHoldAtTime === 'function') {
            parameter.cancelAndHoldAtTime(time);
            return;
        }

        const currentValue = parameter.value;

        parameter.cancelScheduledValues(time);
        parameter.setValueAtTime(currentValue, time);
    }

    function fadeTo(parameter, target, seconds = 0.015) {
        const audioContext = ensureContext();
        const now = audioContext.currentTime;

        cancelAndHold(parameter, now);
        parameter.linearRampToValueAtTime(target, now + seconds);
    }

    function createVoice(frequencyHz, waveform) {
        const audioContext = ensureContext();
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();

        oscillator.type = waveform;
        oscillator.frequency.value = frequencyHz;

        oscillator.connect(gain);
        gain.connect(masterGain);

        return {
            audioContext,
            oscillator,
            gain,
        };
    }

    function setMasterVolume(volume) {
        masterVolume = clamp(volume, 0, 1);

        if (masterGain) {
            masterGain.gain.setTargetAtTime(
                masterVolume,
                context.currentTime,
                0.01
            );
        }
    }

    function playContinuous(frequencyHz, waveform, volume = 1) {
        const { audioContext, oscillator, gain } = createVoice(
            frequencyHz,
            waveform
        );

        gain.gain.value = 0;

        oscillator.start();

        fadeTo(gain.gain, VOICE_GAIN * clamp(volume, 0, 1));

        let stopped = false;

        return {
            setFrequency(frequency) {
                if (stopped) {
                    return;
                }

                oscillator.frequency.setTargetAtTime(
                    frequency,
                    audioContext.currentTime,
                    0.006
                );
            },

            stop() {
                if (stopped) {
                    return;
                }

                stopped = true;

                fadeTo(gain.gain, 0);

                try {
                    oscillator.stop(audioContext.currentTime + 0.025);
                } catch {
                    // move on
                }

                oscillator.addEventListener(
                    'ended',
                    () => {
                        oscillator.disconnect();
                        gain.disconnect();
                    },
                    {
                        once: true,
                    }
                );
            },
        };
    }

    function playTransient(
        frequencyHz,
        waveform,
        durationSeconds,
        volume = 1,
        delaySeconds = 0
    ) {
        const { audioContext, oscillator, gain } = createVoice(
            frequencyHz,
            waveform
        );

        const startTime = audioContext.currentTime + delaySeconds;

        const releaseTime = startTime + durationSeconds;

        const targetGain = VOICE_GAIN * clamp(volume, 0, 1);

        oscillator.frequency.setValueAtTime(frequencyHz, startTime);

        gain.gain.setValueAtTime(0, startTime);

        gain.gain.linearRampToValueAtTime(targetGain, startTime + 0.012);

        gain.gain.setValueAtTime(
            targetGain,
            Math.max(startTime + 0.012, releaseTime - 0.015)
        );

        gain.gain.linearRampToValueAtTime(0, releaseTime);

        oscillator.start(startTime);
        oscillator.stop(releaseTime + 0.02);

        let stopped = false;

        const voice = {
            stop() {
                if (stopped) {
                    return;
                }

                stopped = true;

                const now = audioContext.currentTime;

                cancelAndHold(gain.gain, now);

                gain.gain.linearRampToValueAtTime(0, now + 0.015);

                try {
                    oscillator.stop(Math.max(now + 0.02, startTime));
                } catch {
                    // move on
                }
            },
        };

        transientVoices.add(voice);

        oscillator.addEventListener(
            'ended',
            () => {
                transientVoices.delete(voice);

                oscillator.disconnect();
                gain.disconnect();
            },
            {
                once: true,
            }
        );

        return voice;
    }

    function stopTransient() {
        for (const voice of transientVoices) {
            voice.stop();
        }

        transientVoices.clear();
    }

    function createAnalyser(stream, fftSize = 2048) {
        const audioContext = ensureContext();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();

        analyser.fftSize = fftSize;
        analyser.smoothingTimeConstant = 0;

        source.connect(analyser);

        return {
            analyser,
            source,
            sampleRate: audioContext.sampleRate,
        };
    }

    return {
        currentTime,
        playContinuous,
        playTransient,
        stopTransient,
        createAnalyser,
        setMasterVolume,
    };
})();

let masterVolume = DEFAULT_VOLUME;

function updateVolume() {
    const input = document.querySelector('[data-control="volume"]');

    const volume = clamp(Number(input.value), 0, 1);

    document.querySelector('[data-output="volume-percent"]').textContent =
        `${Math.round(volume * 100)}%`;

    audio.setMasterVolume(volume);
}

let tunerVoice = null;

function playTuner() {
    stopGeneratedAudio();

    tunerVoice = audio.playContinuous(
        selectedNoteFrequency(document.querySelector('[data-note="tuner"]')),
        document.querySelector('[data-waveform="tuner"]').value
    );
}

function stopTuner() {
    if (!tunerVoice) {
        return;
    }

    tunerVoice.stop();
    tunerVoice = null;
}

function stopGeneratedAudio() {
    stopTuner();
    stopMetronome();
    audio.stopTransient();
}

function stopAllAudio() {
    stopGeneratedAudio();
    stopMicTuner();
}

// Notes

function createNoteOption(midi) {
    const option = document.createElement('option');

    option.value = String(midi);
    option.textContent = midiToNoteName(midi);

    return option;
}

function populateNoteSelector(select) {
    const options = [];

    for (let midi = 36; midi <= 84; midi += 1) {
        options.push(createNoteOption(midi));
    }

    select.replaceChildren(...options);
    select.value = String(DEFAULT_MIDI);
}

function initializeNotes() {
    for (const select of document.querySelectorAll('.note-select')) {
        populateNoteSelector(select);
    }
}

function updateNoteReadout(select) {
    const readout = document.querySelector(
        `[data-note-frequency="${select.dataset.note}"]`
    );

    readout.textContent = `${selectedNoteFrequency(select).toFixed(3)} Hz`;
}

function updateNoteReadouts() {
    for (const select of document.querySelectorAll('.note-select')) {
        updateNoteReadout(select);
    }
}

// Tabs

function activateTab(button, focus = false) {
    const tabName = button.dataset.tab;

    for (const tab of document.querySelectorAll('.tab')) {
        const active = tab === button;

        tab.classList.toggle('active', active);

        tab.setAttribute('aria-selected', String(active));

        tab.tabIndex = active ? 0 : -1;
    }

    for (const panel of document.querySelectorAll('.tab-panel')) {
        panel.hidden = panel.dataset.panel !== tabName;
    }

    stopAllAudio();
    cancelPlacementAdvance();

    if (focus) {
        button.focus();
    }
}

function initializeTabs() {
    const tabs = [...document.querySelectorAll('.tab')];

    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => {
            activateTab(tab);
        });

        tab.addEventListener('keydown', (event) => {
            let nextIndex;

            switch (event.key) {
                case 'ArrowRight':
                    nextIndex = (index + 1) % tabs.length;

                    break;

                case 'ArrowLeft':
                    nextIndex = (index - 1 + tabs.length) % tabs.length;

                    break;

                case 'Home':
                    nextIndex = 0;
                    break;

                case 'End':
                    nextIndex = tabs.length - 1;

                    break;

                default:
                    return;
            }

            event.preventDefault();

            activateTab(tabs[nextIndex], true);
        });
    });
}

// Tuning

const tunerMic = {
    stream: null,
    source: null,
    analyser: null,
    sampleRate: 0,
    buffer: null,
    frame: null,

    requestId: 0,

    smoothedCents: null,
    smoothedNoteMidi: null,

    pendingMidi: null,
    pendingFrames: 0,

    lastAnalysisTime: 0,
    lastValidTime: 0,

    history: [],
};

function setTunerStatus(text) {
    document.querySelector('[data-output="tuner-status"]').textContent = text;
}

function setTunerMicButtonActive(active) {
    const button = document.querySelector('[data-action="toggle-tuner-mic"]');

    button.classList.toggle('active', active);

    button.setAttribute('aria-pressed', String(active));

    button.setAttribute(
        'aria-label',
        active ? 'Stop microphone tuner' : 'Start microphone tuner'
    );
}

function resetTunerTracking(resetPending) {
    tunerMic.history = [];

    tunerMic.smoothedCents = null;
    tunerMic.smoothedNoteMidi = null;

    if (resetPending) {
        tunerMic.pendingMidi = null;
        tunerMic.pendingFrames = 0;
    }
}

function resetTunerDetection(status = 'Microphone off') {
    document.querySelector('[data-output="tuner-closest"]').textContent = '--';

    document.querySelector('[data-output="tuner-target"]').textContent =
        '-- Hz';

    document.querySelector('[data-output="tuner-detected"]').textContent =
        '-- Hz detected';

    document.querySelector('[data-output="tuner-cents"]').textContent = '--';

    const needle = document.querySelector('[data-output="tuner-needle"]');
    needle.classList.remove('visible', 'in-tune');

    setTunerStatus(status);
}

function stopMicTuner() {
    tunerMic.requestId += 1;

    if (tunerMic.frame !== null) {
        cancelAnimationFrame(tunerMic.frame);

        tunerMic.frame = null;
    }

    if (tunerMic.source) {
        tunerMic.source.disconnect();

        tunerMic.source = null;
    }

    if (tunerMic.stream) {
        for (const track of tunerMic.stream.getTracks()) {
            track.stop();
        }

        tunerMic.stream = null;
    }

    tunerMic.analyser = null;

    tunerMic.sampleRate = 0;

    tunerMic.buffer = null;

    tunerMic.lastAnalysisTime = 0;

    tunerMic.lastValidTime = 0;

    resetTunerTracking(true);

    setTunerMicButtonActive(false);

    resetTunerDetection();
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);

    const middle = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 1) {
        return sorted[middle];
    }

    return (sorted[middle - 1] + sorted[middle]) / 2;
}

function detectPitchYin(
    samples,
    sampleRate,
    minimumHz,
    maximumHz,
    threshold = TUNER_YIN_THRESHOLD
) {
    let squareTotal = 0;

    for (const sample of samples) {
        squareTotal += sample * sample;
    }

    const rms = Math.sqrt(squareTotal / samples.length);

    if (rms < TUNER_MIN_RMS) {
        return null;
    }

    const minimumPeriod = Math.max(2, Math.floor(sampleRate / maximumHz));

    const maximumPeriod = Math.min(
        Math.floor(sampleRate / minimumHz),
        Math.floor(samples.length / 2)
    );

    if (maximumPeriod <= minimumPeriod + 2) {
        return null;
    }

    const difference = new Float32Array(maximumPeriod + 1);

    const windowLength = samples.length - maximumPeriod;

    for (let period = 1; period <= maximumPeriod; period += 1) {
        let total = 0;

        for (let index = 0; index < windowLength; index += 1) {
            const delta = samples[index] - samples[index + period];

            total += delta * delta;
        }

        difference[period] = total;
    }

    difference[0] = 1;

    let runningTotal = 0;

    for (let period = 1; period <= maximumPeriod; period += 1) {
        runningTotal += difference[period];

        difference[period] =
            runningTotal === 0
                ? 1
                : (difference[period] * period) / runningTotal;
    }

    let bestPeriod = -1;

    for (let period = minimumPeriod; period <= maximumPeriod; period += 1) {
        if (difference[period] >= threshold) {
            continue;
        }

        while (
            period + 1 <= maximumPeriod &&
            difference[period + 1] < difference[period]
        ) {
            period += 1;
        }

        bestPeriod = period;

        break;
    }

    if (bestPeriod === -1) {
        let bestValue = Infinity;

        for (let period = minimumPeriod; period <= maximumPeriod; period += 1) {
            if (difference[period] < bestValue) {
                bestValue = difference[period];

                bestPeriod = period;
            }
        }

        if (bestPeriod === -1 || bestValue > 0.25) {
            return null;
        }
    }

    let refinedPeriod = bestPeriod;

    if (bestPeriod > 1 && bestPeriod < maximumPeriod) {
        const left = difference[bestPeriod - 1];

        const center = difference[bestPeriod];

        const right = difference[bestPeriod + 1];

        const denominator = left - 2 * center + right;

        if (Math.abs(denominator) > 1e-12) {
            refinedPeriod += (0.5 * (left - right)) / denominator;
        }
    }

    if (!Number.isFinite(refinedPeriod) || refinedPeriod <= 0) {
        return null;
    }

    return sampleRate / refinedPeriod;
}

function nearestMusicalNote(frequencyHz) {
    /*
     * MIDI 69 is A4.
     * The user's global A4 reference is
     * respected here.
     */
    const exactMidi = 69 + 12 * Math.log2(frequencyHz / getA4());

    const midi = Math.round(exactMidi);

    const targetHz = midiFrequency(midi);

    return {
        midi,

        name: midiToNoteName(midi),

        targetHz,

        cents: centsBetween(frequencyHz, targetHz),
    };
}

function renderTunerDetection(frequencyHz) {
    const nearest = nearestMusicalNote(frequencyHz);

    if (tunerMic.smoothedNoteMidi !== nearest.midi) {
        tunerMic.smoothedNoteMidi = nearest.midi;

        tunerMic.smoothedCents = nearest.cents;
    } else {
        tunerMic.smoothedCents +=
            (nearest.cents - tunerMic.smoothedCents) * TUNER_SMOOTHING;
    }

    const cents = tunerMic.smoothedCents;

    const limitedCents = clamp(cents, -50, 50);

    const percent = limitedCents + 50;

    document.querySelector('[data-output="tuner-closest"]').textContent =
        nearest.name;

    document.querySelector('[data-output="tuner-target"]').textContent =
        `${nearest.targetHz.toFixed(3)} Hz`;

    document.querySelector('[data-output="tuner-detected"]').textContent =
        `${frequencyHz.toFixed(3)} Hz detected`;

    document.querySelector('[data-output="tuner-cents"]').textContent =
        `${signed(cents, 1)} cents`;

    const inTune = Math.abs(cents) <= 3;

    const needle = document.querySelector('[data-output="tuner-needle"]');
    needle.style.left = `${percent}%`;
    needle.classList.add('visible');
    needle.classList.toggle('in-tune', inTune);
}

function analyzeTunerMic(time) {
    if (!tunerMic.analyser || !tunerMic.buffer) {
        return;
    }

    if (time - tunerMic.lastAnalysisTime >= TUNER_ANALYSIS_INTERVAL_MS) {
        tunerMic.lastAnalysisTime = time;

        tunerMic.analyser.getFloatTimeDomainData(tunerMic.buffer);

        const frequencyHz = detectPitchYin(
            tunerMic.buffer,
            tunerMic.sampleRate,
            TUNER_MIN_HZ,
            TUNER_MAX_HZ
        );

        if (frequencyHz !== null) {
            const nearest = nearestMusicalNote(frequencyHz);

            if (nearest.midi !== tunerMic.pendingMidi) {
                tunerMic.pendingMidi = nearest.midi;

                tunerMic.pendingFrames = 1;

                tunerMic.history = [];
            } else {
                tunerMic.pendingFrames += 1;
            }

            if (tunerMic.pendingFrames >= TUNER_STABLE_FRAMES) {
                tunerMic.lastValidTime = time;

                tunerMic.history.push(frequencyHz);

                if (tunerMic.history.length > TUNER_HISTORY_LENGTH) {
                    tunerMic.history.shift();
                }

                renderTunerDetection(median(tunerMic.history));
            }
        }

        if (time - tunerMic.lastValidTime > 400) {
            resetTunerTracking(frequencyHz === null);

            resetTunerDetection('No stable pitch');
        }
    }

    tunerMic.frame = requestAnimationFrame(analyzeTunerMic);
}

async function startMicTuner() {
    if (!navigator.mediaDevices?.getUserMedia) {
        resetTunerDetection('Microphone access unavailable');

        return;
    }

    if (tunerMic.stream) {
        return;
    }

    const requestId = ++tunerMic.requestId;

    resetTunerDetection('Requesting microphone access...');

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
        });

        if (requestId !== tunerMic.requestId) {
            for (const track of stream.getTracks()) {
                track.stop();
            }

            return;
        }

        const connection = audio.createAnalyser(stream, 2048);

        tunerMic.stream = stream;

        tunerMic.source = connection.source;

        tunerMic.analyser = connection.analyser;

        tunerMic.sampleRate = connection.sampleRate;

        tunerMic.buffer = new Float32Array(tunerMic.analyser.fftSize);

        tunerMic.lastAnalysisTime = 0;

        tunerMic.lastValidTime = performance.now();

        resetTunerTracking(true);

        setTunerMicButtonActive(true);

        setTunerStatus('Listening...');

        tunerMic.frame = requestAnimationFrame(analyzeTunerMic);
    } catch (error) {
        const message =
            error?.name === 'NotAllowedError'
                ? 'Microphone permission denied'
                : error?.name === 'NotFoundError'
                  ? 'No microphone found'
                  : 'Could not start microphone';

        resetTunerDetection(message);
    }
}

function toggleMicTuner() {
    if (tunerMic.stream) {
        stopMicTuner();

        return;
    }

    void startMicTuner();
}

// Metronome

const metronome = {
    running: false,
    timer: null,
    nextBeatTime: 0,
    beatIndex: 0,
    tapTimes: [],
};

function scheduleMetronome() {
    if (!metronome.running) {
        return;
    }

    const bpm = readNumber(
        document.querySelector('[data-control="metronome-bpm"]'),
        100
    );

    const signature = document.querySelector(
        '[data-control="metronome-time-signature"]'
    ).value;

    const pattern = METRONOME_METERS[signature] || METRONOME_METERS['4/4'];

    const compound =
        signature === '6/8' || signature === '9/8' || signature === '12/8';

    const secondsPerClick = compound ? 60 / bpm / 3 : 60 / bpm;

    const now = audio.currentTime();

    while (metronome.nextBeatTime < now + METRONOME_SCHEDULE_AHEAD_SECONDS) {
        const accent = pattern[metronome.beatIndex];

        const frequency =
            accent === 2
                ? METRONOME_FIRST_HZ
                : accent === 1
                  ? METRONOME_GROUP_HZ
                  : METRONOME_NORMAL_HZ;

        const volume = accent === 2 ? 0.9 : accent === 1 ? 0.75 : 0.6;

        audio.playTransient(
            frequency,
            'sine',
            METRONOME_CLICK_DURATION,
            volume,
            Math.max(0, metronome.nextBeatTime - now)
        );

        metronome.nextBeatTime += secondsPerClick;

        metronome.beatIndex = (metronome.beatIndex + 1) % pattern.length;
    }
}

function startMetronome() {
    if (metronome.running) {
        return;
    }

    stopAllAudio();

    metronome.running = true;
    metronome.beatIndex = 0;
    metronome.nextBeatTime = audio.currentTime() + 0.05;

    scheduleMetronome();

    metronome.timer = window.setInterval(
        scheduleMetronome,
        METRONOME_LOOKAHEAD_MS
    );
}

function stopMetronome() {
    metronome.running = false;
    metronome.beatIndex = 0;

    if (metronome.timer !== null) {
        clearInterval(metronome.timer);
        metronome.timer = null;
    }
}

function tapTempo() {
    const now = performance.now();
    const previous = metronome.tapTimes.at(-1);

    if (previous !== undefined && now - previous > 2000) {
        metronome.tapTimes = [];
    }

    metronome.tapTimes.push(now);
    metronome.tapTimes = metronome.tapTimes.slice(-5);

    if (metronome.tapTimes.length < 3) {
        return;
    }

    const intervals = [];

    for (let index = 1; index < metronome.tapTimes.length; index += 1) {
        intervals.push(
            metronome.tapTimes[index] - metronome.tapTimes[index - 1]
        );
    }

    const averageInterval =
        intervals.reduce((total, interval) => total + interval, 0) /
        intervals.length;

    const bpmInput = document.querySelector('[data-control="metronome-bpm"]');

    const bpm = clamp(
        Math.round(60000 / averageInterval),
        Number(bpmInput.min),
        Number(bpmInput.max)
    );

    bpmInput.value = String(bpm);
}

// Pitch Placement

function defaultPlacementStats() {
    return {
        streak: 0,
        trials: 0,
        errorTotal: 0,
        best: null,
    };
}

function loadPlacementStats() {
    try {
        const stored = JSON.parse(
            localStorage.getItem(PLACEMENT_STATS_KEY) || 'null'
        );

        if (!stored || typeof stored !== 'object') {
            return defaultPlacementStats();
        }

        return {
            streak: Number.isFinite(stored.streak) ? stored.streak : 0,
            trials: Number.isFinite(stored.trials) ? stored.trials : 0,
            errorTotal: Number.isFinite(stored.errorTotal)
                ? stored.errorTotal
                : 0,
            best: Number.isFinite(stored.best) ? stored.best : null,
        };
    } catch {
        return defaultPlacementStats();
    }
}

function savePlacementStats() {
    try {
        localStorage.setItem(
            PLACEMENT_STATS_KEY,
            JSON.stringify(placement.stats)
        );
    } catch {
        // Storage is optional.
    }
}

const placement = {
    trial: null,
    advanceTimer: null,
    stats: loadPlacementStats(),
    adaptiveResults: [],
};

function cancelPlacementAdvance() {
    if (placement.advanceTimer !== null) {
        clearTimeout(placement.advanceTimer);

        placement.advanceTimer = null;
    }

    document
        .querySelector('.placement-refresh')
        .classList.remove('counting-down');
}

function schedulePlacementAdvance() {
    cancelPlacementAdvance();

    const refreshButton = document.querySelector('.placement-refresh');

    void refreshButton.offsetWidth;

    refreshButton.classList.add('counting-down');

    placement.advanceTimer = window.setTimeout(() => {
        placement.advanceTimer = null;

        refreshButton.classList.remove('counting-down');

        newPlacementTrial(true);
    }, PLACEMENT_ADVANCE_DELAY);
}

function renderPlacementStats() {
    const { streak, trials, errorTotal, best } = placement.stats;

    const meanError = trials > 0 ? errorTotal / trials : 0;

    document.querySelector('[data-output="placement-streak"]').textContent =
        String(streak);

    document.querySelector('[data-output="placement-mean-error"]').textContent =
        `${meanError.toFixed(1)} cents`;

    document.querySelector('[data-output="placement-best"]').textContent =
        best === null ? '--' : `${best.toFixed(2)} cents`;
}

function clearPlacementStats() {
    placement.stats = defaultPlacementStats();

    try {
        localStorage.removeItem(PLACEMENT_STATS_KEY);
    } catch {
        // Storage is optional.
    }

    renderPlacementStats();
}

function setJudgmentState({ disabled, selected = null, correct = null }) {
    for (const button of document.querySelectorAll('[data-judgment]')) {
        button.disabled = disabled;

        button.classList.remove(
            'answer-correct',
            'answer-wrong',
            'answer-target'
        );

        if (selected === null) {
            continue;
        }

        const judgment = button.dataset.judgment;

        if (selected === correct && judgment === selected) {
            button.classList.add('answer-correct');

            continue;
        }

        if (judgment === selected) {
            button.classList.add('answer-wrong');
        }

        if (selected !== correct && judgment === correct) {
            button.classList.add('answer-target');
        }
    }
}

function writeNumberIfChanged(input, value) {
    const rawValue = input.value.trim();
    const currentValue = rawValue === '' ? NaN : Number(rawValue);

    if (!Number.isFinite(currentValue) || currentValue !== value) {
        input.value = String(value);
    }
}

function normalizeNumberInput(input, fallback) {
    const value = readNumber(input, fallback);

    writeNumberIfChanged(input, value);

    return value;
}

function readRange(minimumInput, maximumInput, defaultMinimum, defaultMaximum) {
    let minimum = readNumber(minimumInput, defaultMinimum);
    let maximum = readNumber(maximumInput, defaultMaximum);

    if (minimum > maximum) {
        [minimum, maximum] = [maximum, minimum];
    }

    writeNumberIfChanged(minimumInput, minimum);
    writeNumberIfChanged(maximumInput, maximum);

    return {
        minimum,
        maximum,
    };
}

function updateAdaptiveDifficulty(exercise, correct) {
    const enabled = document.querySelector(
        `[data-control="${exercise}-adaptive"]`
    ).checked;
    const state = exercise === 'placement' ? placement : pick;
    const status = document.querySelector(
        `[data-output="${exercise}-adaptive-status"]`
    );

    if (!enabled) {
        state.adaptiveResults.length = 0;
        return;
    }

    state.adaptiveResults.push(correct);

    if (state.adaptiveResults.length < ADAPTIVE_WINDOW_SIZE) {
        status.textContent =
            `${state.adaptiveResults.length} of ` +
            `${ADAPTIVE_WINDOW_SIZE} answers`;
        return;
    }

    const correctCount = state.adaptiveResults.filter(Boolean).length;
    state.adaptiveResults.length = 0;

    let factor = 1;
    let direction = '';

    if (correctCount >= 4) {
        factor = ADAPTIVE_NARROW_FACTOR;
        direction = 'Narrowed';
    } else if (correctCount <= 2) {
        factor = ADAPTIVE_WIDEN_FACTOR;
        direction = 'Widened';
    }

    if (factor === 1) {
        status.textContent = `Unchanged ${correctCount}/${ADAPTIVE_WINDOW_SIZE}`;
        return;
    }

    const minimumInput = document.querySelector(
        `[data-control="${exercise}-range-min"]`
    );
    const maximumInput = document.querySelector(
        `[data-control="${exercise}-range-max"]`
    );
    const minimum = clamp(
        Math.round(Number(minimumInput.value) * factor * 10) / 10,
        Number(minimumInput.min),
        Number(minimumInput.max)
    );
    const maximum = clamp(
        Math.round(Number(maximumInput.value) * factor * 10) / 10,
        Number(maximumInput.min),
        Number(maximumInput.max)
    );

    writeNumberIfChanged(minimumInput, minimum);
    writeNumberIfChanged(maximumInput, maximum);

    status.textContent = `${direction} to ${minimum} - ${maximum}¢`;
}

function resetAdaptiveProgress(exercise) {
    const state = exercise === 'placement' ? placement : pick;
    const enabled = document.querySelector(
        `[data-control="${exercise}-adaptive"]`
    ).checked;

    state.adaptiveResults.length = 0;
    document.querySelector(
        `[data-output="${exercise}-adaptive-status"]`
    ).textContent = enabled ? `0 of ${ADAPTIVE_WINDOW_SIZE} answers` : '';
}

function clearPlacementResult() {
    const result = document.querySelector('[data-output="placement-result"]');

    result.classList.remove('correct', 'incorrect');

    result.replaceChildren();
}

function createPlacementTrial() {
    const rootHz = selectedNoteFrequency(
        document.querySelector('[data-note="placement"]')
    );

    const semitones = Number(
        document.querySelector('[data-control="placement-interval"]').value
    );

    const { minimum: minimumCents, maximum: maximumCents } = readRange(
        document.querySelector('[data-control="placement-range-min"]'),
        document.querySelector('[data-control="placement-range-max"]'),
        10,
        50
    );

    const magnitude =
        minimumCents + Math.random() * (maximumCents - minimumCents);

    const correctTargetHz = rootHz * 2 ** (semitones / 12);

    return {
        rootHz,
        correctTargetHz,

        mistuneCents: Math.random() < 0.5 ? -magnitude : magnitude,

        committed: false,
    };
}

function newPlacementTrial(playImmediately = false) {
    cancelPlacementAdvance();
    stopAllAudio();

    placement.trial = createPlacementTrial();

    setJudgmentState({
        disabled: true,
    });

    clearPlacementResult();

    if (playImmediately) {
        playPlacementTrial();
    }
}

function playPlacementTrial() {
    cancelPlacementAdvance();

    if (!placement.trial) {
        newPlacementTrial();
    }

    stopAllAudio();

    if (!placement.trial.committed) {
        setJudgmentState({
            disabled: false,
        });
    }

    const { rootHz, correctTargetHz, mistuneCents } = placement.trial;

    const waveform = document.querySelector(
        '[data-waveform="placement"]'
    ).value;

    const duration = readNumber(
        document.querySelector('[data-control="placement-duration"]'),
        1
    );

    const targetHz = frequencyFromCents(correctTargetHz, mistuneCents);

    audio.playTransient(rootHz, waveform, duration);

    audio.playTransient(targetHz, waveform, duration, 1, duration + 0.1);
}

function commitPlacement(judgment) {
    const trial = placement.trial;

    if (!trial || trial.committed) {
        return;
    }

    audio.stopTransient();

    trial.committed = true;

    const distance = Math.abs(trial.mistuneCents);

    const direction = trial.mistuneCents < 0 ? 'flat' : 'sharp';

    const correct = judgment === direction;

    const mistunedHz = frequencyFromCents(
        trial.correctTargetHz,
        trial.mistuneCents
    );

    const errorHz = mistunedHz - trial.correctTargetHz;

    setJudgmentState({
        disabled: true,
        selected: judgment,
        correct: direction,
    });

    placement.stats.trials += 1;

    placement.stats.errorTotal += correct ? 0 : distance;

    placement.stats.streak = correct ? placement.stats.streak + 1 : 0;

    if (
        correct &&
        (placement.stats.best === null || distance < placement.stats.best)
    ) {
        placement.stats.best = distance;
    }

    savePlacementStats();
    renderPlacementStats();
    updateAdaptiveDifficulty('placement', correct);

    const result = document.querySelector('[data-output="placement-result"]');

    result.classList.add(correct ? 'correct' : 'incorrect');

    const icon = document.createElement('strong');

    icon.textContent = correct ? '✓' : '✕';

    const text = document.createTextNode(
        ` ${direction} · ` +
            `${signed(trial.mistuneCents, 2)} cents ` +
            `(${signed(errorHz, 3)} Hz)`
    );

    result.replaceChildren(icon, text);

    schedulePlacementAdvance();
}

// Pick target

const pick = {
    candidates: [],
    committed: false,
    selectedIndex: null,
    adaptiveResults: [],
};

function shuffle(items) {
    const result = [...items];

    for (let index = result.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));

        [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
    }

    return result;
}

function spreadMagnitudes(count, minimum, maximum) {
    if (count === 0) {
        return [];
    }

    if (count === 1) {
        return [minimum + Math.random() * (maximum - minimum)];
    }

    const bandSize = (maximum - minimum) / count;

    return Array.from({ length: count }, (_, index) => {
        const lower = minimum + bandSize * index;

        const upper =
            index === count - 1 ? maximum : minimum + bandSize * (index + 1);

        return lower + Math.random() * (upper - lower);
    });
}

function candidateOffsets(count, minimum, maximum) {
    const nonTargetCount = count - 1;

    let negativeCount = Math.floor(nonTargetCount / 2);

    let positiveCount = nonTargetCount - negativeCount;

    /*
     * When there's an odd number of
     * non-target candidates, randomly
     * choose which side gets the extra.
     */
    if (Math.random() < 0.5) {
        [negativeCount, positiveCount] = [positiveCount, negativeCount];
    }

    const negativeOffsets = spreadMagnitudes(
        negativeCount,
        minimum,
        maximum
    ).map((magnitude) => -magnitude);

    const positiveOffsets = spreadMagnitudes(positiveCount, minimum, maximum);

    return [0, ...negativeOffsets, ...positiveOffsets];
}

function newPickSet() {
    stopAllAudio();

    const targetHz = selectedNoteFrequency(
        document.querySelector('[data-note="pick"]')
    );

    const { minimum: minimumCents, maximum: maximumCents } = readRange(
        document.querySelector('[data-control="pick-range-min"]'),
        document.querySelector('[data-control="pick-range-max"]'),
        10,
        50
    );

    const count = Math.round(
        readNumber(document.querySelector('[data-control="pick-count"]'), 7)
    );

    pick.candidates = shuffle(
        candidateOffsets(count, minimumCents, maximumCents).map((cents) => ({
            cents,

            frequencyHz: frequencyFromCents(targetHz, cents),

            isTarget: Math.abs(cents) < 0.000001,

            played: false,
        }))
    );

    pick.committed = false;
    pick.selectedIndex = null;

    document.querySelector('[data-output="pick-status"]').textContent = '';

    renderCandidates();
}

function getCandidateResult(candidate, index) {
    if (!pick.committed) {
        return null;
    }

    if (candidate.isTarget && index === pick.selectedIndex) {
        return {
            icon: '✓',
            className: 'pick-correct',
        };
    }

    if (index === pick.selectedIndex) {
        return {
            icon: '✕',
            className: 'pick-wrong',
        };
    }

    if (candidate.isTarget) {
        return {
            icon: '◎',
            className: 'pick-target',
        };
    }

    return {
        icon: '',
        className: '',
    };
}

function createCandidateRow(candidate, index) {
    const row = document.createElement('div');

    row.className = 'candidate-row';

    row.dataset.index = String(index);

    const actions = document.createElement('div');

    actions.className = 'candidate-actions';

    const playButton = document.createElement('button');

    playButton.type = 'button';

    playButton.className = 'icon-button candidate-play';

    playButton.dataset.action = 'play-candidate';

    playButton.setAttribute('aria-label', `Play candidate ${index + 1}`);

    playButton.title = `Play candidate ${index + 1}`;

    playButton.textContent = '▶';

    const chooseButton = document.createElement('button');

    chooseButton.type = 'button';

    chooseButton.className = 'choose-button';

    chooseButton.dataset.action = 'choose-candidate';

    chooseButton.textContent = `Choose #${index + 1}`;

    chooseButton.disabled = pick.committed || !candidate.played;

    actions.append(playButton, chooseButton);

    row.append(actions);

    const result = getCandidateResult(candidate, index);

    if (!result) {
        return row;
    }

    if (result.className) {
        row.classList.add(result.className);
    }

    const details = document.createElement('span');

    details.className = 'candidate-details';

    if (result.icon) {
        const icon = document.createElement('span');

        icon.className = 'candidate-result-icon';

        icon.textContent = result.icon;

        details.append(icon);
    }

    details.append(
        document.createTextNode(
            `${candidate.frequencyHz.toFixed(3)} Hz, ` +
                `${signed(candidate.cents, 2)} cents`
        )
    );

    row.append(details);

    return row;
}

function renderCandidates() {
    const rows = pick.candidates.map(createCandidateRow);

    document.querySelector('[data-candidates]').replaceChildren(...rows);
}

function playCandidate(index) {
    const candidate = pick.candidates[index];

    if (!candidate) {
        return;
    }

    stopAllAudio();

    candidate.played = true;

    audio.playTransient(
        candidate.frequencyHz,

        document.querySelector('[data-waveform="pick"]').value,

        readNumber(document.querySelector('[data-control="pick-duration"]'), 1)
    );

    if (pick.committed) {
        return;
    }

    const row = document.querySelector(`.candidate-row[data-index="${index}"]`);

    const chooseButton = row?.querySelector('[data-action="choose-candidate"]');

    if (chooseButton) {
        chooseButton.disabled = false;
    }
}

let pickStatsCache = null;

function loadPickStats() {
    if (pickStatsCache !== null) {
        return pickStatsCache;
    }

    try {
        const stats = JSON.parse(localStorage.getItem(PICK_STATS_KEY) || '[]');

        pickStatsCache = Array.isArray(stats) ? stats : [];
    } catch {
        pickStatsCache = [];
    }

    return pickStatsCache;
}

function savePickStat(errorCents) {
    const stats = loadPickStats();

    stats.push({
        dateTime: new Date().toISOString(),

        targetHz: selectedNoteFrequency(
            document.querySelector('[data-note="pick"]')
        ),

        errorCents,
    });

    if (stats.length > 500) {
        stats.splice(0, stats.length - 500);
    }

    try {
        localStorage.setItem(PICK_STATS_KEY, JSON.stringify(stats));
    } catch {
        // Persistence is optional; keep the exercise usable without storage.
    }
}

function clearPickStats() {
    loadPickStats().length = 0;

    try {
        localStorage.removeItem(PICK_STATS_KEY);
    } catch {
        // Persistence is optional; still refresh the visible stats.
    }

    renderPickStats();
}

function currentPickStreak(stats) {
    let streak = 0;

    for (let index = stats.length - 1; index >= 0; index -= 1) {
        if (Math.abs(Number(stats[index].errorCents)) >= 0.000001) {
            break;
        }

        streak += 1;
    }

    return streak;
}

function renderPickStats() {
    const stats = loadPickStats();

    const errorTotal = stats.reduce(
        (total, stat) => total + Math.abs(Number(stat.errorCents)),
        0
    );

    const meanError = stats.length > 0 ? errorTotal / stats.length : 0;

    document.querySelector('[data-output="pick-streak"]').textContent = String(
        currentPickStreak(stats)
    );

    document.querySelector('[data-output="pick-mean-error"]').textContent =
        `${meanError.toFixed(1)} cents`;
}

function commitPick(index) {
    if (pick.committed) {
        return;
    }

    const selected = pick.candidates[index];

    const target = pick.candidates.find((candidate) => candidate.isTarget);

    if (!selected || !target) {
        return;
    }

    audio.stopTransient();

    pick.committed = true;
    pick.selectedIndex = index;

    savePickStat(centsBetween(selected.frequencyHz, target.frequencyHz));

    renderCandidates();
    renderPickStats();
    updateAdaptiveDifficulty('pick', selected.isTarget);

    const targetIndex = pick.candidates.indexOf(target);
    const status = document.querySelector('[data-output="pick-status"]');
    const newPickButton = document.querySelector('[data-action="new-pick"]');

    newPickButton?.focus();

    status.textContent = selected.isTarget
        ? `Correct. Candidate ${index + 1} matched the target.`
        : `Incorrect. Candidate ${index + 1} selected; ` +
          `candidate ${targetIndex + 1} was the target.`;
}

// Events

function resetForReferenceChange() {
    stopGeneratedAudio();
    cancelPlacementAdvance();

    resetTunerTracking(true);

    updateNoteReadouts();

    newPlacementTrial();
    newPickSet();
}

function initializeEvents() {
    document
        .querySelector('[data-note="tuner"]')
        .addEventListener('change', (event) => {
            updateNoteReadout(event.currentTarget);

            if (tunerVoice) {
                tunerVoice.setFrequency(
                    selectedNoteFrequency(event.currentTarget)
                );
            }
        });

    document
        .querySelector('[data-control="metronome-time-signature"]')
        .addEventListener('change', () => {
            metronome.beatIndex = 0;

            if (metronome.running) {
                audio.stopTransient();
                metronome.nextBeatTime = audio.currentTime() + 0.05;
            }
        });

    document
        .querySelector('[data-action="play-metronome"]')
        .addEventListener('click', startMetronome);

    document
        .querySelector('[data-action="tap-tempo"]')
        .addEventListener('click', tapTempo);

    document
        .querySelector('[data-note="placement"]')
        .addEventListener('change', (event) => {
            updateNoteReadout(event.currentTarget);

            newPlacementTrial();
        });

    document
        .querySelector('[data-note="pick"]')
        .addEventListener('change', (event) => {
            updateNoteReadout(event.currentTarget);

            newPickSet();
        });

    for (const control of document.querySelectorAll(
        '[data-control="placement-range-min"], [data-control="placement-range-max"], [data-control="placement-interval"]'
    )) {
        control.addEventListener('change', () => {
            resetAdaptiveProgress('placement');
            newPlacementTrial();
        });
    }

    for (const control of document.querySelectorAll(
        '[data-control="pick-range-min"], [data-control="pick-range-max"], [data-control="pick-count"]'
    )) {
        control.addEventListener('change', () => {
            resetAdaptiveProgress('pick');
            newPickSet();
        });
    }

    for (const exercise of ['placement', 'pick']) {
        document
            .querySelector(`[data-control="${exercise}-adaptive"]`)
            .addEventListener('change', () => {
                resetAdaptiveProgress(exercise);
            });
    }

    document
        .querySelector('[data-control="volume"]')
        .addEventListener('input', updateVolume);

    const a4Input = document.querySelector('[data-control="a4"]');

    a4Input.addEventListener('input', resetForReferenceChange);
    a4Input.addEventListener('change', () => {
        normalizeNumberInput(a4Input, DEFAULT_A4);
        resetForReferenceChange();
    });

    document
        .querySelector('[data-control="placement-duration"]')
        .addEventListener('change', (event) => {
            normalizeNumberInput(event.currentTarget, 1);
        });

    document
        .querySelector('[data-control="pick-duration"]')
        .addEventListener('change', (event) => {
            normalizeNumberInput(event.currentTarget, 1);
        });

    document
        .querySelector('[data-action="reset-a4"]')
        .addEventListener('click', () => {
            document.querySelector('[data-control="a4"]').value =
                DEFAULT_A4.toFixed(3);

            resetForReferenceChange();
        });

    document
        .querySelector('[data-action="play-tuner"]')
        .addEventListener('click', playTuner);

    document
        .querySelector('[data-action="toggle-tuner-mic"]')
        .addEventListener('click', toggleMicTuner);

    document
        .querySelector('[data-action="play-placement"]')
        .addEventListener('click', playPlacementTrial);

    document
        .querySelector('[data-action="new-placement"]')
        .addEventListener('click', () => {
            newPlacementTrial(true);
        });

    document
        .querySelector('[data-action="new-pick"]')
        .addEventListener('click', newPickSet);

    for (const button of document.querySelectorAll('[data-judgment]')) {
        button.addEventListener('click', () => {
            commitPlacement(button.dataset.judgment);
        });
    }

    for (const button of document.querySelectorAll(
        '[data-action="stop-audio"]'
    )) {
        button.addEventListener('click', () => {
            stopAllAudio();
            cancelPlacementAdvance();
        });
    }

    for (const waveform of document.querySelectorAll('.waveform-select')) {
        waveform.addEventListener('change', stopGeneratedAudio);
    }

    document
        .querySelector('[data-candidates]')
        .addEventListener('click', (event) => {
            const button = event.target.closest('button[data-action]');

            const row = button?.closest('.candidate-row');

            if (!button || !row) {
                return;
            }

            const index = Number(row.dataset.index);

            if (button.dataset.action === 'play-candidate') {
                playCandidate(index);
                return;
            }

            if (button.dataset.action === 'choose-candidate') {
                commitPick(index);
            }
        });

    document
        .querySelector('[data-action="clear-placement-stats"]')
        .addEventListener('click', clearPlacementStats);

    document
        .querySelector('[data-action="clear-pick-stats"]')
        .addEventListener('click', clearPickStats);
}

// Initialization

function initialize() {
    initializeTabs();
    initializeNotes();

    updateNoteReadouts();

    resetTunerDetection();

    clearPlacementResult();
    renderPlacementStats();

    newPlacementTrial();
    newPickSet();

    renderPickStats();

    initializeEvents();
}

initialize();

window.addEventListener('beforeunload', () => {
    stopAllAudio();
    cancelPlacementAdvance();
});
