# RunTracker

A single-file web app for race training. Supports any distance (5K, 10K, half marathon, marathon, or custom). Set your dates, pick your distance, generate a plan, log your runs, and chat with an AI coach that adjusts your schedule on the fly.

## Features

- **Dynamic training plan** — adapts to any number of weeks between your start and race date. Phases (base building, volume, peak, taper, race) scale proportionally.
- **AI plan generation** — with a Claude API key, the coach builds a personalized plan based on your timeline and fitness level.
- **Run logging** — track distance, duration, effort, and notes. Logging a run auto-checks the matching planned workout.
- **AI coach** — chat with a running coach that sees your full plan and recent runs. It can suggest plan changes (injury recovery, adding volume, tune-up races) that you apply with one click.
- **Offline-first** — data lives in localStorage + IndexedDB. Export/import JSON for backup.

## Getting started

1. Open `index.html` in a browser
2. Click the gear icon, set your **start date**, **race date**, and **race distance**
3. Generate a plan (AI or default)
4. Optionally add your **Claude API key** to enable the AI coach

## Tech

Single HTML file. Vanilla JS. Tailwind CSS via CDN. No build step, no dependencies, no server.

## Data

All data stays in your browser (localStorage + IndexedDB). Nothing is sent anywhere except Claude API calls when you use the coach. Your API key is stored locally only.
