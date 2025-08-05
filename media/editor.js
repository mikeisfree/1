(() => {
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');

  const modeEraseBtn = document.getElementById('mode-erase');
  const modeRestoreBtn = document.getElementById('mode-restore');
  const brushSlider = document.getElementById('brush');
  const bgFile = document.getElementById('bgfile');
  const removeBgBtn = document.getElementById('remove-bg');
  const acceptBtn = document.getElementById('accept');
  const cancelBtn = document.getElementById('cancel');

  let originalImg = null; // HTMLImageElement
  let cutoutImg = null;   // HTMLImageElement
  let bgImg = null;       // HTMLImageElement or null

  let maskCanvas = document.createElement('canvas');
  let maskCtx = maskCanvas.getContext('2d');
  let offCanvas = document.createElement('canvas'); // for compositing
  let offCtx = offCanvas.getContext('2d');
  // temp stroke buffer for preview; applied to mask on release
  let strokeCanvas = document.createElement('canvas');
  let strokeCtx = strokeCanvas.getContext('2d');

  let brushSize = 40;
  let mode = 'erase'; // 'erase' or 'restore'
  let drawing = false;
  let lastX = 0, lastY = 0;
  let hoverX = null, hoverY = null; // for brush preview

  // Helpers
  function dataURLToImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  function resizeCanvases(w, h) {
    canvas.width = w; canvas.height = h;
    maskCanvas.width = w; maskCanvas.height = h;
    offCanvas.width = w; offCanvas.height = h;
    strokeCanvas.width = w; strokeCanvas.height = h;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
  }

  function initMaskFromCutout(img) {
    // Initialize mask by copying the cutout's alpha channel into maskCanvas.
    // Draw the cutout onto the mask, then fill with white using source-in to preserve its alpha.
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskCtx.globalCompositeOperation = 'source-over';
    maskCtx.drawImage(img, 0, 0, maskCanvas.width, maskCanvas.height);
    maskCtx.globalCompositeOperation = 'source-in';
    maskCtx.fillStyle = 'white';
    maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskCtx.globalCompositeOperation = 'source-over';
  }

  function setMode(newMode) {
    mode = newMode;
    modeEraseBtn.classList.toggle('active', mode === 'erase');
    modeRestoreBtn.classList.toggle('active', mode === 'restore');
  }

  function setBrush(size) { brushSize = Math.max(1, Math.min(400, size|0)); }

  function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    return { x, y };
  }

  function drawStroke(x0, y0, x1, y1) {
    // Draw temporary stroke into strokeCtx (opaque), not yet applied to mask
    const c = strokeCtx;
    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.lineWidth = brushSize;
    c.strokeStyle = 'white';
    c.globalCompositeOperation = 'source-over';
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
    c.restore();
  }

  function composeAndRender() {
    // Compose: bg (if any) -> original masked by mask -> render to canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (bgImg) {
      // cover behavior
      const { dx, dy, dw, dh } = coverRect(bgImg.width, bgImg.height, canvas.width, canvas.height);
      ctx.drawImage(bgImg, dx, dy, dw, dh);
    } else {
      // transparent background
      // optional: draw checkerboard
      drawCheckerboard(ctx, canvas.width, canvas.height);
    }

    // Place mask visualization between background and original
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; // neutral semi-transparent tint over removed regions
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'destination-out'; // knock out where mask has alpha (kept areas)
    ctx.drawImage(maskCanvas, 0, 0);
    // While drawing, preview how mask will change: in restore mode remove tint where brush restores
    if (drawing && mode === 'restore') {
      ctx.drawImage(strokeCanvas, 0, 0);
    }
    ctx.restore();

    if (!originalImg) return; // wait until images are ready

    // Create masked original into offscreen
    offCtx.clearRect(0, 0, offCanvas.width, offCanvas.height);
    offCtx.globalCompositeOperation = 'source-over';
    offCtx.drawImage(originalImg, 0, 0, offCanvas.width, offCanvas.height);
    // apply current mask
    offCtx.globalCompositeOperation = 'destination-in';
    offCtx.drawImage(maskCanvas, 0, 0);

    // Live preview: modify offscreen with the in-progress stroke (non-destructive)
    if (drawing) {
      if (mode === 'erase') {
        // preview removal: punch out current stroke from the masked image
        offCtx.globalCompositeOperation = 'destination-out';
        offCtx.drawImage(strokeCanvas, 0, 0);
      } else if (mode === 'restore') {
        // preview restore: add original content limited to stroke shape
        const tmp = document.createElement('canvas');
        tmp.width = offCanvas.width; tmp.height = offCanvas.height;
        const tctx = tmp.getContext('2d');
        tctx.globalCompositeOperation = 'source-over';
        tctx.drawImage(originalImg, 0, 0, tmp.width, tmp.height);
        tctx.globalCompositeOperation = 'destination-in';
        tctx.drawImage(strokeCanvas, 0, 0);
        tctx.globalCompositeOperation = 'source-over';
        offCtx.globalCompositeOperation = 'source-over';
        offCtx.drawImage(tmp, 0, 0);
      }
    }
    offCtx.globalCompositeOperation = 'source-over';

    // Draw onto main
    ctx.drawImage(offCanvas, 0, 0);

    // No full-canvas overlay while drawing to avoid any white cover.
  }

  function drawCheckerboard(c, w, h) {
    const size = 16;
    for (let y = 0; y < h; y += size) {
      for (let x = 0; x < w; x += size) {
        const isDark = ((x / size) + (y / size)) % 2 === 0;
        c.fillStyle = isDark ? '#e0e0e0' : '#ffffff';
        c.fillRect(x, y, size, size);
      }
    }
  }

  function coverRect(srcW, srcH, dstW, dstH) {
    const r = Math.max(dstW / srcW, dstH / srcH);
    const w = srcW * r, h = srcH * r;
    const x = (dstW - w) / 2, y = (dstH - h) / 2;
    return { dx: x, dy: y, dw: w, dh: h };
  }

  // Event wiring
  modeEraseBtn.addEventListener('click', () => setMode('erase'));
  modeRestoreBtn.addEventListener('click', () => setMode('restore'));
  brushSlider.addEventListener('input', () => setBrush(parseInt(brushSlider.value, 10)));

  canvas.addEventListener('pointerdown', (e) => {
    if (!originalImg) return;
    canvas.setPointerCapture(e.pointerId);
    drawing = true; const p = getCanvasPos(e); lastX = p.x; lastY = p.y;
    // reset stroke buffer for a new stroke
    strokeCtx.clearRect(0, 0, strokeCanvas.width, strokeCanvas.height);
    drawStroke(lastX, lastY, lastX, lastY);
    composeAndRender();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = getCanvasPos(e);
    hoverX = p.x; hoverY = p.y;
    if (!drawing) { composeAndRender(); return; }
    drawStroke(lastX, lastY, p.x, p.y);
    lastX = p.x; lastY = p.y;
    composeAndRender();
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drawing) {
      // apply stroke buffer to mask according to mode
      if (mode === 'erase') {
        maskCtx.save();
        maskCtx.globalCompositeOperation = 'destination-out';
        maskCtx.drawImage(strokeCanvas, 0, 0);
        maskCtx.restore();
      } else {
        maskCtx.save();
        maskCtx.globalCompositeOperation = 'source-over';
        maskCtx.drawImage(strokeCanvas, 0, 0);
        maskCtx.restore();
      }
      strokeCtx.clearRect(0, 0, strokeCanvas.width, strokeCanvas.height);
      composeAndRender();
    }
    drawing = false; canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointercancel', () => { drawing = false; });

  bgFile.addEventListener('change', async () => {
    if (!bgFile.files || !bgFile.files[0]) return;
    const file = bgFile.files[0];
    const reader = new FileReader();
    reader.onload = async () => {
      try { bgImg = await dataURLToImage(reader.result); composeAndRender(); } catch {}
    };
    reader.readAsDataURL(file);
  });

  // Remove background image button
  if (removeBgBtn) {
    removeBgBtn.addEventListener('click', () => { bgImg = null; composeAndRender(); });
  }

  acceptBtn.addEventListener('click', () => {
    // Build final image on an offscreen canvas WITHOUT checkerboard.
    if (!originalImg) return;
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const outCtx = out.getContext('2d');
    outCtx.clearRect(0, 0, out.width, out.height);

    // Optional background image
    if (bgImg) {
      const { dx, dy, dw, dh } = coverRect(bgImg.width, bgImg.height, out.width, out.height);
      outCtx.drawImage(bgImg, dx, dy, dw, dh);
    }

    // Masked original
    const masked = document.createElement('canvas');
    masked.width = out.width; masked.height = out.height;
    const mctx = masked.getContext('2d');
    mctx.drawImage(originalImg, 0, 0, masked.width, masked.height);
    mctx.globalCompositeOperation = 'destination-in';
    mctx.drawImage(maskCanvas, 0, 0);
    mctx.globalCompositeOperation = 'source-over';
    outCtx.drawImage(masked, 0, 0);

    const dataUrl = out.toDataURL('image/png');
    vscode.postMessage({ type: 'acceptPngDataUrl', dataUrl });
  });

  cancelBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancelEdit' });
  });

  // VS Code API
  // Signal readiness so the extension can send initial images reliably
  window.addEventListener('load', () => {
    vscode.postMessage({ type: 'ready' });
  });
  window.addEventListener('message', async (event) => {
    const msg = event.data || {};
    if (msg.type === 'init') {
      try {
        originalImg = await dataURLToImage(msg.original);
        cutoutImg = await dataURLToImage(msg.cutout);
        resizeCanvases(cutoutImg.width, cutoutImg.height);
        initMaskFromCutout(cutoutImg);
        setMode('erase');
        setBrush(parseInt(brushSlider.value, 10));
        composeAndRender();
      } catch (e) {
        console.error('Failed to init images', e);
      }
    }
  });

  // Cursor/preview handling
  canvas.style.cursor = 'crosshair';
  canvas.addEventListener('pointermove', (e) => {
    const p = getCanvasPos(e);
    hoverX = p.x; hoverY = p.y;
    if (!drawing) {
      // re-render preview circle only
      composeAndRender();
    }
  });

  // Optional: hover circle preview on top of stroke overlay
  const _composeBase = composeAndRender;
  composeAndRender = function() {
    _composeBase();
    if (hoverX != null && hoverY != null) {
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = (mode === 'erase') ? '#ff0000' : '#00aa00';
      ctx.beginPath();
      ctx.arc(hoverX, hoverY, brushSize / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  };
})();
