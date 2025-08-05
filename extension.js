// Image Tools VS Code Extension
// Provides: Convert to PNG (Sharp) and Remove Background (remove.bg)

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { HttpsProxyAgent } = require('https-proxy-agent');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const convertCmd = vscode.commands.registerCommand(
    'imageTools.convertToPng',
    /**
     * @param {vscode.Uri} uri The clicked resource in Explorer (if any)
     * @param {vscode.Uri[]} uris The multi-selected resources (if any)
     */
    async (uri, uris) => {
      try {
        const targets = await resolveTargetUris(uri, uris, {
          title: 'Select image(s) to convert to PNG',
        });
        if (!targets.length) return;

        const cfg = vscode.workspace.getConfiguration('imageTools');
        const overwrite = cfg.get('convert.overwrite', false);

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Converting to PNG...', cancellable: false },
          async () => {
            let success = 0;
            let failed = 0;
            for (const t of targets) {
              try {
                const outPath = await getOutputPathPng(t.fsPath, overwrite, '-converted');
                await sharp(t.fsPath).png().toFile(outPath);
              success++;
              } catch (e) {
                failed++;
                console.error('Convert failed for', t.fsPath, e);
              }
            }
            vscode.window.showInformationMessage(`Converted ${success} file(s) to PNG` + (failed ? `, ${failed} failed` : ''));
          }
        );
      } catch (err) {
        handleError('Conversion failed', err);
      }
    }
  );

  const removeBgCmd = vscode.commands.registerCommand(
    'imageTools.removeBackground',
    /**
     * @param {vscode.Uri} uri The clicked resource in Explorer (if any)
     * @param {vscode.Uri[]} uris The multi-selected resources (if any)
     */
    async (uri, uris) => {
      try {
        const cfg = vscode.workspace.getConfiguration('imageTools');
        let apiKey = cfg.get('removeBgApiKey', '').trim();
        if (!apiKey) {
          const choice = await vscode.window.showErrorMessage(
            'Image Tools: remove.bg API key not set.',
            'Enter API Key...',
            'Open Settings'
          );
          if (choice === 'Enter API Key...') {
            const input = await vscode.window.showInputBox({
              prompt: 'Enter remove.bg API key',
              password: true,
              ignoreFocusOut: true,
            });
            if (input && input.trim()) {
              await vscode.workspace
                .getConfiguration()
                .update('imageTools.removeBgApiKey', input.trim(), vscode.ConfigurationTarget.Global);
              apiKey = input.trim();
              vscode.window.showInformationMessage('Image Tools: API key saved to User Settings.');
            } else {
              return;
            }
          } else if (choice === 'Open Settings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'imageTools.removeBgApiKey');
            return;
          } else {
            return;
          }
        }
        const targets = await resolveTargetUris(uri, uris, {
          title: 'Select an image to remove background',
          filters: { Images: ['png', 'jpg', 'jpeg', 'webp'] },
        });
        if (!targets.length) return;
        if (targets.length > 1) {
          const pick = await vscode.window.showQuickPick(
            targets.map(u => ({ label: path.basename(u.fsPath), u })),
            { placeHolder: 'Select one image to edit' }
          );
          if (!pick) return;
          uri = pick.u;
        } else {
          uri = targets[0];
        }

        const suffix = cfg.get('removeBg.outputSuffix', '-no-bg');
        const proxy = (cfg.get('network.proxy', '') || '').trim();
        const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;

        const panel = vscode.window.createWebviewPanel(
          'imagerEditor',
          `imager: Remove Background ${path.basename(uri.fsPath)}`,
          vscode.ViewColumn.Active,
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
          }
        );

        const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
        const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'editor.js'));
        const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'editor.css'));
        panel.webview.html = getEditorHtml(panel.webview, styleUri, scriptUri);

        // Load original and initial cutout via remove.bg
        const originalBuf = await fs.promises.readFile(uri.fsPath);
        const cutoutPath = path.join(require('os').tmpdir(), `imager-cutout-${Date.now()}.png`);
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Removing background via remove.bg...', cancellable: false },
          async () => {
            await removeBackgroundFile(uri.fsPath, cutoutPath, apiKey, agent);
          }
        );
        const cutoutBuf = await fs.promises.readFile(cutoutPath);

        const initPayload = {
          type: 'init',
          filename: path.basename(uri.fsPath),
          original: `data:image/${path.extname(uri.fsPath).replace('.', '')};base64,${originalBuf.toString('base64')}`,
          cutout: `data:image/png;base64,${cutoutBuf.toString('base64')}`
        };
        // try immediate post, and also handle 'ready' to resend
        panel.webview.postMessage(initPayload);

        panel.webview.onDidReceiveMessage(async (msg) => {
          if (msg?.type === 'acceptPngDataUrl') {
            try {
              const outPath = await getOutputPathPng(uri.fsPath, false, suffix);
              const base64 = msg.dataUrl.split(',')[1];
              await fs.promises.writeFile(outPath, Buffer.from(base64, 'base64'));
              vscode.window.showInformationMessage(`Saved ${path.basename(outPath)}`);
              // cleanup temp cutout
              fs.promises.unlink(cutoutPath).catch(() => {});
              panel.dispose();
            } catch (e) {
              handleError('Save failed', e);
            }
          } else if (msg?.type === 'cancelEdit') {
            // cleanup temp cutout
            fs.promises.unlink(cutoutPath).catch(() => {});
            panel.dispose();
          } else if (msg?.type === 'ready') {
            panel.webview.postMessage(initPayload);
          }
        }, undefined, context.subscriptions);

        panel.onDidDispose(() => {
          // ensure cleanup if not already deleted
          fs.promises.unlink(cutoutPath).catch(() => {});
        }, null, context.subscriptions);
      } catch (err) {
        handleError('Background removal failed', err);
      }
    }
  );

  const setKeyCmd = vscode.commands.registerCommand('imageTools.setRemoveBgApiKey', async () => {
    const current = vscode.workspace.getConfiguration('imageTools').get('removeBgApiKey', '');
    const input = await vscode.window.showInputBox({
      prompt: 'Enter remove.bg API key',
      password: true,
      ignoreFocusOut: true,
      value: typeof current === 'string' ? current : ''
    });
    if (input && input.trim()) {
      await vscode.workspace
        .getConfiguration()
        .update('imageTools.removeBgApiKey', input.trim(), vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Image Tools: API key saved to User Settings.');
    }
  });

  const editCmd = vscode.commands.registerCommand('imageTools.editBackground', async (uri) => {
    try {
      const cfg = vscode.workspace.getConfiguration('imageTools');
      let apiKey = cfg.get('removeBgApiKey', '').trim();
      if (!uri) {
        const picks = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectMany: false,
          filters: { Images: ['png', 'jpg', 'jpeg', 'webp'] },
          title: 'Select an image to edit background'
        });
        if (!picks || !picks.length) return;
        uri = picks[0];
      }
      if (!apiKey) {
        const choice = await vscode.window.showErrorMessage(
          'imager: remove.bg API key not set.', 'Enter API Key...', 'Open Settings'
        );
        if (choice === 'Enter API Key...') {
          const input = await vscode.window.showInputBox({ prompt: 'Enter remove.bg API key', password: true, ignoreFocusOut: true });
          if (!input) return; apiKey = input.trim();
          await vscode.workspace.getConfiguration().update('imageTools.removeBgApiKey', apiKey, vscode.ConfigurationTarget.Global);
        } else if (choice === 'Open Settings') {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'imageTools.removeBgApiKey');
          return;
        } else { return; }
      }

      const panel = vscode.window.createWebviewPanel(
        'imagerEditor',
        `imager: Edit ${path.basename(uri.fsPath)}`,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
        }
      );

      const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
      const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'editor.js'));
      const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'editor.css'));
      panel.webview.html = getEditorHtml(panel.webview, styleUri, scriptUri);

      // Load original and initial cutout via remove.bg
      const originalBuf = await fs.promises.readFile(uri.fsPath);
      const cutoutPath = path.join(require('os').tmpdir(), `imager-cutout-${Date.now()}.png`);
      await removeBackgroundFile(uri.fsPath, cutoutPath, apiKey, undefined);
      const cutoutBuf = await fs.promises.readFile(cutoutPath);

      const postInit = () => panel.webview.postMessage({
        type: 'init',
        filename: path.basename(uri.fsPath),
        original: `data:image/${path.extname(uri.fsPath).replace('.', '')};base64,${originalBuf.toString('base64')}`,
        cutout: `data:image/png;base64,${cutoutBuf.toString('base64')}`
      });
      postInit();

      panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg?.type === 'savePngDataUrl') {
          const suggested = `${path.basename(uri.fsPath, path.extname(uri.fsPath))}-edited.png`;
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(path.dirname(uri.fsPath), suggested)),
            filters: { Images: ['png'] }
          });
          if (!target) return;
          const base64 = msg.dataUrl.split(',')[1];
          await fs.promises.writeFile(target.fsPath, Buffer.from(base64, 'base64'));
          vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`);
        }
      }, undefined, context.subscriptions);
    } catch (err) {
      handleError('Open editor failed', err);
    }
  });

  context.subscriptions.push(convertCmd, removeBgCmd, setKeyCmd, editCmd);
}

function deactivate() {}

/** Resolve input URIs from explorer selection or file picker. */
async function resolveTargetUris(uri, uris, pickOptions) {
  /** @type {vscode.Uri[]} */
  let targets = [];
  if (Array.isArray(uris) && uris.length) {
    targets = uris;
  } else if (uri) {
    targets = [uri];
  } else {
    const picks = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      filters: pickOptions?.filters || { Images: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff', 'bmp'] },
      title: pickOptions?.title || 'Select image(s)'
    });
    if (picks && picks.length) targets = picks;
  }
  // filter by extension
  targets = targets.filter(u => /\.(png|jpg|jpeg|webp|gif|tif|tiff|bmp)$/i.test(u.fsPath));
  // de-duplicate by fsPath
  const seen = new Set();
  return targets.filter(u => (seen.has(u.fsPath) ? false : (seen.add(u.fsPath), true)));
}

/** Compute output .png path, handling overwrite and suffix; ensures directory exists. */
async function getOutputPathPng(inputPath, overwrite, suffix) {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  let out = path.join(dir, `${base}.png`);
  if (!overwrite) {
    if (fs.existsSync(out)) {
      let i = 1;
      while (true) {
        const candidate = path.join(dir, `${base}${suffix || '-converted'}${i === 1 ? '' : `(${i})`}.png`);
        if (!fs.existsSync(candidate)) { out = candidate; break; }
        i++;
      }
    }
  }
  await fs.promises.mkdir(dir, { recursive: true });
  return out;
}

/** Call remove.bg API to remove background for a local file path and write PNG to outPath. */
async function removeBackgroundFile(inPath, outPath, apiKey, agent) {
  const form = new FormData();
  form.append('size', 'auto');
  form.append('format', 'png');
  form.append('image_file', fs.createReadStream(inPath));

  const res = await fetch('https://api.remove.bg/v1.0/removebg', {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey, ...form.getHeaders() },
    body: form,
    agent,
  });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const j = await res.json().catch(() => undefined);
      if (j && j.errors && Array.isArray(j.errors) && j.errors.length) {
        message += `: ${j.errors.map(e => e.title || e.detail || '').join('; ')}`;
      }
    } else {
      const txt = await res.text().catch(() => '');
      if (txt) message += `: ${txt.slice(0, 400)}`;
    }
    throw new Error(`remove.bg request failed: ${message}`);
  }
  const buffer = await res.buffer();
  await fs.promises.writeFile(outPath, buffer);
}

function handleError(prefix, err) {
  console.error(prefix, err);
  const msg = err && err.message ? `${prefix}: ${err.message}` : prefix;
  vscode.window.showErrorMessage(msg);
}

module.exports = {
  activate,
  deactivate
};

function getEditorHtml(webview, styleUri, scriptUri) {
  const csp = `default-src 'none'; img-src ${webview.cspSource} blob: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};`; 
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>imager editor</title>
  </head>
  <body>
    <div class="toolbar">
      <div class="toolbar-left">
        <button id="mode-erase" class="btn">Erase</button>
        <button id="mode-restore" class="btn">Restore</button>
        <label class="label-inline">Brush <input id="brush" type="range" min="3" max="200" value="40" /></label>
      </div>
      <div class="toolbar-center">
        <label for="bgfile" class="btn" id="add-bg-btn">add new bg.</label>
        <button id="remove-bg" class="btn" title="Remove background image">✕</button>
        <input id="bgfile" type="file" accept="image/*" hidden />
      </div>
      <div class="toolbar-right">
        <button id="accept" class="btn primary">Accept</button>
        <button id="cancel" class="btn">Cancel</button>
      </div>
    </div>
    <div class="stage-wrap"><canvas id="stage"></canvas></div>
    <script src="${scriptUri}"></script>
  </body>
  </html>`;
}
