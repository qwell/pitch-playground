"use strict";

const DEFAULT_A4 = 440;

const PICK_STATS_KEY = "pitchPlayground.pickStats.v7";

const PLACEMENT_ADVANCE_DELAY = 3000;

const NOTE_NAMES = [
  "C",
  "C♯ / D♭",
  "D",
  "D♯ / E♭",
  "E",
  "F",
  "F♯ / G♭",
  "G",
  "G♯ / A♭",
  "A",
  "A♯ / B♭",
  "B",
];

const MASTER_GAIN = 0.55;
const VOICE_GAIN = 0.16;

let audioContext = null;
let masterGain = null;

let tunerVoice = null;

const transientVoices = new Set();

function element(id) {
  return document.getElementById(id);
}

function numberValue(input, fallback) {
  const value = Number(input.value);

  return Number.isFinite(value) ? value : fallback;
}

function positiveNumberValue(input, fallback) {
  const value = numberValue(input, fallback);

  return value > 0 ? value : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function signed(value, decimals = 1) {
  return `${value >= 0 ? "+" : ""}` + value.toFixed(decimals);
}

function frequencyFromCents(referenceHz, cents) {
  return referenceHz * 2 ** (cents / 1200);
}

function centsBetween(frequencyHz, referenceHz) {
  return 1200 * Math.log2(frequencyHz / referenceHz);
}

function getA4() {
  return positiveNumberValue(element("globalA4"), DEFAULT_A4);
}

function midiFrequency(midi) {
  return getA4() * 2 ** ((midi - 69) / 12);
}

function midiToNoteName(midi) {
  const rounded = Math.round(midi);

  const pitchClass = ((rounded % 12) + 12) % 12;

  const octave = Math.floor(rounded / 12) - 1;

  return NOTE_NAMES[pitchClass] + octave;
}

//
// Audio
//

function ensureAudioContext() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      throw new Error("Web Audio API is unavailable.");
    }

    audioContext = new AudioContextClass();

    masterGain = audioContext.createGain();

    masterGain.gain.value = MASTER_GAIN;

    masterGain.connect(audioContext.destination);
  }

  if (audioContext.state === "suspended") {
    audioContext.resume();
  }

  return audioContext;
}

function holdAndRamp(param, target, seconds = 0.015) {
  const context = ensureAudioContext();

  const now = context.currentTime;

  if (typeof param.cancelAndHoldAtTime === "function") {
    param.cancelAndHoldAtTime(now);
  } else {
    const current = param.value;

    param.cancelScheduledValues(now);

    param.setValueAtTime(current, now);
  }

  param.linearRampToValueAtTime(target, now + seconds);
}

function createContinuousTone(frequencyHz, waveform, volume = 1) {
  const context = ensureAudioContext();

  const oscillator = context.createOscillator();

  const gain = context.createGain();

  oscillator.type = waveform;

  oscillator.frequency.value = frequencyHz;

  gain.gain.value = 0;

  oscillator.connect(gain);

  gain.connect(masterGain);

  oscillator.start();

  holdAndRamp(gain.gain, VOICE_GAIN * clamp(volume, 0, 1));

  let stopped = false;

  return {
    setFrequency(frequency) {
      if (stopped) {
        return;
      }

      oscillator.frequency.setTargetAtTime(
        frequency,
        context.currentTime,
        0.006,
      );
    },

    stop() {
      if (stopped) {
        return;
      }

      stopped = true;

      const now = context.currentTime;

      holdAndRamp(gain.gain, 0);

      try {
        oscillator.stop(now + 0.025);
      } catch {}

      oscillator.addEventListener(
        "ended",
        () => {
          oscillator.disconnect();
          gain.disconnect();
        },
        {
          once: true,
        },
      );
    },
  };
}

function playTransientTone(
  frequencyHz,
  waveform,
  durationSeconds,
  volume = 1,
  delaySeconds = 0,
) {
  const context = ensureAudioContext();

  const oscillator = context.createOscillator();

  const gain = context.createGain();

  const startTime = context.currentTime + delaySeconds;

  const releaseTime = startTime + durationSeconds;

  const targetGain = VOICE_GAIN * clamp(volume, 0, 1);

  oscillator.type = waveform;

  oscillator.frequency.setValueAtTime(frequencyHz, startTime);

  gain.gain.setValueAtTime(0, startTime);

  gain.gain.linearRampToValueAtTime(targetGain, startTime + 0.012);

  gain.gain.setValueAtTime(
    targetGain,
    Math.max(startTime + 0.012, releaseTime - 0.015),
  );

  gain.gain.linearRampToValueAtTime(0, releaseTime);

  oscillator.connect(gain);

  gain.connect(masterGain);

  oscillator.start(startTime);

  oscillator.stop(releaseTime + 0.02);

  let stopped = false;

  const voice = {
    stop() {
      if (stopped) {
        return;
      }

      stopped = true;

      const now = context.currentTime;

      if (typeof gain.gain.cancelAndHoldAtTime === "function") {
        gain.gain.cancelAndHoldAtTime(now);
      } else {
        const current = gain.gain.value;

        gain.gain.cancelScheduledValues(now);

        gain.gain.setValueAtTime(current, now);
      }

      gain.gain.linearRampToValueAtTime(0, now + 0.015);

      try {
        oscillator.stop(Math.max(now + 0.02, startTime));
      } catch {}
    },
  };

  transientVoices.add(voice);

  oscillator.addEventListener(
    "ended",
    () => {
      transientVoices.delete(voice);

      oscillator.disconnect();
      gain.disconnect();
    },
    {
      once: true,
    },
  );

  return voice;
}

function stopTransientVoices() {
  for (const voice of [...transientVoices]) {
    voice.stop();
  }

  transientVoices.clear();
}

function stopTuner() {
  if (!tunerVoice) {
    return;
  }

  tunerVoice.stop();

  tunerVoice = null;
}

function stopAllAudio() {
  stopTuner();
  stopTransientVoices();
}

//
// Tabs
//

function initializeTabs() {
  const buttons = document.querySelectorAll(".tab");

  const panels = document.querySelectorAll(".tab-panel");

  for (const button of buttons) {
    button.addEventListener("click", () => {
      stopAllAudio();
      cancelPlacementAdvance();

      const tabName = button.dataset.tab;

      for (const otherButton of buttons) {
        const active = otherButton === button;

        otherButton.classList.toggle("active", active);

        otherButton.setAttribute("aria-selected", String(active));
      }

      for (const panel of panels) {
        const active = panel.id === `tab-${tabName}`;

        panel.hidden = !active;

        panel.classList.toggle("active", active);
      }
    });
  }
}

//
// Notes
//

function populateNoteSelector(select, defaultMidi) {
  const options = [];

  for (let midi = 48; midi <= 84; midi += 1) {
    const option = document.createElement("option");

    option.value = String(midi);

    option.textContent = midiToNoteName(midi);

    options.push(option);
  }

  select.replaceChildren(...options);

  select.value = String(defaultMidi);
}

function selectedNoteFrequency(select) {
  return midiFrequency(Number(select.value));
}

const tunerNote = element("tunerNote");

const placementNote = element("placementNote");

const pickNote = element("pickNote");

function updateNoteReadouts() {
  element("tunerHz").textContent = `${selectedNoteFrequency(tunerNote).toFixed(
    3,
  )} Hz`;

  element("placementHz").textContent = `${selectedNoteFrequency(
    placementNote,
  ).toFixed(3)} Hz`;

  element("pickHz").textContent = `${selectedNoteFrequency(pickNote).toFixed(
    3,
  )} Hz`;
}

//
// Tuning
//

function playTuner() {
  stopAllAudio();

  tunerVoice = createContinuousTone(
    selectedNoteFrequency(tunerNote),

    element("tunerWaveform").value,

    1,
  );
}

//
// Pitch placement
//

let placementTrial = null;

let placementAdvanceTimer = null;

let placementStreak = 0;

let placementTrialCount = 0;

let placementErrorTotal = 0;

let placementBest = null;

function cancelPlacementAdvance() {
  if (placementAdvanceTimer !== null) {
    clearTimeout(placementAdvanceTimer);

    placementAdvanceTimer = null;
  }

  stopPlacementCountdown();
}

function stopPlacementCountdown() {
  element("placementRefresh").classList.remove("counting-down");
}

function schedulePlacementAdvance() {
  cancelPlacementAdvance();

  const refreshButton = element("placementRefresh");

  /*
   * Force the animation to restart even if
   * the previous trial just used it.
   */
  void refreshButton.offsetWidth;

  refreshButton.classList.add("counting-down");

  placementAdvanceTimer = window.setTimeout(() => {
    placementAdvanceTimer = null;

    stopPlacementCountdown();

    refreshPlacementTrial();
  }, PLACEMENT_ADVANCE_DELAY);
}

function clearPlacementStats() {
  placementStreak = 0;

  placementTrialCount = 0;

  placementErrorTotal = 0;

  placementBest = null;

  updatePlacementStats();
}

function updatePlacementStats() {
  const meanError =
    placementTrialCount > 0 ? placementErrorTotal / placementTrialCount : 0;

  element("placementStreak").textContent = String(placementStreak);

  element("placementMeanError").textContent = `${meanError.toFixed(1)} cents`;

  element("placementBest").textContent =
    placementBest === null ? "--" : `${placementBest.toFixed(2)} cents`;
}

function setJudgmentButtonsDisabled(disabled) {
  const buttons = document.querySelectorAll("[data-judgment]");

  for (const button of buttons) {
    button.disabled = disabled;
  }
}

function clearJudgmentState() {
  const buttons = document.querySelectorAll("[data-judgment]");

  for (const button of buttons) {
    button.classList.remove("answer-correct", "answer-wrong", "answer-target");
  }
}

function clearPlacementResult() {
  const result = element("placementResult");

  result.classList.remove("correct", "incorrect");

  result.replaceChildren();
}

function newPlacementTrial() {
  cancelPlacementAdvance();
  stopAllAudio();

  const rootHz = selectedNoteFrequency(placementNote);

  const semitones = Number(element("placementInterval").value);

  const range = Math.max(
    0.1,

    numberValue(element("placementRange"), 50),
  );

  const correctTargetHz = rootHz * 2 ** (semitones / 12);

  const magnitude = range <= 0.1 ? 0.1 : 0.1 + Math.random() * (range - 0.1);

  placementTrial = {
    rootHz,

    correctTargetHz,

    mistuneCents: Math.random() < 0.5 ? -magnitude : magnitude,

    committed: false,
  };

  element("placementPlay").disabled = false;

  clearJudgmentState();

  setJudgmentButtonsDisabled(false);

  clearPlacementResult();
}

function playPlacementTrial() {
  /*
   * Replaying within the 3 second answer window
   * keeps the current trial and prevents automatic
   * advancement.
   */
  cancelPlacementAdvance();

  if (!placementTrial) {
    newPlacementTrial();
  }

  stopAllAudio();

  const waveform = element("placementWaveform").value;

  const duration = positiveNumberValue(element("placementDuration"), 1);

  const targetHz = frequencyFromCents(
    placementTrial.correctTargetHz,
    placementTrial.mistuneCents,
  );

  playTransientTone(placementTrial.rootHz, waveform, duration, 1);

  playTransientTone(targetHz, waveform, duration, 1, duration + 0.1);
}

function refreshPlacementTrial() {
  newPlacementTrial();
  playPlacementTrial();
}

function commitPlacement(judgment) {
  if (!placementTrial || placementTrial.committed) {
    return;
  }

  stopTransientVoices();

  placementTrial.committed = true;

  const mistuneCents = placementTrial.mistuneCents;

  const distance = Math.abs(mistuneCents);

  const direction = mistuneCents < 0 ? "flat" : "sharp";

  const correct = judgment === direction;

  const mistunedHz = frequencyFromCents(
    placementTrial.correctTargetHz,
    mistuneCents,
  );

  const errorHz = mistunedHz - placementTrial.correctTargetHz;

  /*
   * Color the Flat / Sharp buttons using the
   * same meaning as Pick target:
   *
   * green = selected correct answer
   * red   = selected wrong answer
   * blue  = correct answer that was missed
   */
  const judgmentButtons = document.querySelectorAll("[data-judgment]");

  for (const button of judgmentButtons) {
    const buttonJudgment = button.dataset.judgment;

    button.classList.remove("answer-correct", "answer-wrong", "answer-target");

    if (correct) {
      if (buttonJudgment === judgment) {
        button.classList.add("answer-correct");
      }

      continue;
    }

    if (buttonJudgment === judgment) {
      button.classList.add("answer-wrong");
    }

    if (buttonJudgment === direction) {
      button.classList.add("answer-target");
    }
  }

  setJudgmentButtonsDisabled(true);

  /*
   * Stats
   */
  placementTrialCount += 1;

  placementErrorTotal += correct ? 0 : distance;

  placementStreak = correct ? placementStreak + 1 : 0;

  if (correct && (placementBest === null || distance < placementBest)) {
    placementBest = distance;
  }

  updatePlacementStats();

  /*
   * Result
   *
   * Always display the actual answer.
   * The icon/color tells whether the user
   * got it right.
   */
  const result = element("placementResult");

  result.classList.toggle("correct", correct);

  result.classList.toggle("incorrect", !correct);

  const icon = document.createElement("strong");

  icon.textContent = correct ? "✓" : "✕";

  const text = document.createTextNode(
    ` ${direction} · ` +
      `${signed(mistuneCents, 2)} cents ` +
      `(${signed(errorHz, 3)} Hz)`,
  );

  result.replaceChildren(icon, text);

  schedulePlacementAdvance();
}

//
// Pick target
//

let pickCandidates = [];

let pickCommitted = false;

function shuffle(items) {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));

    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }

  return result;
}

function candidateOffsets(count, range) {
  const offsets = [0];

  const remaining = count - 1;

  const levels = Math.ceil(remaining / 2);

  for (let level = 1; level <= levels; level += 1) {
    const magnitude = (range * level) / levels;

    const signs = Math.random() < 0.5 ? [-1, 1] : [1, -1];

    for (const sign of signs) {
      if (offsets.length >= count) {
        break;
      }

      offsets.push(sign * magnitude);
    }
  }

  return offsets;
}

function newPickSet() {
  stopAllAudio();

  const targetHz = selectedNoteFrequency(pickNote);

  const range = Math.max(
    0.1,

    numberValue(element("pickRange"), 50),
  );

  const count = clamp(Math.round(numberValue(element("pickCount"), 7)), 2, 10);

  pickCandidates = shuffle(
    candidateOffsets(count, range).map((cents) => ({
      cents,

      frequencyHz: frequencyFromCents(targetHz, cents),

      isTarget: Math.abs(cents) < 0.000001,

      played: false,

      row: null,

      details: null,

      chooseButton: null,
    })),
  );

  pickCommitted = false;

  renderCandidates();
}

function renderCandidates() {
  const rows = [];

  pickCandidates.forEach((candidate, index) => {
    const row = document.createElement("div");

    row.className = "candidate-row";

    const actions = document.createElement("div");

    actions.className = "candidate-actions";

    const playButton = document.createElement("button");

    playButton.type = "button";

    playButton.className = "candidate-play icon-button";

    playButton.setAttribute("aria-label", `Play candidate ${index + 1}`);

    playButton.title = `Play candidate ${index + 1}`;

    playButton.textContent = "▶";

    const chooseButton = document.createElement("button");

    chooseButton.type = "button";

    chooseButton.className = "choose-button";

    chooseButton.textContent = `Choose #${index + 1}`;

    chooseButton.disabled = true;

    const details = document.createElement("span");

    details.className = "candidate-details";

    candidate.row = row;

    candidate.details = details;

    candidate.chooseButton = chooseButton;

    playButton.addEventListener("click", () => {
      stopAllAudio();

      candidate.played = true;

      if (!pickCommitted) {
        chooseButton.disabled = false;
      }

      playTransientTone(
        candidate.frequencyHz,

        element("pickWaveform").value,

        positiveNumberValue(element("pickDuration"), 1),
      );
    });

    chooseButton.addEventListener("click", () => {
      commitPick(candidate);
    });

    actions.append(playButton, chooseButton);

    row.append(actions, details);

    rows.push(row);
  });

  element("candidateList").replaceChildren(...rows);
}

function commitPick(selected) {
  if (pickCommitted) {
    return;
  }

  stopTransientVoices();

  pickCommitted = true;

  const target = pickCandidates.find((candidate) => candidate.isTarget);

  const errorCents = centsBetween(selected.frequencyHz, target.frequencyHz);

  for (const candidate of pickCandidates) {
    candidate.chooseButton.disabled = true;

    candidate.row.classList.remove("pick-wrong", "pick-target", "pick-correct");

    const icon = document.createElement("span");

    icon.className = "candidate-result-icon";

    let showIcon = false;

    if (candidate === selected && candidate.isTarget) {
      candidate.row.classList.add("pick-correct");

      icon.textContent = "✓";

      showIcon = true;
    } else {
      if (candidate === selected) {
        candidate.row.classList.add("pick-wrong");

        icon.textContent = "✕";

        showIcon = true;
      }

      if (candidate.isTarget) {
        candidate.row.classList.add("pick-target");

        icon.textContent = "◎";

        showIcon = true;
      }
    }

    const text = document.createTextNode(
      `${candidate.frequencyHz.toFixed(3)} Hz, ` +
        `${signed(candidate.cents, 2)} cents`,
    );

    if (showIcon) {
      candidate.details.replaceChildren(icon, text);
    } else {
      candidate.details.replaceChildren(text);
    }
  }

  savePickStat(errorCents);

  renderPickStats();
}

function loadPickStats() {
  try {
    const stats = JSON.parse(localStorage.getItem(PICK_STATS_KEY) || "[]");

    return Array.isArray(stats) ? stats : [];
  } catch {
    return [];
  }
}

function savePickStat(errorCents) {
  const stats = loadPickStats();

  stats.push({
    dateTime: new Date().toISOString(),

    targetHz: selectedNoteFrequency(pickNote),

    errorCents,
  });

  localStorage.setItem(
    PICK_STATS_KEY,

    JSON.stringify(stats.slice(-500)),
  );
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

  let absoluteError = 0;

  for (const stat of stats) {
    absoluteError += Math.abs(Number(stat.errorCents));
  }

  const meanError = stats.length > 0 ? absoluteError / stats.length : 0;

  element("pickStreak").textContent = String(currentPickStreak(stats));

  element("pickMeanError").textContent = `${meanError.toFixed(1)} cents`;
}

//
// Events
//

function initializeEvents() {
  tunerNote.addEventListener("change", () => {
    updateNoteReadouts();

    if (tunerVoice) {
      tunerVoice.setFrequency(selectedNoteFrequency(tunerNote));
    }
  });

  placementNote.addEventListener("change", updateNoteReadouts);

  pickNote.addEventListener("change", updateNoteReadouts);

  element("clearPlacementStats").addEventListener("click", clearPlacementStats);

  element("globalA4").addEventListener("input", () => {
    stopAllAudio();
    cancelPlacementAdvance();

    updateNoteReadouts();
  });

  element("resetA4").addEventListener("click", () => {
    stopAllAudio();
    cancelPlacementAdvance();

    element("globalA4").value = DEFAULT_A4.toFixed(3);

    updateNoteReadouts();
  });

  element("tunerPlay").addEventListener("click", playTuner);

  /*
   * Every stop button stops every current stream
   * and also cancels Pitch placement's pending
   * automatic next trial.
   */
  for (const stopButton of document.querySelectorAll("[data-stop-all]")) {
    stopButton.addEventListener("click", () => {
      stopAllAudio();
      cancelPlacementAdvance();
    });
  }

  /*
   * Changing a waveform never changes a tone while
   * it is sounding. Current audio stops first.
   */
  for (const waveform of document.querySelectorAll(".waveform-select")) {
    waveform.addEventListener("change", stopAllAudio);
  }

  element("placementPlay").addEventListener("click", playPlacementTrial);

  element("placementRefresh").addEventListener("click", refreshPlacementTrial);

  for (const button of document.querySelectorAll("[data-judgment]")) {
    button.addEventListener("click", () => {
      commitPlacement(button.dataset.judgment);
    });
  }

  element("pickRefresh").addEventListener("click", newPickSet);

  element("clearPickStats").addEventListener("click", () => {
    localStorage.removeItem(PICK_STATS_KEY);

    renderPickStats();
  });
}

//
// Initialization
//

function initialize() {
  initializeTabs();

  populateNoteSelector(tunerNote, 69);

  populateNoteSelector(placementNote, 69);

  populateNoteSelector(pickNote, 69);

  updateNoteReadouts();

  clearPlacementResult();

  setJudgmentButtonsDisabled(true);

  element("placementPlay").disabled = true;

  updatePlacementStats();

  newPickSet();

  renderPickStats();

  initializeEvents();
}

initialize();

window.addEventListener("beforeunload", () => {
  stopAllAudio();
  cancelPlacementAdvance();
});
