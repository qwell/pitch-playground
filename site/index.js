'use strict';

const DEFAULT_A4 = 440;
const DEFAULT_MIDI = 69;

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
const MASTER_GAIN = 0.55;
const VOICE_GAIN = 0.16;

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
            masterGain.gain.value = MASTER_GAIN;
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

    return {
        currentTime,
        playContinuous,
        playTransient,
        stopTransient,
    };
})();

let tunerVoice = null;

function stopTuner() {
    if (!tunerVoice) {
        return;
    }

    tunerVoice.stop();
    tunerVoice = null;
}

function stopAllAudio() {
    stopTuner();
    stopMetronome();
    audio.stopTransient();
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

    for (let midi = 48; midi <= 84; midi += 1) {
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

function playTuner() {
    stopAllAudio();

    tunerVoice = audio.playContinuous(
        selectedNoteFrequency(document.querySelector('[data-note="tuner"]')),
        document.querySelector('[data-waveform="tuner"]').value
    );
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
    stopAllAudio();
    cancelPlacementAdvance();

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
        control.addEventListener('change', newPlacementTrial);
    }

    for (const control of document.querySelectorAll(
        '[data-control="pick-range-min"], [data-control="pick-range-max"], [data-control="pick-count"]'
    )) {
        control.addEventListener('change', newPickSet);
    }

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
        waveform.addEventListener('change', stopAllAudio);
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

let footerResizeObserver = null;

function initializeFooterClearance() {
    const footer = document.querySelector('footer');

    if (!footer) {
        return;
    }

    const updateFooterHeight = () => {
        document.documentElement.style.setProperty(
            '--footer-height',
            `${Math.ceil(footer.getBoundingClientRect().height)}px`
        );
    };

    updateFooterHeight();

    if ('ResizeObserver' in window) {
        footerResizeObserver = new ResizeObserver(updateFooterHeight);
        footerResizeObserver.observe(footer);
        return;
    }

    window.addEventListener('resize', updateFooterHeight);
}

// Initialization

function initialize() {
    initializeTabs();
    initializeNotes();
    initializeFooterClearance();

    updateNoteReadouts();

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
