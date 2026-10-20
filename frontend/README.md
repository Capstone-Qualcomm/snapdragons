# Frontend

The operator dashboard is a React app built with Vite.

## Prerequisites

- Install Node.js **20.19 or newer in the 20.x line, or 22.12 or newer**. These are the versions supported by the Vite version in this project. npm is included with Node.js.
- Check your installation from a terminal:

  ```bash
  node --version
  npm --version
  ```

## Run locally

From the repository root:

```bash
cd frontend
npm install
npm run dev
```

Open the local URL printed by Vite (usually `http://localhost:5173`). Leave the terminal running while you use the app. Press `Ctrl+C` to stop the development server.

When pulling changes from Git, run `npm install` again if `package.json` or `package-lock.json` changed.

## Build and share changes

Before submitting frontend changes, create a production build:

```bash
npm run build
```

Vite writes the deployable site to `frontend/dist/`. The `dist/` directory is generated and gitignored; commit and push the source files and lockfile, not `dist/`. Teammates can recreate the build with `npm install` and `npm run build`.

Pushing to GitHub shares the source code; it does **not** deploy the UI to an Arduino or web host. Deployment is a separate step. Build the UI before deploying it, and use the deployment instructions once the target and process are set up. Do not copy a generated `index.html` by hand; Vite builds it together with the required JavaScript and CSS assets.

## Other commands

```bash
npm test           # Run the page tests (Vitest)
npm run typecheck  # Check types
npm run lint       # Check the frontend source with ESLint
npm run preview    # Preview the production build locally (run build first)
```
