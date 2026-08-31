# 440 Lab

A small browser-based music and ear-training tool for practicing pitch, intonation, tuning, rhythm, chord quality, and pitch memory using the Web Audio API.

Live demo: [https://440lab.com/](https://440lab.com/)

## Table of Contents

- [Features](#features)
- [Usage](#usage)
- [Files](#files)
- [Technologies](#technologies)
- [License](#license)

## Features

- Play reference notes with adjustable A4 tuning
- Chromatic microphone tuner
    - Detects the nearest musical note
    - Shows detected and target frequencies
    - Shows pitch deviation in cents on a tuning meter
    - Uses the adjustable A4 reference
- Global output volume control
- Metronome with adjustable BPM and time signature
- Tap tempo
- Practice identifying flat vs. sharp pitch
- Pick the correctly tuned target from multiple candidates
- Identify major, minor, diminished, and augmented chord qualities
- Test pitch memory after a delay or interfering tones
    - Respond with an adjustable oscillator or microphone input
    - Compare the target and response on a continuous frequency slider
    - Track streak and mean error, with optional raw-result CSV export
- Adjustable waveform, duration, interval, range, and candidate count
- Streak and error statistics for ear-training exercises
- Direct links to individual tools using URL fragments
- No dependencies or build step

## Usage

Open `site/index.html` in a modern browser.

Most features can run directly from a `file://` path without a web server. The microphone tuner requires microphone permission and may require HTTPS or localhost, depending on the browser.

Use the global A4 reference to change the tuning standard used throughout the application. The global volume control adjusts generated audio output.

The Tuning tab can play a selected reference note, detect live pitches through the microphone, or do both at the same time. Pitch Memory microphone responses have the same permission and secure-context requirements as the tuner.

## Files

- `site/index.html` - interface and application metadata
- `site/assets/css/index.css` - styles and responsive layout
- `site/assets/js/index.js` - audio, microphone pitch detection, metronome, exercises, and application logic

## Technologies

Vanilla HTML, CSS, and JavaScript using browser APIs including:

- Web Audio API
- MediaDevices / `getUserMedia()`
- `requestAnimationFrame()`
- Local storage for practice statistics

No frameworks, external libraries, build tools, or runtime dependencies are required.

## License

440 Lab is licensed under the [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.en.html) or later.
