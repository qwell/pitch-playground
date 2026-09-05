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

const PICK_STATS_KEY = '440Lab.pickStats.v7';
const PLACEMENT_STATS_KEY = '440Lab.placementStats.v1';
const CHORD_STATS_KEY = '440Lab.chordStats.v1';
const PITCH_MEMORY_RESULTS_KEY = '440Lab.pitchMemoryResults.v1';
const PITCH_MEMORY_TRIAL_KEY = '440Lab.pitchMemoryTrial.v1';
const PITCH_MEMORY_MIN_HZ = 200;
const PITCH_MEMORY_MAX_HZ = 900;
const PITCH_MEMORY_CORRECT_CENTS = 50;
const PITCH_MEMORY_RANGE_CENTS =
    1200 * Math.log2(PITCH_MEMORY_MAX_HZ / PITCH_MEMORY_MIN_HZ);
const TRIAL_ADVANCE_DELAY = 3000;
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

const CHORD_QUALITIES = {
    major: [0, 4, 7],
    minor: [0, 3, 7],
    diminished: [0, 3, 6],
    augmented: [0, 4, 8],
};

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
    return readNumber(getControl('a4'), DEFAULT_A4);
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

function getControl(name, root = document) {
    return root.querySelector(`[data-control="${name}"]`);
}

function getControls(...names) {
    return names.map((name) => getControl(name));
}

function getOutput(name, root = document) {
    return root.querySelector(`[data-output="${name}"]`);
}

function getAction(name, root = document) {
    return root.querySelector(`[data-action="${name}"]`);
}

function getActions(name, root = document) {
    return root.querySelectorAll(`[data-action="${name}"]`);
}

function getNote(name) {
    return document.querySelector(`[data-note="${name}"]`);
}

function getWaveform(name) {
    return document.querySelector(`[data-waveform="${name}"]`);
}

const storage = {
    load(key, fallback) {
        try {
            let serialized = localStorage.getItem(key);

            if (serialized === null) {
                const suffix = key.slice(key.indexOf('.'));
                const previousKey = Object.keys(localStorage).find(
                    (candidate) =>
                        candidate !== key && candidate.endsWith(suffix)
                );

                if (previousKey) {
                    serialized = localStorage.getItem(previousKey);
                    localStorage.setItem(key, serialized);
                }
            }

            const value = JSON.parse(serialized || 'null');

            return value === null ? fallback : value;
        } catch {
            return fallback;
        }
    },

    save(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {
            // Storage is optional.
        }
    },

    remove(key) {
        try {
            localStorage.removeItem(key);
        } catch {
            // Storage is optional.
        }
    },
};

function createAutoAdvance(refreshSelector, advance) {
    let timer = null;

    function cancel() {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }

        document
            .querySelector(refreshSelector)
            .classList.remove('is-counting-down');
    }

    function schedule() {
        cancel();

        const refreshButton = document.querySelector(refreshSelector);

        void refreshButton.offsetWidth;
        refreshButton.classList.add('is-counting-down');

        timer = window.setTimeout(() => {
            timer = null;
            refreshButton.classList.remove('is-counting-down');
            advance();
        }, TRIAL_ADVANCE_DELAY);
    }

    return { cancel, schedule };
}

function clearPracticeResult(outputName) {
    const result = getOutput(outputName);

    result.classList.remove('is-correct', 'is-incorrect');
    result.replaceChildren();
}

function renderPracticeResult(outputName, correct, text) {
    const result = getOutput(outputName);
    const icon = document.createElement('strong');

    result.classList.add(correct ? 'is-correct' : 'is-incorrect');
    icon.textContent = correct ? '✓' : '✕';
    result.replaceChildren(icon, document.createTextNode(` ${text}`));
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

async function startMicrophoneInput(input, fftSize) {
    if (input.stream) {
        return false;
    }

    const requestId = ++input.requestId;
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
    });

    if (requestId !== input.requestId) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
    }

    const connection = audio.createAnalyser(stream, fftSize);

    input.stream = stream;
    input.source = connection.source;
    input.analyser = connection.analyser;
    input.sampleRate = connection.sampleRate;
    input.buffer = new Float32Array(input.analyser.fftSize);

    return true;
}

function stopMicrophoneInput(input) {
    input.requestId += 1;

    if (input.source) {
        input.source.disconnect();
        input.source = null;
    }

    if (input.stream) {
        input.stream.getTracks().forEach((track) => track.stop());
        input.stream = null;
    }

    input.analyser = null;
    input.sampleRate = 0;
    input.buffer = null;
}

let masterVolume = DEFAULT_VOLUME;

function updateVolume() {
    const input = getControl('volume');

    const volume = clamp(Number(input.value), 0, 1);

    getOutput('volume-percent').textContent = `${Math.round(volume * 100)}%`;

    audio.setMasterVolume(volume);
}

let tunerVoice = null;

function playTuner() {
    stopGeneratedAudio();

    tunerVoice = audio.playContinuous(
        selectedNoteFrequency(getNote('tuner')),
        getWaveform('tuner').value
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
    stopPitchMemoryMic();
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

function activateTab(button, focus = false, updateUrl = true) {
    const tabName = button.dataset.tab;
    const sectionPicker = document.querySelector(
        '[data-control="section-picker"]'
    );

    if (
        tabName !== 'pitch-memory' &&
        pitchMemory.trial?.state === 'waiting' &&
        (pitchMemory.trial.test === 'interference' ||
            Date.now() < pitchMemory.trial.encodingEndsAt)
    ) {
        cancelPitchMemoryTrial();
    }

    for (const tab of document.querySelectorAll('.tab')) {
        const active = tab === button;

        tab.classList.toggle('is-active', active);

        tab.setAttribute('aria-selected', String(active));

        tab.tabIndex = active ? 0 : -1;
    }

    for (const panel of document.querySelectorAll('.tab-panel')) {
        panel.hidden = panel.dataset.panel !== tabName;
    }

    sectionPicker.value = tabName;

    stopAllAudio();
    cancelPlacementAdvance();
    cancelPickAdvance();
    cancelChordAdvance();

    if (updateUrl && window.location.hash !== `#${tabName}`) {
        history.pushState(null, '', `#${tabName}`);
    }

    if (focus) {
        button.focus();
    }
}

function initializeTabs() {
    const tabs = [...document.querySelectorAll('.tab')];
    const tabNavigation = document.querySelector('.tabs');
    const tabList = document.querySelector('.tabs-inner');
    const sectionPicker = document.querySelector(
        '[data-control="section-picker"]'
    );
    const requiredTabWidth = tabList.scrollWidth;

    const resizeObserver = new ResizeObserver(([entry]) => {
        const pageGutters = window.matchMedia('(max-width: 560px)').matches
            ? 16
            : 28;

        tabNavigation.classList.toggle(
            'is-overflowing',
            entry.contentRect.width - pageGutters < requiredTabWidth
        );
    });

    resizeObserver.observe(tabNavigation);

    function activateHashTab() {
        const hash = window.location.hash.slice(1);
        const tab =
            tabs.find((candidate) => candidate.dataset.tab === hash) ||
            (hash === '' ? tabs[0] : null);

        if (tab && !tab.classList.contains('is-active')) {
            activateTab(tab, false, false);
        }
    }

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

    sectionPicker.addEventListener('change', () => {
        const tab = tabs.find(
            (candidate) => candidate.dataset.tab === sectionPicker.value
        );

        if (tab) {
            activateTab(tab);
        }
    });

    window.addEventListener('hashchange', activateHashTab);
    window.addEventListener('popstate', activateHashTab);

    activateHashTab();
}

function initializeTooltips() {
    function keepInsideViewport(event) {
        const tip = event.currentTarget;
        const style = getComputedStyle(tip, '::after');
        const tooltipWidth =
            parseFloat(style.width) +
            parseFloat(style.paddingLeft) +
            parseFloat(style.paddingRight) +
            parseFloat(style.borderLeftWidth) +
            parseFloat(style.borderRightWidth);
        const tipBounds = tip.getBoundingClientRect();
        const center = tipBounds.left + tipBounds.width / 2;
        const centeredLeft = center - tooltipWidth / 2;
        const viewportWidth = document.documentElement.clientWidth;
        const boundedLeft = clamp(
            centeredLeft,
            12,
            Math.max(12, viewportWidth - tooltipWidth - 12)
        );

        tip.style.setProperty(
            '--tooltip-shift-x',
            `${boundedLeft - centeredLeft}px`
        );
    }

    for (const tip of document.querySelectorAll('.info-tip')) {
        tip.addEventListener('pointerenter', keepInsideViewport);
        tip.addEventListener('focus', keepInsideViewport);
    }
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
    getOutput('tuner-status').textContent = text;
}

function setTunerMicButtonActive(active) {
    const button = getAction('toggle-tuner-mic');

    button.classList.toggle('is-active', active);

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
    getOutput('tuner-closest').textContent = '--';

    getOutput('tuner-target').textContent = '-- Hz';

    getOutput('tuner-detected').textContent = '-- Hz detected';

    getOutput('tuner-cents').textContent = '--';

    const needle = getOutput('tuner-needle');
    needle.classList.remove('is-visible', 'is-in-tune');

    setTunerStatus(status);
}

function stopMicTuner() {
    if (tunerMic.frame !== null) {
        cancelAnimationFrame(tunerMic.frame);

        tunerMic.frame = null;
    }

    stopMicrophoneInput(tunerMic);

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

    getOutput('tuner-closest').textContent = nearest.name;

    getOutput('tuner-target').textContent = `${nearest.targetHz.toFixed(3)} Hz`;

    getOutput('tuner-detected').textContent =
        `${frequencyHz.toFixed(3)} Hz detected`;

    getOutput('tuner-cents').textContent = `${signed(cents, 1)} cents`;

    const inTune = Math.abs(cents) <= 3;

    const needle = getOutput('tuner-needle');
    needle.style.left = `${percent}%`;
    needle.classList.add('is-visible');
    needle.classList.toggle('is-in-tune', inTune);
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

    resetTunerDetection('Requesting microphone access...');

    try {
        if (!(await startMicrophoneInput(tunerMic, 2048))) {
            return;
        }

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

    const bpm = readNumber(getControl('metronome-bpm'), 100);

    const signature = getControl('metronome-time-signature').value;

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

    const bpmInput = getControl('metronome-bpm');

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
    const stored = storage.load(PLACEMENT_STATS_KEY, null);

    if (!stored || typeof stored !== 'object') {
        return defaultPlacementStats();
    }

    return {
        streak: Number.isFinite(stored.streak) ? stored.streak : 0,
        trials: Number.isFinite(stored.trials) ? stored.trials : 0,
        errorTotal: Number.isFinite(stored.errorTotal) ? stored.errorTotal : 0,
        best: Number.isFinite(stored.best) ? stored.best : null,
    };
}

function savePlacementStats() {
    storage.save(PLACEMENT_STATS_KEY, placement.stats);
}

const placement = {
    trial: null,
    stats: loadPlacementStats(),
    adaptiveResults: [],
};

const placementAdvance = createAutoAdvance('.placement-refresh', () => {
    newPlacementTrial(true);
});

function cancelPlacementAdvance() {
    placementAdvance.cancel();
}

function schedulePlacementAdvance() {
    placementAdvance.schedule();
}

function renderPlacementStats() {
    const { streak, trials, errorTotal, best } = placement.stats;

    const meanError = trials > 0 ? errorTotal / trials : 0;

    getOutput('placement-streak').textContent = String(streak);

    getOutput('placement-mean-error').textContent =
        `${meanError.toFixed(1)} cents`;

    getOutput('placement-best').textContent =
        best === null ? '--' : `${best.toFixed(2)} cents`;
}

function clearPlacementStats() {
    placement.stats = defaultPlacementStats();

    storage.remove(PLACEMENT_STATS_KEY);

    renderPlacementStats();
}

function setJudgmentState({ disabled, selected = null, correct = null }) {
    for (const button of document.querySelectorAll(
        '.placement-judgment .answer-option'
    )) {
        button.disabled = disabled;

        button.classList.remove('is-correct', 'is-incorrect', 'is-target');

        if (selected === null) {
            continue;
        }

        const judgment = button.dataset.answer;

        if (selected === correct && judgment === selected) {
            button.classList.add('is-correct');

            continue;
        }

        if (judgment === selected) {
            button.classList.add('is-incorrect');
        }

        if (selected !== correct && judgment === correct) {
            button.classList.add('is-target');
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
    const enabled = getControl(`${exercise}-adaptive`).value === 'on';
    const state = exercise === 'placement' ? placement : pick;
    const status = getOutput(`${exercise}-adaptive-status`);

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

    const minimumInput = getControl(`${exercise}-range-min`);
    const maximumInput = getControl(`${exercise}-range-max`);
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
    const enabled = getControl(`${exercise}-adaptive`).value === 'on';

    state.adaptiveResults.length = 0;
    getOutput(`${exercise}-adaptive-status`).textContent = enabled
        ? `0 of ${ADAPTIVE_WINDOW_SIZE} answers`
        : '';
}

function clearPlacementResult() {
    clearPracticeResult('placement-result');
}

function createPlacementTrial() {
    const rootHz = selectedNoteFrequency(getNote('placement'));

    const semitones = Number(getControl('placement-interval').value);

    const { minimum: minimumCents, maximum: maximumCents } = readRange(
        getControl('placement-range-min'),
        getControl('placement-range-max'),
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

    const waveform = getWaveform('placement').value;

    const duration = readNumber(getControl('placement-duration'), 1);

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

    renderPracticeResult(
        'placement-result',
        correct,
        `${direction} · ` +
            `${signed(trial.mistuneCents, 2)} cents ` +
            `(${signed(errorHz, 3)} Hz)`
    );

    schedulePlacementAdvance();
}

// Pitch memory

const pitchMemory = {
    trial: storage.load(PITCH_MEMORY_TRIAL_KEY, null),
    results: storage.load(PITCH_MEMORY_RESULTS_KEY, []),
    timer: null,
    countdown: null,
    replayTimer: null,
    responseVoice: null,
    mic: {
        stream: null,
        source: null,
        analyser: null,
        sampleRate: 0,
        buffer: null,
        frame: null,
        lastAnalysis: 0,
        frequencies: [],
        detectedHz: null,
        requestId: 0,
    },
};

if (!Array.isArray(pitchMemory.results)) {
    pitchMemory.results = [];
}

function savePitchMemoryState() {
    storage.save(PITCH_MEMORY_RESULTS_KEY, pitchMemory.results);

    if (pitchMemory.trial) {
        storage.save(PITCH_MEMORY_TRIAL_KEY, pitchMemory.trial);
    } else {
        storage.remove(PITCH_MEMORY_TRIAL_KEY);
    }
}

function randomSeed() {
    if (window.crypto?.getRandomValues) {
        const values = new Uint32Array(1);

        window.crypto.getRandomValues(values);

        return values[0];
    }

    return Math.floor(Math.random() * 0x100000000);
}

function seededRandom(seed) {
    let state = seed >>> 0;

    return () => {
        state += 0x6d2b79f5;

        let value = state;

        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

        return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
    };
}

function randomPitchMemoryFrequency(random = Math.random) {
    return (
        PITCH_MEMORY_MIN_HZ *
        (PITCH_MEMORY_MAX_HZ / PITCH_MEMORY_MIN_HZ) ** random()
    );
}

function getPitchMemoryFrequencyFromSlider() {
    const cents = Number(getControl('pitch-memory-frequency').value);

    return PITCH_MEMORY_MIN_HZ * 2 ** (cents / 1200);
}

function renderPitchMemoryResponseFrequency() {
    getOutput('pitch-memory-response-frequency').textContent =
        `${getPitchMemoryFrequencyFromSlider().toFixed(3)} Hz`;
}

function clearPitchMemoryFrequencyMarkers() {
    getControl('pitch-memory-frequency').classList.remove('has-result');

    for (const name of [
        'pitch-memory-target-marker',
        'pitch-memory-response-marker',
    ]) {
        const marker = getOutput(name);

        marker.hidden = true;
        marker.classList.remove('is-correct');
    }
}

function showPitchMemoryFrequencyMarkers(result) {
    const targetMarker = getOutput('pitch-memory-target-marker');
    const responseMarker = getOutput('pitch-memory-response-marker');
    const position = (frequency) =>
        clamp(
            Math.log2(frequency / PITCH_MEMORY_MIN_HZ) /
                Math.log2(PITCH_MEMORY_MAX_HZ / PITCH_MEMORY_MIN_HZ),
            0,
            1
        );

    targetMarker.style.left = `${position(result.targetHz) * 100}%`;
    responseMarker.style.left = `${position(result.responseHz) * 100}%`;
    responseMarker.classList.toggle(
        'is-correct',
        result.absoluteErrorCents < PITCH_MEMORY_CORRECT_CENTS
    );
    getControl('pitch-memory-frequency').classList.add('has-result');
    targetMarker.hidden = false;
    responseMarker.hidden = false;
}

function setPitchMemoryStatus(text) {
    getOutput('pitch-memory-status').textContent = text;
}

function clearPitchMemoryTimers() {
    if (pitchMemory.timer !== null) {
        clearTimeout(pitchMemory.timer);
        pitchMemory.timer = null;
    }

    if (pitchMemory.countdown !== null) {
        clearInterval(pitchMemory.countdown);
        pitchMemory.countdown = null;
    }
}

function stopPitchMemoryResponseTone() {
    if (pitchMemory.responseVoice) {
        pitchMemory.responseVoice.stop();
        pitchMemory.responseVoice = null;
    }
}

function setPitchMemoryMicActive(active) {
    const button = getAction('toggle-pitch-memory-mic');

    if (!button) {
        return;
    }

    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('is-active', active);
    button.textContent = active ? 'Stop microphone' : 'Start microphone';
}

function stopPitchMemoryMic() {
    if (!pitchMemory?.mic) {
        return;
    }

    const mic = pitchMemory.mic;

    if (mic.frame !== null) {
        cancelAnimationFrame(mic.frame);
        mic.frame = null;
    }

    stopMicrophoneInput(mic);
    mic.frequencies = [];

    setPitchMemoryMicActive(false);
}

function analyzePitchMemoryMic(time) {
    const mic = pitchMemory.mic;

    if (!mic.analyser || !mic.buffer) {
        return;
    }

    if (time - mic.lastAnalysis >= TUNER_ANALYSIS_INTERVAL_MS) {
        mic.lastAnalysis = time;
        mic.analyser.getFloatTimeDomainData(mic.buffer);

        const frequencyHz = detectPitchYin(
            mic.buffer,
            mic.sampleRate,
            80,
            1400
        );

        if (frequencyHz !== null) {
            mic.frequencies.push(frequencyHz);

            if (mic.frequencies.length > 9) {
                mic.frequencies.shift();
            }

            mic.detectedHz = median(mic.frequencies);

            getOutput('pitch-memory-detected-frequency').textContent =
                `${mic.detectedHz.toFixed(3)} Hz detected`;
            const response = document.querySelector(
                '.pitch-memory-microphone-response'
            );

            getAction('submit-pitch-memory', response).disabled =
                mic.frequencies.length < 5;
        }
    }

    mic.frame = requestAnimationFrame(analyzePitchMemoryMic);
}

async function startPitchMemoryMic() {
    if (!navigator.mediaDevices?.getUserMedia) {
        setPitchMemoryStatus('Microphone access unavailable.');
        return;
    }

    stopGeneratedAudio();
    stopMicTuner();

    const mic = pitchMemory.mic;

    setPitchMemoryStatus('Requesting microphone access...');

    try {
        if (!(await startMicrophoneInput(mic, 4096))) {
            return;
        }

        mic.lastAnalysis = 0;
        mic.frequencies = [];
        mic.detectedHz = null;

        getOutput('pitch-memory-detected-frequency').textContent =
            'Sing or hum a steady pitch';
        setPitchMemoryStatus('Listening for a stable pitch.');
        setPitchMemoryMicActive(true);
        mic.frame = requestAnimationFrame(analyzePitchMemoryMic);
    } catch (error) {
        setPitchMemoryStatus(
            error?.name === 'NotAllowedError'
                ? 'Microphone permission denied.'
                : 'Could not start microphone.'
        );
    }
}

function togglePitchMemoryMic() {
    if (pitchMemory.mic.stream) {
        stopPitchMemoryMic();
        setPitchMemoryStatus('Microphone stopped.');
        return;
    }

    void startPitchMemoryMic();
}

function getPitchMemoryCondition() {
    const test = getControl('pitch-memory-test').value;

    return test === 'novel'
        ? `${getControl('pitch-memory-delay').value}s delay`
        : `${getControl('pitch-memory-distractors').value} distractors`;
}

function resultMatchesCurrentCondition(result) {
    return (
        result.test === getControl('pitch-memory-test').value &&
        result.method === getControl('pitch-memory-response').value &&
        result.condition === getPitchMemoryCondition()
    );
}

function renderPitchMemoryReport() {
    const results = pitchMemory.results.filter(resultMatchesCurrentCondition);
    const errors = results.map((result) => Math.abs(result.errorCents));
    const meanError =
        errors.length > 0
            ? errors.reduce((total, error) => total + error, 0) / errors.length
            : null;
    let streak = 0;

    for (let index = errors.length - 1; index >= 0; index -= 1) {
        if (errors[index] >= PITCH_MEMORY_CORRECT_CENTS) {
            break;
        }

        streak += 1;
    }

    getOutput('pitch-memory-streak').textContent = String(streak);
    getOutput('pitch-memory-mean-error').textContent =
        meanError === null ? '--' : `${meanError.toFixed(1)} cents`;
}

function showPitchMemoryResponse() {
    if (!pitchMemory.trial || pitchMemory.trial.state === 'responding') {
        return;
    }

    clearPitchMemoryTimers();
    audio.stopTransient();

    pitchMemory.trial.state = 'responding';
    pitchMemory.trial.responseStartedAt = Date.now();

    const oscillator =
        pitchMemory.trial.method === 'oscillator'
            ? document.querySelector('.pitch-memory-oscillator-response')
            : document.querySelector('.pitch-memory-microphone-response');

    document.querySelector('.pitch-memory-oscillator-response').hidden = true;
    document.querySelector('.pitch-memory-microphone-response').hidden = true;
    oscillator.hidden = false;

    if (pitchMemory.trial.method === 'oscillator') {
        const random = seededRandom(pitchMemory.trial.seed ^ 0xa55a5aa5);
        const targetCents =
            1200 * Math.log2(pitchMemory.trial.targetHz / PITCH_MEMORY_MIN_HZ);
        const direction = random() < 0.5 ? -1 : 1;
        const offset = direction * (300 + random() * 900);

        getControl('pitch-memory-frequency').value = String(
            clamp(targetCents + offset, 0, PITCH_MEMORY_RANGE_CENTS)
        );
        renderPitchMemoryResponseFrequency();
        clearPitchMemoryFrequencyMarkers();
        getAction('play-pitch-memory-response').disabled = false;
        getAction('stop-pitch-memory-response').disabled = false;
        getAction('submit-pitch-memory', oscillator).disabled = false;
        setPitchMemoryStatus(
            'Adjust the tone to the frequency you remember, then submit.'
        );
    } else {
        pitchMemory.mic.detectedHz = null;
        getOutput('pitch-memory-detected-frequency').textContent =
            'No stable pitch';
        getAction(
            'submit-pitch-memory',
            document.querySelector('.pitch-memory-microphone-response')
        ).disabled = true;
        setPitchMemoryStatus('Produce the remembered pitch, then submit.');
    }

    savePitchMemoryState();
}

function renderPitchMemoryCountdown() {
    if (!pitchMemory.trial || pitchMemory.trial.state !== 'waiting') {
        return;
    }

    const remaining = Math.max(0, pitchMemory.trial.availableAt - Date.now());

    if (remaining <= 0) {
        showPitchMemoryResponse();
        return;
    }

    const seconds = Math.ceil(remaining / 1000);
    const display =
        seconds < 60
            ? `${seconds} second${seconds === 1 ? '' : 's'}`
            : `${Math.ceil(seconds / 60)} minute${seconds <= 60 ? '' : 's'}`;

    setPitchMemoryStatus(
        `Recall opens in ${display}. Do not use a pitch reference.`
    );
}

function schedulePitchMemoryResponse() {
    clearPitchMemoryTimers();
    renderPitchMemoryCountdown();

    if (!pitchMemory.trial || pitchMemory.trial.state !== 'waiting') {
        return;
    }

    const remaining = Math.max(0, pitchMemory.trial.availableAt - Date.now());

    pitchMemory.timer = window.setTimeout(showPitchMemoryResponse, remaining);
    pitchMemory.countdown = window.setInterval(
        renderPitchMemoryCountdown,
        1000
    );
}

function playInterferenceSequence(random, count) {
    for (let index = 0; index < count; index += 1) {
        let frequencyHz = randomPitchMemoryFrequency(random);

        while (
            Math.abs(centsBetween(frequencyHz, pitchMemory.trial.targetHz)) <
            200
        ) {
            frequencyHz = randomPitchMemoryFrequency(random);
        }

        audio.playTransient(
            frequencyHz,
            'sine',
            0.12,
            0.7,
            1.45 + index * 0.18
        );
    }
}

function playNovelPitchMemoryMelody(random, startingHz) {
    const intervals = [0];
    let semitones = 0;

    for (let index = 1; index < 8; index += 1) {
        const steps = [-5, -3, -2, 2, 3, 5];
        const step = steps[Math.floor(random() * steps.length)];

        semitones = clamp(semitones + step, -7, 12);
        intervals.push(semitones);
    }

    intervals.forEach((interval, index) => {
        audio.playTransient(
            startingHz * 2 ** (interval / 12),
            'sine',
            0.3,
            0.75,
            index * 0.38
        );
    });
}

function setPitchMemoryReplayEnabled(enabled) {
    getAction('start-pitch-memory').disabled = !enabled;
}

function playPitchMemoryStimulus() {
    if (
        !pitchMemory.trial ||
        pitchMemory.trial.state === 'complete' ||
        pitchMemory.trial.stimulusPlayed
    ) {
        return;
    }

    audio.stopTransient();

    const random = seededRandom(pitchMemory.trial.seed);
    const startedAt = Date.now();
    const conditionValue = Number.parseInt(pitchMemory.trial.condition, 10);
    const sequenceSeconds = 1.45 + conditionValue * 0.18;

    pitchMemory.trial.state = 'waiting';
    pitchMemory.trial.encodedAt = startedAt;
    pitchMemory.trial.encodingEndsAt =
        startedAt + (pitchMemory.trial.test === 'novel' ? 3000 : 1200);
    pitchMemory.trial.availableAt =
        startedAt +
        (pitchMemory.trial.test === 'novel'
            ? conditionValue + 3
            : sequenceSeconds) *
            1000;
    getAction('stop-pitch-memory').disabled = false;

    // Consume the value originally used to select targetHz.
    randomPitchMemoryFrequency(random);

    if (pitchMemory.trial.test === 'novel') {
        playNovelPitchMemoryMelody(random, pitchMemory.trial.targetHz);
    } else {
        audio.playTransient(pitchMemory.trial.targetHz, 'sine', 1.2, 0.8);
        playInterferenceSequence(random, conditionValue);
    }

    const trialSeed = pitchMemory.trial.seed;
    const playbackSeconds =
        pitchMemory.trial.test === 'novel'
            ? 3
            : Math.max(1.2, 1.45 + conditionValue * 0.18);

    if (pitchMemory.replayTimer !== null) {
        clearTimeout(pitchMemory.replayTimer);
    }

    pitchMemory.replayTimer = window.setTimeout(() => {
        pitchMemory.replayTimer = null;

        if (pitchMemory.trial?.seed !== trialSeed) {
            return;
        }

        pitchMemory.trial.stimulusPlayed = true;
        setPitchMemoryReplayEnabled(false);
        getAction('stop-pitch-memory').disabled = true;
        savePitchMemoryState();
    }, playbackSeconds * 1000);

    savePitchMemoryState();
    schedulePitchMemoryResponse();
}

function startPitchMemoryTrial() {
    cancelPitchMemoryTrial(false);
    getControl('pitch-memory-frequency').disabled = false;

    const test = getControl('pitch-memory-test').value;
    const method = getControl('pitch-memory-response').value;
    const seed = randomSeed();
    const random = seededRandom(seed);
    const distractors = Number(getControl('pitch-memory-distractors').value);
    const delaySeconds = Number(getControl('pitch-memory-delay').value);
    const sequenceSeconds = 1.45 + distractors * 0.18;

    pitchMemory.trial = {
        test,
        method,
        condition:
            test === 'novel'
                ? `${delaySeconds}s delay`
                : `${distractors} distractors`,
        targetHz: randomPitchMemoryFrequency(random),
        seed,
        encodedAt: Date.now(),
        encodingEndsAt: Date.now() + (test === 'novel' ? 3000 : 1200),
        availableAt:
            Date.now() +
            (test === 'novel' ? delaySeconds + 3 : sequenceSeconds) * 1000,
        state: 'waiting',
        stimulusPlayed: false,
    };

    document.querySelector('.pitch-memory-oscillator-response').hidden = true;
    document.querySelector('.pitch-memory-microphone-response').hidden = true;
    clearPitchMemoryFrequencyMarkers();
    getOutput('pitch-memory-result').textContent = '';
    setPitchMemoryReplayEnabled(true);
    getAction('stop-pitch-memory').disabled = false;

    playPitchMemoryStimulus();
}

function cancelPitchMemoryTrial(showStatus = true) {
    clearPitchMemoryTimers();

    if (pitchMemory.replayTimer !== null) {
        clearTimeout(pitchMemory.replayTimer);
        pitchMemory.replayTimer = null;
    }

    stopPitchMemoryResponseTone();
    stopPitchMemoryMic();
    audio.stopTransient();

    pitchMemory.trial = null;

    const startButton = getAction('start-pitch-memory');

    if (!startButton) {
        return;
    }

    startButton.disabled = true;
    getAction('stop-pitch-memory').disabled = true;
    document.querySelector('.pitch-memory-oscillator-response').hidden = true;
    document.querySelector('.pitch-memory-microphone-response').hidden = true;

    if (showStatus) {
        setPitchMemoryStatus('Trial cancelled.');
    }

    savePitchMemoryState();
}

function stopPitchMemoryAudio() {
    clearPitchMemoryTimers();
    audio.stopTransient();
    stopPitchMemoryResponseTone();
    stopPitchMemoryMic();

    if (pitchMemory.replayTimer !== null) {
        clearTimeout(pitchMemory.replayTimer);
        pitchMemory.replayTimer = null;
    }

    if (pitchMemory.trial?.state !== 'complete') {
        pitchMemory.trial.state = 'stopped';
        getAction('stop-pitch-memory').disabled = true;
        document.querySelector('.pitch-memory-oscillator-response').hidden =
            true;
        document.querySelector('.pitch-memory-microphone-response').hidden =
            true;
        setPitchMemoryStatus('Trial paused.');
        savePitchMemoryState();
    }
}

function playPitchMemoryResponse() {
    if (
        document.querySelector('.pitch-memory-oscillator-response').hidden ||
        !pitchMemory.trial ||
        pitchMemory.trial.state !== 'responding'
    ) {
        return;
    }

    stopPitchMemoryResponseTone();
    pitchMemory.responseVoice = audio.playContinuous(
        getPitchMemoryFrequencyFromSlider(),
        'sine',
        0.8
    );
}

function updatePitchMemoryResponseTone() {
    renderPitchMemoryResponseFrequency();
    pitchMemory.responseVoice?.setFrequency(
        getPitchMemoryFrequencyFromSlider()
    );
}

function submitPitchMemoryResponse() {
    if (!pitchMemory.trial || pitchMemory.trial.state !== 'responding') {
        return;
    }

    const responseHz =
        pitchMemory.trial.method === 'oscillator'
            ? getPitchMemoryFrequencyFromSlider()
            : pitchMemory.mic.detectedHz;

    if (!Number.isFinite(responseHz) || responseHz <= 0) {
        return;
    }

    const errorCents = centsBetween(responseHz, pitchMemory.trial.targetHz);
    const result = {
        timestamp: new Date().toISOString(),
        test: pitchMemory.trial.test,
        method: pitchMemory.trial.method,
        condition: pitchMemory.trial.condition,
        targetHz: pitchMemory.trial.targetHz,
        responseHz,
        errorCents,
        absoluteErrorCents: Math.abs(errorCents),
        responseTimeMs: Date.now() - pitchMemory.trial.responseStartedAt,
        waveform: 'sine',
        seed: pitchMemory.trial.seed,
    };

    pitchMemory.results.push(result);
    stopPitchMemoryResponseTone();
    stopPitchMemoryMic();

    getOutput('pitch-memory-result').textContent =
        `Target ${result.targetHz.toFixed(3)} Hz; response ${result.responseHz.toFixed(3)} Hz; error ${signed(result.errorCents, 1)} cents.`;

    if (pitchMemory.trial.method === 'oscillator') {
        showPitchMemoryFrequencyMarkers(result);
        getControl('pitch-memory-frequency').disabled = true;
        getAction('play-pitch-memory-response').disabled = true;
        getAction('stop-pitch-memory-response').disabled = true;
        getAction(
            'submit-pitch-memory',
            document.querySelector('.pitch-memory-oscillator-response')
        ).disabled = true;
    } else {
        getAction(
            'submit-pitch-memory',
            document.querySelector('.pitch-memory-microphone-response')
        ).disabled = true;
    }

    pitchMemory.trial.state = 'complete';
    setPitchMemoryReplayEnabled(false);
    getAction('stop-pitch-memory').disabled = true;

    savePitchMemoryState();
    renderPitchMemoryReport();
    setPitchMemoryStatus('Trial complete.');
}

function updatePitchMemoryControls() {
    const novel = getControl('pitch-memory-test').value === 'novel';

    document.querySelector('.pitch-memory-novel-control').hidden = !novel;
    document.querySelector('.pitch-memory-interference-control').hidden = novel;
    renderPitchMemoryReport();
}

function csvCell(value) {
    const text = String(value);

    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportPitchMemoryResults() {
    const fields = [
        'timestamp',
        'test',
        'method',
        'condition',
        'targetHz',
        'responseHz',
        'errorCents',
        'absoluteErrorCents',
        'responseTimeMs',
        'waveform',
        'seed',
    ];
    const rows = [
        fields.join(','),
        ...pitchMemory.results.map((result) =>
            fields.map((field) => csvCell(result[field])).join(',')
        ),
    ];
    const url = URL.createObjectURL(
        new Blob([`${rows.join('\n')}\n`], { type: 'text/csv;charset=utf-8' })
    );
    const link = document.createElement('a');

    link.href = url;
    link.download = 'pitch-memory-results.csv';
    link.click();
    URL.revokeObjectURL(url);
}

function clearPitchMemoryStats() {
    pitchMemory.results = [];
    savePitchMemoryState();
    renderPitchMemoryReport();
}

// Pick target

const pick = {
    candidates: [],
    committed: false,
    selectedIndex: null,
    adaptiveResults: [],
};

const pickAdvance = createAutoAdvance('.pick-refresh', newPickSet);

function cancelPickAdvance() {
    pickAdvance.cancel();
}

function schedulePickAdvance() {
    pickAdvance.schedule();
}

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
    cancelPickAdvance();
    stopAllAudio();

    const targetHz = selectedNoteFrequency(getNote('pick'));

    const { minimum: minimumCents, maximum: maximumCents } = readRange(
        getControl('pick-range-min'),
        getControl('pick-range-max'),
        10,
        50
    );

    const count = Math.round(readNumber(getControl('pick-count'), 7));

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

    getOutput('pick-status').textContent = '';

    renderCandidates();
}

function getCandidateResult(candidate, index) {
    if (!pick.committed) {
        return null;
    }

    if (candidate.isTarget && index === pick.selectedIndex) {
        return {
            icon: '✓',
            className: 'is-correct',
        };
    }

    if (index === pick.selectedIndex) {
        return {
            icon: '✕',
            className: 'is-incorrect',
        };
    }

    if (candidate.isTarget) {
        return {
            icon: '◎',
            className: 'is-target',
        };
    }

    return {
        icon: '',
        className: '',
    };
}

function createCandidateRow(candidate, index) {
    const row = document.createElement('div');

    row.className = 'pick-target-candidate-row';

    row.dataset.index = String(index);

    const actions = document.createElement('div');

    actions.className = 'pick-target-candidate-actions';

    const playButton = document.createElement('button');

    playButton.type = 'button';

    playButton.className = 'icon-button pick-target-candidate-play';

    playButton.dataset.action = 'play-candidate';

    playButton.setAttribute('aria-label', `Play candidate ${index + 1}`);

    playButton.title = `Play candidate ${index + 1}`;

    playButton.textContent = '▶';

    const chooseButton = document.createElement('button');

    chooseButton.type = 'button';

    chooseButton.className = 'pick-target-candidate-choose';

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

    details.className = 'pick-target-candidate-details';

    if (result.icon) {
        const icon = document.createElement('span');

        icon.className = 'pick-target-candidate-result-icon';

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

    document
        .querySelector('.pick-target-candidate-list')
        .replaceChildren(...rows);
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

        getWaveform('pick').value,

        readNumber(getControl('pick-duration'), 1)
    );

    if (pick.committed) {
        return;
    }

    const row = document.querySelector(
        `.pick-target-candidate-row[data-index="${index}"]`
    );

    const chooseButton = row ? getAction('choose-candidate', row) : null;

    if (chooseButton) {
        chooseButton.disabled = false;
    }
}

let pickStatsCache = null;

function loadPickStats() {
    if (pickStatsCache !== null) {
        return pickStatsCache;
    }

    const stats = storage.load(PICK_STATS_KEY, []);

    pickStatsCache = Array.isArray(stats) ? stats : [];

    return pickStatsCache;
}

function savePickStat(errorCents) {
    const stats = loadPickStats();

    stats.push({
        dateTime: new Date().toISOString(),

        targetHz: selectedNoteFrequency(getNote('pick')),

        errorCents,
    });

    if (stats.length > 500) {
        stats.splice(0, stats.length - 500);
    }

    storage.save(PICK_STATS_KEY, stats);
}

function clearPickStats() {
    loadPickStats().length = 0;

    storage.remove(PICK_STATS_KEY);

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

    getOutput('pick-streak').textContent = String(currentPickStreak(stats));

    getOutput('pick-mean-error').textContent = `${meanError.toFixed(1)} cents`;
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
    const status = getOutput('pick-status');
    const newPickButton = getAction('new-pick');

    newPickButton?.focus();

    status.textContent = selected.isTarget
        ? `Correct. Candidate ${index + 1} matched the target.`
        : `Incorrect. Candidate ${index + 1} selected; ` +
          `candidate ${targetIndex + 1} was the target.`;

    schedulePickAdvance();
}

// Chord quality

function defaultChordStats() {
    return {
        streak: 0,
        trials: 0,
        correct: 0,
    };
}

function loadChordStats() {
    const stored = storage.load(CHORD_STATS_KEY, null);

    if (!stored || typeof stored !== 'object') {
        return defaultChordStats();
    }

    return {
        streak: Number.isFinite(stored.streak) ? stored.streak : 0,
        trials: Number.isFinite(stored.trials) ? stored.trials : 0,
        correct: Number.isFinite(stored.correct) ? stored.correct : 0,
    };
}

const chord = {
    quality: null,
    committed: false,
    playedNotes: [],
    stats: loadChordStats(),
};

const chordAdvance = createAutoAdvance('.chord-refresh', () => {
    newChordTrial(true);
});

function cancelChordAdvance() {
    chordAdvance.cancel();
}

function scheduleChordAdvance() {
    chordAdvance.schedule();
}

function enabledChordQualities() {
    return [...document.querySelectorAll('[data-chord-quality]')]
        .filter((button) => button.getAttribute('aria-pressed') === 'true')
        .map((button) => button.dataset.chordQuality);
}

function changeChordQuality(button) {
    const selected = button.getAttribute('aria-pressed') === 'true';

    button.setAttribute('aria-pressed', String(!selected));
    newChordTrial();
}

function renderChordAnswers(selected = null, answersEnabled = false) {
    const buttons = enabledChordQualities().map((quality) => {
        const button = document.createElement('button');

        button.type = 'button';
        button.className = 'answer-option';
        button.dataset.chordAnswer = quality;
        button.textContent = quality[0].toUpperCase() + quality.slice(1);
        button.disabled = chord.committed || !answersEnabled;

        if (selected !== null) {
            if (quality === chord.quality) {
                button.classList.add(
                    quality === selected ? 'is-correct' : 'is-target'
                );
            } else if (quality === selected) {
                button.classList.add('is-incorrect');
            }
        }

        return button;
    });

    document.querySelector('[data-chord-answers]').replaceChildren(...buttons);
}

function clearChordResult() {
    clearPracticeResult('chord-result');
}

function newChordTrial(playImmediately = false) {
    cancelChordAdvance();
    stopAllAudio();

    const qualities = enabledChordQualities();

    chord.quality =
        qualities.length > 0
            ? qualities[Math.floor(Math.random() * qualities.length)]
            : null;
    chord.committed = false;
    chord.playedNotes = [];

    clearChordResult();
    renderChordAnswers();

    if (playImmediately) {
        playChordTrial();
    }
}

function playChordTrial() {
    if (!chord.quality) {
        newChordTrial();

        if (!chord.quality) {
            return;
        }
    }

    stopAllAudio();

    const rootMidi = Number(getNote('chords').value);
    const rootHz = midiFrequency(rootMidi);
    const waveform = getWaveform('chords').value;
    const ascending = getControl('chord-playback').value === 'ascending';

    chord.playedNotes = CHORD_QUALITIES[chord.quality].map(
        (semitones) => rootMidi + semitones
    );

    CHORD_QUALITIES[chord.quality].forEach((semitones, index) => {
        audio.playTransient(
            rootHz * 2 ** (semitones / 12),
            waveform,
            ascending ? 0.7 : 1.2,
            0.55,
            ascending ? index * 0.35 : 0
        );
    });

    if (!chord.committed) {
        renderChordAnswers(null, true);
    }
}

function saveChordStats() {
    storage.save(CHORD_STATS_KEY, chord.stats);
}

function renderChordStats() {
    const accuracy =
        chord.stats.trials > 0
            ? (chord.stats.correct / chord.stats.trials) * 100
            : 0;

    getOutput('chord-streak').textContent = String(chord.stats.streak);
    getOutput('chord-accuracy').textContent = `${accuracy.toFixed(0)}%`;
}

function clearChordStats() {
    chord.stats = defaultChordStats();

    storage.remove(CHORD_STATS_KEY);

    renderChordStats();
}

function commitChord(quality) {
    if (chord.committed || !CHORD_QUALITIES[quality]) {
        return;
    }

    audio.stopTransient();
    chord.committed = true;

    const correct = quality === chord.quality;

    chord.stats.trials += 1;
    chord.stats.correct += correct ? 1 : 0;
    chord.stats.streak = correct ? chord.stats.streak + 1 : 0;

    saveChordStats();
    renderChordStats();
    renderChordAnswers(quality, true);

    renderPracticeResult(
        'chord-result',
        correct,
        `${chord.quality[0].toUpperCase()}${chord.quality.slice(1)}`
    );

    const playedNotes = document.createElement('div');

    playedNotes.className = 'chord-played-notes';
    playedNotes.textContent = `Notes: ${chord.playedNotes
        .map(midiToNoteName)
        .join(', ')}`;
    getOutput('chord-result').append(playedNotes);

    scheduleChordAdvance();
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
    getNote('tuner').addEventListener('change', (event) => {
        updateNoteReadout(event.currentTarget);

        if (tunerVoice) {
            tunerVoice.setFrequency(selectedNoteFrequency(event.currentTarget));
        }
    });

    getControl('metronome-time-signature').addEventListener('change', () => {
        metronome.beatIndex = 0;

        if (metronome.running) {
            audio.stopTransient();
            metronome.nextBeatTime = audio.currentTime() + 0.05;
        }
    });

    getAction('play-metronome').addEventListener('click', startMetronome);

    getAction('tap-tempo').addEventListener('click', tapTempo);

    getNote('placement').addEventListener('change', (event) => {
        updateNoteReadout(event.currentTarget);

        newPlacementTrial();
    });

    getNote('pick').addEventListener('change', (event) => {
        updateNoteReadout(event.currentTarget);

        newPickSet();
    });

    getNote('chords').addEventListener('change', (event) => {
        updateNoteReadout(event.currentTarget);
        newChordTrial();
    });

    for (const control of getControls(
        'placement-range-min',
        'placement-range-max',
        'placement-interval'
    )) {
        control.addEventListener('change', () => {
            resetAdaptiveProgress('placement');
            newPlacementTrial();
        });
    }

    for (const control of getControls(
        'pick-range-min',
        'pick-range-max',
        'pick-count'
    )) {
        control.addEventListener('change', () => {
            resetAdaptiveProgress('pick');
            newPickSet();
        });
    }

    for (const exercise of ['placement', 'pick']) {
        getControl(`${exercise}-adaptive`).addEventListener('change', () => {
            resetAdaptiveProgress(exercise);
        });
    }

    getControl('volume').addEventListener('input', updateVolume);

    const a4Input = getControl('a4');

    a4Input.addEventListener('input', resetForReferenceChange);
    a4Input.addEventListener('change', () => {
        normalizeNumberInput(a4Input, DEFAULT_A4);
        resetForReferenceChange();
    });

    getControl('placement-duration').addEventListener('change', (event) => {
        normalizeNumberInput(event.currentTarget, 1);
    });

    getControl('pick-duration').addEventListener('change', (event) => {
        normalizeNumberInput(event.currentTarget, 1);
    });

    getAction('reset-a4').addEventListener('click', () => {
        getControl('a4').value = DEFAULT_A4.toFixed(3);

        resetForReferenceChange();
    });

    getAction('play-tuner').addEventListener('click', playTuner);

    getAction('toggle-tuner-mic').addEventListener('click', toggleMicTuner);

    getAction('play-placement').addEventListener('click', playPlacementTrial);

    getAction('new-placement').addEventListener('click', () => {
        newPlacementTrial(true);
    });

    getAction('new-pick').addEventListener('click', newPickSet);

    getAction('play-chord').addEventListener('click', playChordTrial);

    getAction('new-chord').addEventListener('click', () => {
        newChordTrial(true);
    });

    document
        .querySelector('[data-chord-answers]')
        .addEventListener('click', (event) => {
            const button = event.target.closest('[data-chord-answer]');

            if (button) {
                commitChord(button.dataset.chordAnswer);
            }
        });

    document
        .querySelector('.quality-toggles')
        .addEventListener('click', (event) => {
            const button = event.target.closest('[data-chord-quality]');

            if (button) {
                changeChordQuality(button);
            }
        });

    getControl('chord-playback').addEventListener('change', stopGeneratedAudio);

    for (const control of getControls(
        'pitch-memory-test',
        'pitch-memory-response',
        'pitch-memory-delay',
        'pitch-memory-distractors'
    )) {
        control.addEventListener('change', () => {
            if (pitchMemory.trial) {
                cancelPitchMemoryTrial();
            }

            updatePitchMemoryControls();
        });
    }

    getAction('start-pitch-memory').addEventListener(
        'click',
        playPitchMemoryStimulus
    );

    getAction('stop-pitch-memory').addEventListener(
        'click',
        stopPitchMemoryAudio
    );

    getAction('new-pitch-memory').addEventListener(
        'click',
        startPitchMemoryTrial
    );

    getAction('play-pitch-memory-response').addEventListener(
        'click',
        playPitchMemoryResponse
    );

    getAction('stop-pitch-memory-response').addEventListener(
        'click',
        stopPitchMemoryResponseTone
    );

    getControl('pitch-memory-frequency').addEventListener(
        'input',
        updatePitchMemoryResponseTone
    );

    getAction('toggle-pitch-memory-mic').addEventListener(
        'click',
        togglePitchMemoryMic
    );

    for (const button of getActions('submit-pitch-memory')) {
        button.addEventListener('click', submitPitchMemoryResponse);
    }

    getAction('export-pitch-memory').addEventListener(
        'click',
        exportPitchMemoryResults
    );

    getAction('clear-pitch-memory-stats').addEventListener(
        'click',
        clearPitchMemoryStats
    );

    for (const button of document.querySelectorAll(
        '.placement-judgment .answer-option'
    )) {
        button.addEventListener('click', () => {
            commitPlacement(button.dataset.answer);
        });
    }

    for (const button of getActions('stop-audio')) {
        button.addEventListener('click', () => {
            stopAllAudio();
            cancelPlacementAdvance();
            cancelPickAdvance();
            cancelChordAdvance();
        });
    }

    for (const waveform of document.querySelectorAll('.waveform-select')) {
        waveform.addEventListener('change', stopGeneratedAudio);
    }

    document
        .querySelector('.pick-target-candidate-list')
        .addEventListener('click', (event) => {
            const button = event.target.closest('button[data-action]');

            const row = button?.closest('.pick-target-candidate-row');

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

    getAction('clear-placement-stats').addEventListener(
        'click',
        clearPlacementStats
    );

    getAction('clear-pick-stats').addEventListener('click', clearPickStats);

    getAction('clear-chord-stats').addEventListener('click', clearChordStats);
}

// Initialization

function initialize() {
    pitchMemory.trial = null;
    storage.remove(PITCH_MEMORY_TRIAL_KEY);

    initializeTabs();
    initializeTooltips();
    initializeNotes();

    updateNoteReadouts();

    resetTunerDetection();

    clearPlacementResult();
    renderPlacementStats();

    newPlacementTrial();
    newPickSet();
    newChordTrial();

    renderPickStats();
    renderChordStats();
    updatePitchMemoryControls();
    renderPitchMemoryResponseFrequency();

    initializeEvents();
}

initialize();

window.addEventListener('beforeunload', () => {
    stopAllAudio();
    cancelPlacementAdvance();
    cancelPickAdvance();
    cancelChordAdvance();
    clearPitchMemoryTimers();

    if (pitchMemory.replayTimer !== null) {
        clearTimeout(pitchMemory.replayTimer);
    }

    stopPitchMemoryResponseTone();

    if (
        pitchMemory.trial?.state === 'waiting' &&
        (pitchMemory.trial.test === 'interference' ||
            Date.now() < pitchMemory.trial.encodingEndsAt)
    ) {
        pitchMemory.trial = null;
        savePitchMemoryState();
    }
});
