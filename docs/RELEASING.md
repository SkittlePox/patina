# Releasing Patina

VS Code installs extensions from the **VS Code Marketplace**. Cursor, VSCodium and Windsurf can't use it and install from **Open VSX** instead. Publish to both.

## 1. Prepare the package (once)

- **Publisher ID**: replace `"publisher": "local"` in `package.json` with your publisher ID (e.g. `skittlepox`). The extension ID becomes `<publisher>.patina`. Settings are unaffected; uninstall the local build once and install the published one.
- **License**: add a `LICENSE` file (MIT is the usual choice) and drop `--skip-license` from the `package` script.
- **README**: the store page shows the README as-is. Replace the "Media to make" notes with real screenshots/GIFs (PNG/GIF only; SVG images are rejected), or remove them. Change the Install section from clone-and-build to installing from the store.
- **`CHANGELOG.md`**: shown in the store's Changelog tab.
- **Listing**: add `keywords` and a better `categories` value than `Other` in `package.json`.

## 2. VS Code Marketplace (once)

1. Create a publisher with your ID at https://marketplace.visualstudio.com/manage (Microsoft account).
2. In Azure DevOps (https://dev.azure.com) create a Personal Access Token: **Organization: All accessible organizations**, **Scopes: Marketplace → Manage**.
3. `npx vsce login <publisher>` and paste the token.

## 3. Open VSX, for Cursor (once)

1. Sign in at https://open-vsx.org with GitHub and sign the Eclipse publisher agreement in your profile.
2. Create an access token under Settings → Access Tokens.
3. `npx ovsx create-namespace <publisher> -p <token>`

## 4. Each release

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. `npm run package`
3. `npx vsce publish`
4. `npx ovsx publish patina-<version>.vsix -p <token>`
5. Optional: `gh release create v<version> patina-<version>.vsix` so people can download the VSIX and use **Extensions: Install from VSIX…**.

To automate steps 3–4, store the two tokens as GitHub secrets (e.g. `VSCE_PAT`, `OVSX_PAT`) and publish from a GitHub Action on version tags.
