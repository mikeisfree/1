# imager

VS Code extension to:
- Convert images (jpg/jpeg/webp/gif/tiff/bmp/png) to PNG using Sharp
- Remove backgrounds from images via remove.bg API (requires free remove.bg API key)
 - Refine background removal (erase/restore brush) and/or add custom background image

## Requirements
- Node.js (for installing dependencies)
- Internet connection (for remove.bg API and first-time dependency install)
- remove.bg API key for background removal (free tier available): https://www.remove.bg/api

## Setup
Simply install from VS Code marketplace
OR
1. Install dependencies:
   ```bash
   npm install
   ```
2. In VS Code, open this folder and press F5 (Run Extension) to launch a new Extension Development Host.

## Usage
- Explorer context menu:
  - Right-click an image file → imager →
    - "Convert to PNG"
    - "Remove Background"
- Command Palette:
  - "imager: Convert to PNG"
  - "imager: Remove Background"
  - If no file is selected, a file picker will appear.

Converted and background-removed images are written next to the original file. The editor saves as a PNG you choose via Save dialog.

## Settings
- `imageTools.removeBgApiKey` (string): remove.bg API key. Required for background removal.
- `imageTools.convert.overwrite` (boolean, default `false`): If true, overwrite existing `.png`; otherwise write to a suffixed filename.
- `imageTools.removeBg.outputSuffix` (string, default `-no-bg`): Suffix used for output filename of background-removed images.
- `imageTools.network.proxy` (string): Optional HTTP proxy like `http://user:pass@host:port` used for remove.bg requests.

## Notes
- Conversion uses [Sharp](https://sharp.pixelplumbing.com/), supporting common formats including WebP, TIFF, GIF, BMP, JPEG.
- Background removal uses the official remove.bg REST API and returns a PNG with transparent background.
- If Sharp fails to install on your platform, ensure you have a supported Node.js version. Most platforms use prebuilt binaries; otherwise build tools may be required.

## Troubleshooting
- "API key not set": Configure `imageTools.removeBgApiKey` in VS Code Settings.
- Corporate proxy: set `imageTools.network.proxy`.
- Permission issues writing files: ensure you have write permissions to the directory.

## License
MIT
