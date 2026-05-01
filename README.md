# Revival:Side Spine Viewer

Revival:Side Spine Viewer is an open-source browser tool for inspecting Spine 3.7 assets. Drop or browse for matching `.skel` or `.json`, `.atlas`, and `.png` files to view setup poses, skins, and embedded animations.

## Requirements

- Node.js 20 or newer
- npm, included with Node.js

## Build From Source

```powershell
git clone <repo-url>
cd SpineViewer
npm install
npm run build
```

The compiled static site is written to `dist/`.

## Run Locally

```powershell
npm install
npm run dev
```

Vite will print a local URL, usually `http://localhost:5173/`. Open that URL in a browser, then drop matching Spine files onto the viewer or use the file picker.

## Preview A Production Build

```powershell
npm run build
npm run preview
```

## Supported Assets

- Spine 3.7 binary `.skel`
- Spine JSON `.json`
- Texture atlas `.atlas`
- PNG atlas pages referenced by the atlas

The viewer does not include game assets. Use only files you have the right to inspect or distribute.

## License

This project is released as open source under the MIT License. See `LICENSE` for details.
