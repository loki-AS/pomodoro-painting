# Atelier — Pomodoro + Met Painting

Fullscreen pomodoro timer. During rest, a public-domain painting from [The Metropolitan Museum of Art](https://www.metmuseum.org/) appears stroke by stroke.

## Timings

- Focus: 25 minutes
- Short break: 5 minutes
- Long break: 15 minutes (after every 4 focus sessions)

## Develop (Windows / Mac / Linux)

```bash
npm install
npm run dev
```

Open the local URL Vite prints, click **Fullscreen**, then **Begin focus**.

Add `?fast=1` to the URL for short demo timings (30s / 20s / 40s) while testing the brush reveal.

Dev proxies The Met Collection API via `/met-api` and images via `/met-images` (see `vite.config.ts`) so canvas color sampling works without CORS issues. Painting search uses Met Collection API **v1.1** (`/public/collection/v1.1/search`) with pagination.

## Build

```bash
npm run build
npm run preview
```

Static output is in `dist/`.

## Raspberry Pi kiosk

1. Copy the project (or just `dist/`) to the Pi.
2. On the Pi, serve the build:

```bash
npx --yes serve -s dist -l 3000
```

Or install nginx and point the root at `dist`.

3. Autostart Chromium in kiosk mode (example for Raspberry Pi OS). Create or edit `~/.config/autostart/atelier.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=Atelier
Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars --app=http://localhost:3000
```

4. Ensure the static server also starts on boot (systemd service or a line in the same autostart script).

5. Connect an HDMI display — the app is meant as a room screen.

**Note:** Use a Raspberry Pi (3/4/5) for this UI. An Arduino cannot render the painting canvas; keep Arduino for optional buttons/LEDs later if you want.

## Credits

Artwork data and images via The Met Collection API (Open Access / CC0 where marked public domain).
