'use strict';
(() => {
  const PENDING_KEY = 'mirHelperPendingSisnStart';
  const MAX_PENDING_AGE_MS = 10 * 60 * 1000;
  const STATUS_ID = 'mir-helper-sisn-status';
  const CHECK_INTERVAL_MS = 1000;
  const MODULE_NEXT_CLICKS_REQUIRED = 4;
  const MODULE_NEXT_CLICK_DELAY_MS = 250;
  const MODULE_PAGE_SETTLE_MS = 350;
  const MODULE_PAGE_SETTLE_TIMEOUT_MS = 45000;
  const MODULE_POLL_MS = 150;
  const SCROLL_SETTLE_MS = 150;
  const UPLOAD_SELECTION_SETTLE_MS = 800;
  const UPLOAD_SELECTION_POLL_MS = 100;
  const SISN_LOCK_OVERLAY_ID = 'mir-helper-sisn-lock-overlay';
  const SISN_LOCK_EVENTS = [
    'beforeinput',
    'input',
    'keydown',
    'keypress',
    'keyup',
    'paste',
    'cut',
    'drop',
    'dragover',
    'pointerdown',
    'pointerup',
    'mousedown',
    'mouseup',
    'click',
    'dblclick',
    'contextmenu',
    'touchstart',
    'touchend'
  ];
  let automationRunning = false;
  let uploadAttemptRunning = false;
  let lastPageSignature = '';
  let lastUploadAttemptAt = 0;
  let uploadContinueClicked = false;
  let moduleAdvanceRunning = false;
  let moduleNextClicksDone = 0;
  let moduleAttentionRecoveryAttempted = false;
  let extensionContextInvalidated = false;
  console.info('[Italy MIR Helper] SISN content script loaded:', location.href);
  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
  function normalize(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }
  function getElementText(el) {
    if (!el) return '';
    return [
      el.innerText,
      el.textContent,
      el.value,
      el.title,
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('sr-text'),
      el.getAttribute?.('label')
    ]
      .filter(Boolean)
      .join(' ');
  }
  function getOwnText(el) {
    if (!el) return '';
    return Array.from(el.childNodes || [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.nodeValue || '')
      .join(' ');
  }
  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      style.opacity !== '0'
    );
  }
  function isDisabled(el) {
    if (!el) return true;
    return Boolean(
      el.disabled ||
      el.getAttribute?.('aria-disabled') === 'true' ||
      /\bdisabled\b/i.test(el.className || '')
    );
  }
  function centerOf(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      rect
    };
  }
  function eventOptions(point, detail = 1) {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail,
      clientX: Math.round(point.x),
      clientY: Math.round(point.y),
      screenX: Math.round(window.screenX + point.x),
      screenY: Math.round(window.screenY + point.y)
    };
  }
  function clickAt(el, point = null) {
    if (!el) return false;
    try {
      el.scrollIntoView?.({ behavior: 'auto', block: 'center', inline: 'center' });
    } catch (_) {}
    const p = point || centerOf(el);
    const opts = eventOptions(p, 1);
    try { el.focus?.(); } catch (_) {}
    if (typeof PointerEvent !== 'undefined') {
      for (const eventName of ['pointerover', 'pointermove', 'pointerdown', 'pointerup']) {
        el.dispatchEvent(new PointerEvent(eventName, {
          ...opts,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: eventName.endsWith('down') ? 1 : 0
        }));
      }
    }
    for (const eventName of ['mouseover', 'mousemove', 'mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(eventName, opts));
    }
    return true;
  }
  function clickPoint(point) {
    const el = document.elementFromPoint(point.x, point.y);
    if (!el) return false;
    return clickAt(el, point);
  }
  function blockTrustedSisnLockEvent(event) {
    if (!sisnLockInstalled || !event?.isTrusted) return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
  }
  function ensureSisnLockOverlay(message = 'SISN automation is running. Please wait...') {
    if (!document.documentElement) return;
    let overlay = document.getElementById(SISN_LOCK_OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = SISN_LOCK_OVERLAY_ID;
      overlay.setAttribute('role', 'status');
      overlay.setAttribute('aria-live', 'polite');
      overlay.innerHTML = '<div class="mir-helper-sisn-lock-card"><div class="mir-helper-title">SISN is locked</div><div class="mir-helper-body"></div></div>';
      document.documentElement.appendChild(overlay);
    }
    const body = overlay.querySelector('.mir-helper-body');
    if (body) body.textContent = message;
  }
  function setSisnUserLock(locked, message) {
    if (locked) {
      if (!sisnLockInstalled) {
        SISN_LOCK_EVENTS.forEach((eventName) => {
          window.addEventListener(eventName, blockTrustedSisnLockEvent, { capture: true });
          document.addEventListener(eventName, blockTrustedSisnLockEvent, { capture: true });
        });
        sisnLockInstalled = true;
      }
      ensureSisnLockOverlay(message);
      return;
    }
    if (sisnLockInstalled) {
      SISN_LOCK_EVENTS.forEach((eventName) => {
        window.removeEventListener(eventName, blockTrustedSisnLockEvent, { capture: true });
        document.removeEventListener(eventName, blockTrustedSisnLockEvent, { capture: true });
      });
      sisnLockInstalled = false;
    }
    document.getElementById(SISN_LOCK_OVERLAY_ID)?.remove();
  }
  let statusHideTimer = null;
    function showStatus(message, isError = false, autoHideMs = 0) {
    let box = document.getElementById(STATUS_ID);
    if (!box) {
        box = document.createElement('div');
        box.id = STATUS_ID;
        box.className = 'mir-helper-sisn-status';
        document.documentElement.appendChild(box);
    }
    if (statusHideTimer) {
        window.clearTimeout(statusHideTimer);
        statusHideTimer = null;
    }
    box.textContent = message;
    box.classList.toggle('mir-helper-error', Boolean(isError));
    if (autoHideMs > 0) {
        statusHideTimer = window.setTimeout(() => {
        const currentBox = document.getElementById(STATUS_ID);
        if (currentBox && currentBox.textContent === message) {
            currentBox.remove();
        }
        statusHideTimer = null;
        }, autoHideMs);
    }
  }
  function optionRegex() {
    return /\bi\s*don['’]?t\s+have\s+any\s+code\b/i;
  }
  function isNoCodeText(text) {
    return optionRegex().test(String(text || ''));
  }
  function makeTextRange(textNode, start, end) {
    try {
      const range = document.createRange();
      range.setStart(textNode, Math.max(0, start));
      range.setEnd(textNode, Math.min(textNode.nodeValue.length, end));
      return range;
    } catch (_) {
      return null;
    }
  }
  function findNoCodeTextTargets() {
    if (!document.body) return [];
    const targets = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const text = node.nodeValue || '';
          if (!isNoCodeText(text)) return NodeFilter.FILTER_REJECT;
          if (!node.parentElement || !isVisible(node.parentElement)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || '';
      const match = text.match(optionRegex());
      if (!match || typeof match.index !== 'number') continue;
      const range = makeTextRange(node, match.index, match.index + match[0].length);
      if (!range) continue;
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      range.detach?.();
      for (const rect of rects) {
        const parent = node.parentElement;
        const fullText = normalize(getElementText(parent));
        const parentRect = parent.getBoundingClientRect();
        if (/\bcus\b/i.test(fullText) && /\bmfr\s*ref\b/i.test(fullText) && !isNoCodeText(getOwnText(parent))) continue;
        if (parentRect.height > 140 || parentRect.width > 1100) continue;
        targets.push({
          label: parent,
          textNode: node,
          text,
          rect,
          score: Math.abs(rect.width - 140) + (parentRect.height > 70 ? 40 : 0)
        });
      }
    }
    targets.sort((a, b) => a.score - b.score);
    return targets;
  }
  function collectNoCodeElementTargets() {
    const selector = [
      'label',
      'span',
      'div',
      'p',
      'mat-radio-button',
      'ds-radio',
      '[role="radio"]',
      '.mat-radio-label-content',
      '.mdc-label',
      '.form-check-label'
    ].join(',');
    const candidates = [];
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (!isVisible(el)) continue;
      const ownText = normalize(getOwnText(el));
      const fullText = normalize(getElementText(el));
      const rect = el.getBoundingClientRect();
      if (!isNoCodeText(ownText) && !isNoCodeText(fullText)) continue;
      if (/\bcus\b/i.test(fullText) && /\bmfr\s*ref\b/i.test(fullText) && !isNoCodeText(ownText)) continue;
      if (rect.height > 140 || rect.width > 1100) continue;
      candidates.push({
        label: el,
        rect,
        text: fullText,
        score: (isNoCodeText(ownText) ? 0 : 30) + Math.abs(fullText.length - "i don't have any code".length)
      });
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates;
  }
  function uniqueElements(elements) {
    const seen = new Set();
    return elements.filter((el) => {
      if (!el || seen.has(el)) return false;
      seen.add(el);
      return true;
    });
  }
  function parentChain(el, maxDepth = 8) {
    const list = [];
    let cur = el;
    let depth = 0;
    while (cur && cur instanceof Element && depth < maxDepth) {
      list.push(cur);
      cur = cur.parentElement;
      depth += 1;
    }
    return list;
  }
  function getVisibleRadioLikes() {
    const selector = [
      'input[type="radio"]',
      '[role="radio"]',
      'mat-radio-button',
      'ds-radio',
      '.mat-radio-button',
      '.mat-mdc-radio-button',
      '.mdc-radio',
      '.mat-radio-container',
      '.mat-radio-outer-circle',
      '.form-check-input'
    ].join(',');
    return Array.from(document.querySelectorAll(selector)).filter((el) => {
      if (isVisible(el)) return true;
      return el.matches?.('input[type="radio"]') && Boolean(el.offsetParent || el.parentElement);
    });
  }
  function scoreRadioAgainstLabel(radio, labelRect) {
    const r = radio.getBoundingClientRect();
    const labelCenterY = labelRect.top + labelRect.height / 2;
    const centerY = r.top + r.height / 2;
    const centerX = r.left + r.width / 2;
    const yPenalty = Math.abs(centerY - labelCenterY) * 5;
    const xPenalty = centerX <= labelRect.left ? Math.abs(labelRect.left - centerX) : 200 + Math.abs(centerX - labelRect.left);
    const sizePenalty = (r.width > 80 || r.height > 80) ? 60 : 0;
    return yPenalty + xPenalty + sizePenalty;
  }
  function findClosestRadioToLabel(labelRect) {
    const radios = getVisibleRadioLikes();
    const scored = radios
      .map((radio) => ({ radio, score: scoreRadioAgainstLabel(radio, labelRect) }))
      .sort((a, b) => a.score - b.score);
    return scored[0]?.radio || null;
  }
  function radioContainerFor(el) {
    if (!el) return null;
    return el.closest?.('label, mat-radio-button, ds-radio, [role="radio"], .mat-radio-button, .mat-mdc-radio-button, .form-check') || el;
  }
  function findPointTargetsToLeftOfLabel(labelRect) {
    const y = labelRect.top + labelRect.height / 2;
    const offsets = [18, 24, 32, 40, 50, 64];
    const targets = [];
    for (const offset of offsets) {
      const x = Math.max(1, labelRect.left - offset);
      const el = document.elementFromPoint(x, y);
      if (!el) continue;
      targets.push(radioContainerFor(el), el);
    }
    return uniqueElements(targets).filter(Boolean);
  }
  function findNoCodeOption() {
    const textTargets = findNoCodeTextTargets();
    const elementTargets = collectNoCodeElementTargets();
    const candidates = [...textTargets, ...elementTargets];
    for (const candidate of candidates) {
      const label = candidate.label;
      const labelRect = candidate.rect || label.getBoundingClientRect();
      const targets = [];
      const forId = label.getAttribute?.('for');
      if (forId) targets.push(document.getElementById(forId));
      for (const parent of parentChain(label, 6)) {
        const radioInput = parent.querySelector?.('input[type="radio"]');
        if (radioInput) targets.push(radioInput);
        if (parent.matches?.('label, mat-radio-button, ds-radio, [role="radio"], .mat-radio-button, .mat-mdc-radio-button, .form-check')) {
          targets.push(parent);
        }
      }
      targets.push(...findPointTargetsToLeftOfLabel(labelRect));
      targets.push(findClosestRadioToLabel(labelRect));
      targets.push(label);
      return {
        label,
        labelRect,
        targets: uniqueElements(targets).filter(Boolean),
        method: textTargets.includes(candidate) ? 'exact-text-node' : 'element-text'
      };
    }
    const bodyText = normalize(document.body?.innerText || document.body?.textContent || '');
    if (/\bcus\b/i.test(bodyText) && /\bmfr\s*ref\b/i.test(bodyText) && /i don['’]?t have any code/i.test(bodyText)) {
      const visibleRadios = getVisibleRadioLikes()
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.top === br.top ? ar.left - br.left : ar.top - br.top;
        });
      if (visibleRadios[2]) {
        return {
          label: null,
          labelRect: visibleRadios[2].getBoundingClientRect(),
          targets: [visibleRadios[2]],
          method: 'third-visible-radio-fallback'
        };
      }
    }
    return null;
  }
  function checkedStateNearNoCode(option) {
    const labels = option?.label ? [option.label] : collectNoCodeElementTargets().map((c) => c.label);
    for (const label of labels) {
      for (const parent of parentChain(label, 6)) {
        const radioInput = parent.querySelector?.('input[type="radio"]');
        if (radioInput?.checked) return true;
        const checkedRole = parent.matches?.('[role="radio"][aria-checked="true"]') ? parent : parent.querySelector?.('[role="radio"][aria-checked="true"]');
        if (checkedRole) return true;
        if (/\b(checked|selected|active)\b/i.test(parent.className || '') && parent.matches?.('mat-radio-button, ds-radio, [role="radio"], .mat-radio-button, .mat-mdc-radio-button')) {
          return true;
        }
      }
    }
    return false;
  }
  function setRadioCheckedIfInput(target) {
    const input = target?.matches?.('input[type="radio"]')
      ? target
      : target?.querySelector?.('input[type="radio"]');
    if (!input) return false;
    input.checked = true;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return true;
  }
  function findEnabledContinueButton() {
    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], ds-button'))
      .filter(isVisible)
      .filter((el) => /\bcontinue\b/i.test(getElementText(el)))
      .filter((el) => {
        const text = normalize(getElementText(el));
        const rect = el.getBoundingClientRect();
        return text.length <= 120 && rect.width > 20 && rect.height > 15 && !isDisabled(el);
      });

    return buttons[0] || null;
  }
  function findEnabledButtonByLabel(labelRegex) {
    const candidates = deepQuerySelectorAll((el) => {
      if (!el.matches?.('button, a, [role="button"], input[type="button"], input[type="submit"], ds-button')) return false;
      if (!isVisible(el)) return false;
      if (isDisabled(el)) return false;
      const text = normalize(getElementText(el));
      const rect = el.getBoundingClientRect();
      if (text.length > 160 || rect.width <= 20 || rect.height <= 15) return false;
      return labelRegex.test(text);
    });
    return candidates
      .map((el) => {
        const text = normalize(getElementText(el));
        const rect = el.getBoundingClientRect();
        const exactPenalty = /^next$/.test(text) || /^continue$/.test(text) ? 0 : 20;
        const bottomPreference = Math.max(0, window.innerHeight - rect.bottom);
        const rightPreference = Math.max(0, window.innerWidth - rect.right);
        return { el, score: exactPenalty + bottomPreference / 20 + rightPreference / 100 };
      })
      .sort((a, b) => a.score - b.score)[0]?.el || null;
  }
  function findEnabledNextButton() {
    return findEnabledButtonByLabel(/\bnext\b/i);
  }
  function getScrollableElements() {
    const roots = [document.scrollingElement, document.documentElement, document.body].filter(Boolean);
    const extra = Array.from(document.querySelectorAll('main, app-root, app-main-layout, app-create-report-module, .container, .row, div'))
      .filter((el) => {
        try {
          const style = window.getComputedStyle(el);
          return el.scrollHeight > el.clientHeight + 80 && /(auto|scroll|overlay)/i.test(`${style.overflowY} ${style.overflow}`);
        } catch (_) {
          return false;
        }
      });
    return uniqueElements([...roots, ...extra]);
  }
  function getScrollSignature() {
    const scrollables = getScrollableElements()
      .map((el) => `${Math.round(el.scrollTop)}:${Math.round(el.scrollHeight)}:${Math.round(el.clientHeight)}`)
      .join('|');
    return [
      Math.round(window.scrollY || document.documentElement?.scrollTop || 0),
      Math.round(document.body?.scrollHeight || 0),
      Math.round(document.documentElement?.scrollHeight || 0),
      scrollables
    ].join('|');
  }
  async function scrollAllTheWayDown() {
    let lastSignature = '';
    let stablePasses = 0;
    for (let i = 0; i < 5; i += 1) {
      const maxDocHeight = Math.max(
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0,
        document.scrollingElement?.scrollHeight || 0
      );
      try { window.scrollTo({ top: maxDocHeight, left: 0, behavior: i === 0 ? 'smooth' : 'auto' }); } catch (_) {
        try { window.scrollTo(0, maxDocHeight); } catch (__) {}
      }
      for (const el of getScrollableElements()) {
        try { el.scrollTop = el.scrollHeight; } catch (_) {}
      }
      await sleep(SCROLL_SETTLE_MS);
      const signature = getScrollSignature();
      if (signature === lastSignature) {
        stablePasses += 1;
        if (stablePasses >= 2) return;
      } else {
        lastSignature = signature;
        stablePasses = 0;
      }
    }
  }
  async function waitForModuleTransition(previousFingerprint, timeoutMs = 12000, intervalMs = MODULE_POLL_MS) {
    const start = Date.now();
    await sleep(MODULE_NEXT_CLICK_DELAY_MS);
    while (Date.now() - start < timeoutMs) {
      if (getBlockingAttentionMessage()) return 'attention';
      if (!isModuleReportPage() || hasObviousLoadingState()) return 'transitioning';
      if (getModulePageFingerprint() !== previousFingerprint) return 'changed';
      await sleep(intervalMs);
    }
    return 'unchanged';
  }
  function getModulePageFingerprint() {
    const bodyText = String(document.body?.innerText || document.body?.textContent || '');
    return JSON.stringify({
      href: location.href,
      height: Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0),
      textLength: bodyText.length,
      nextEnabled: Boolean(findEnabledNextButton()),
      uploadPage: hasUploadPageText() || hasFileInput()
    });
  }
  function hasObviousLoadingState() {
    const text = normalize(document.body?.innerText || document.body?.textContent || '');
    if (/\bloading\b|caricamento|please wait|attendere/i.test(text)) return true;
    return Boolean(deepQuerySelectorAll((el) => {
      const tag = String(el.tagName || '').toLowerCase();
      const cls = String(el.className || '');
      const ariaBusy = String(el.getAttribute?.('aria-busy') || '').toLowerCase();
      if (ariaBusy === 'true') return true;
      if (/spinner|progress|loading|loader|mat-progress|cdk-overlay-backdrop/i.test(`${tag} ${cls}`) && isVisible(el)) return true;
      return false;
    }).length);
  }
  async function waitForStableModulePage(timeoutMs = MODULE_PAGE_SETTLE_TIMEOUT_MS, stableMs = MODULE_PAGE_SETTLE_MS) {
    const start = Date.now();
    let lastFingerprint = '';
    let stableSince = 0;
    while (Date.now() - start < timeoutMs) {
      if (getBlockingAttentionMessage()) return 'attention';
      if (!isModuleReportPage() || hasObviousLoadingState()) {
        lastFingerprint = '';
        stableSince = 0;
        await sleep(MODULE_POLL_MS);
        continue;
      }
      const fingerprint = getModulePageFingerprint();
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= stableMs) {
        return true;
      }
      await sleep(MODULE_POLL_MS);
    }
    return false;
  }
  function isModuleReportPage() {
    if (hasUploadPageText() || hasFileInput()) return false;
    if (!/create-report-module/i.test(location.href)) return false;
    return Boolean(findEnabledNextButton()) || /\bnext\b/i.test(document.body?.innerText || document.body?.textContent || '');
  }
  async function waitForCusContinueOutcome(timeoutMs = 10000, intervalMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (hasCusNotFoundDialog()) return 'cus-not-found';
      if (hasUploadPageText() || hasFileInput()) return 'upload-page';
      await sleep(intervalMs);
    }
    if (hasCusNotFoundDialog()) return 'cus-not-found';
    if (hasUploadPageText() || hasFileInput()) return 'upload-page';
    return 'unknown';
  }
  async function clickUploadContinueAfterXmlSelected() {
    if (uploadContinueClicked) return true;
    const selectedNames = getSelectedFileNames();
    if (!selectedNames.some((name) => /\.xml$/i.test(name))) return false;
    showStatus(`Selected XML file: ${selectedNames[0]}. Clicking CONTINUE...`);
    const continueButton = await waitFor(findEnabledContinueButton, 20000, 400);
    if (!continueButton) {
      showStatus('The XML was selected, but the upload CONTINUE button was not available.', true);
      console.warn('[Italy MIR Helper] Upload CONTINUE button was not available after XML selection.', { selectedNames });
      return false;
    }
    console.info('[Italy MIR Helper] Clicking upload CONTINUE after XML selection.', { selectedNames });
    clickAt(continueButton);
    uploadContinueClicked = true;
    return true;
  }
  async function autoAdvanceModulePages() {
    if (moduleAdvanceRunning) return false;
    if (moduleNextClicksDone >= MODULE_NEXT_CLICKS_REQUIRED) return true;
    moduleAdvanceRunning = true;
    try {
      while (moduleNextClicksDone < MODULE_NEXT_CLICKS_REQUIRED) {
        let attentionAction = await handleModuleAttentionIfPresent('before module page wait');
        if (attentionAction === 'recovered') continue;
        if (attentionAction === 'stop') return false;
        const modulePageState = await waitForModuleReportPageOrAttention(45000, MODULE_POLL_MS);
        if (modulePageState === 'attention') {
          attentionAction = await handleModuleAttentionIfPresent('while waiting for module page');
          if (attentionAction === 'recovered') continue;
          return false;
        }
        if (modulePageState !== 'module') {
          showStatus(`Could not find the report review page before NEXT click ${moduleNextClicksDone + 1}.`, true);
          console.warn('[Italy MIR Helper] Module report page not ready for auto NEXT.', {
            href: location.href,
            moduleNextClicksDone
          });
          return false;
        }
        const clickNumber = moduleNextClicksDone + 1;
        showStatus(`Waiting for page to finish loading before NEXT ${clickNumber} of ${MODULE_NEXT_CLICKS_REQUIRED}...`);
        const stable = await waitForStableModulePage();
        if (stable === 'attention') {
          const attentionAction = await handleModuleAttentionIfPresent(`while waiting for page to settle before NEXT ${clickNumber}`);
          if (attentionAction === 'recovered') continue;
          return false;
        }
        if (!stable) {
          const attentionAction = await handleModuleAttentionIfPresent(`after page did not settle before NEXT ${clickNumber}`);
          if (attentionAction === 'recovered') continue;
          if (attentionAction === 'stop') return false;
          showStatus(`The report page did not settle before NEXT ${clickNumber}. Automation stopped.`, true);
          console.warn('[Italy MIR Helper] Module page did not settle before NEXT click.', {
            href: location.href,
            moduleNextClicksDone,
            fingerprint: getModulePageFingerprint()
          });
          clearPending();
          return false;
        }
        showStatus(`Scrolling to the bottom and clicking NEXT ${clickNumber} of ${MODULE_NEXT_CLICKS_REQUIRED}...`);
        await scrollAllTheWayDown();
        await sleep(SCROLL_SETTLE_MS);
        attentionAction = await handleModuleAttentionIfPresent(`before clicking NEXT ${clickNumber}`);
        if (attentionAction === 'recovered') continue;
        if (attentionAction === 'stop') return false;
        const nextButton = await waitFor(findEnabledNextButton, 20000, MODULE_POLL_MS);
        if (!nextButton) {
          showStatus(`Could not find an enabled NEXT button for step ${clickNumber}.`, true);
          console.warn('[Italy MIR Helper] Enabled NEXT button not found.', {
            href: location.href,
            moduleNextClicksDone,
            bodyTail: String(document.body?.innerText || '').slice(-500)
          });
          return false;
        }
        console.info('[Italy MIR Helper] Clicking SISN NEXT button.', {
          clickNumber,
          requiredClicks: MODULE_NEXT_CLICKS_REQUIRED,
          href: location.href,
          buttonText: getElementText(nextButton),
          rect: (() => {
            const r = nextButton.getBoundingClientRect();
            return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
          })()
        });
        const previousFingerprint = getModulePageFingerprint();
        clickAt(nextButton);
        moduleNextClicksDone += 1;
        const transitionState = await waitForModuleTransition(previousFingerprint);
        if (transitionState === 'unchanged') {
          console.info('[Italy MIR Helper] Module page did not visibly change after NEXT; continuing with normal readiness checks.', {
            clickNumber,
            href: location.href
          });
        }
        attentionAction = await handleModuleAttentionIfPresent(`after clicking NEXT ${clickNumber}`);
        if (attentionAction === 'recovered') continue;
        if (attentionAction === 'stop') return false;
      }
      showStatus('Completed.', false, 5000);
      clearPending();
      return true;
    } finally {
      moduleAdvanceRunning = false;
    }
  }
  function hasReferenceCodePageText() {
    const text = normalize(document.body?.innerText || document.body?.textContent || '');
    return (
      /do you have a report reference code/i.test(text) ||
      (/\bcus\b/i.test(text) && /\bmfr\s*ref\b/i.test(text) && /i don['’]?t have any code/i.test(text))
    );
  }
  function walkDeep(root, visit) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = root.nodeType === Node.ELEMENT_NODE ? root : walker.nextNode();
    while (node) {
      visit(node);
      if (node.shadowRoot) walkDeep(node.shadowRoot, visit);
      node = walker.nextNode();
    }
  }
  function deepQuerySelectorAll(predicate) {
    const results = [];
    walkDeep(document, (el) => {
      try {
        if (predicate(el)) results.push(el);
      } catch (_) {}
    });
    return results;
  }
  function getBlockingDialogType(text) {
    const value = String(text || '');
    if (/\battention\b/i.test(value) && /missing or invalid fields|please check the following sections|section\s+2\.3|section\s+2\.4|declaration/i.test(value)) {
      return 'validation-attention';
    }
    if (/submit report now\?/i.test(value) && /you['’]?re about to submit this mir|after submission|yes,?\s*submit/i.test(value)) {
      return 'submit-confirmation';
    }
    return '';
  }
  function isVisibleBlockingDialogCandidate(el, text) {
    if (!el || !(el instanceof Element)) return false;
    const tag = String(el.tagName || '').toLowerCase();
    if (/^(html|head|body|script|style|link|meta|router-outlet)$/i.test(tag)) return false;
    if (!isVisible(el)) return false;
    const rect = el.getBoundingClientRect?.();
    if (!rect) return false;
    if (rect.width < 240 || rect.height < 90) return false;
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) return false;
    if (rect.width > window.innerWidth * 0.96 && rect.height > window.innerHeight * 0.90) return false;
    const className = String(el.className || '');
    const role = String(el.getAttribute?.('role') || '').toLowerCase();
    const looksLikeDialog = (
      tag === 'app-dialog-error' ||
      tag === 'app-dialog-confirm' ||
      role === 'dialog' ||
      role === 'alertdialog' ||
      /dialog|modal|overlay|cdk-overlay|mat-mdc-dialog|global-overlays__overlay|attention/i.test(className)
    );
    if (looksLikeDialog) return true;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const centeredEnough = centerX > window.innerWidth * 0.20 && centerX < window.innerWidth * 0.80 && centerY > window.innerHeight * 0.15 && centerY < window.innerHeight * 0.85;
    const compactEnough = rect.width <= Math.min(1200, window.innerWidth * 0.85) && rect.height <= Math.min(650, window.innerHeight * 0.75);
    const hasDialogActions = /close|no,?\s*remain|yes,?\s*submit|download xml/i.test(text);
    return centeredEnough && compactEnough && hasDialogActions;
  }
  function getBlockingAttentionMessage() {
    const visibleDialogCandidates = deepQuerySelectorAll((el) => {
      const text = String(getElementText(el) || '').replace(/\s+/g, ' ').trim();
      if (!getBlockingDialogType(text)) return false;
      return isVisibleBlockingDialogCandidate(el, text);
    });
    const sorted = visibleDialogCandidates
      .map((el) => {
        const rect = el.getBoundingClientRect?.() || { width: 0, height: 0, left: 0, top: 0 };
        const text = String(getElementText(el) || '').replace(/\s+/g, ' ').trim();
        const tag = String(el.tagName || '').toLowerCase();
        const role = String(el.getAttribute?.('role') || '').toLowerCase();
        const className = String(el.className || '');
        const type = getBlockingDialogType(text);
        const typePriority = type === 'submit-confirmation' ? -20 : 0;
        const dialogPriority = tag.startsWith('app-dialog') ? 0 : (role.includes('dialog') ? 5 : (/dialog|modal|overlay/i.test(className) ? 10 : 25));
        const centerPenalty = Math.abs((rect.left + rect.width / 2) - window.innerWidth / 2) / 100 + Math.abs((rect.top + rect.height / 2) - window.innerHeight / 2) / 100;
        return { el, text, score: typePriority + dialogPriority + centerPenalty + Math.max(0, 800 - rect.width) / 250 };
      })
      .sort((a, b) => a.score - b.score);
    if (sorted[0]?.text) return sorted[0].text;
    return '';
  }
  function stopWithAttentionMessage(message, context = '') {
    const shortMessage = message.length > 240 ? `${message.slice(0, 240)}...` : message;
    setSisnUserLock(false);
    showStatus(`SISN showed a blocking popup. Automation stopped. ${shortMessage}`, true);
    console.warn('[Italy MIR Helper] Stopping automation because SISN displayed a blocking dialog.', {
      href: location.href,
      context,
      message
    });
    clearPending();
    return true;
  }
  function stopIfAttentionDialog() {
    const message = getBlockingAttentionMessage();
    if (!message) return false;
    return stopWithAttentionMessage(message);
  }
  function findAttentionDialogElement() {
    const candidates = deepQuerySelectorAll((el) => {
      const text = String(getElementText(el) || '').replace(/\s+/g, ' ').trim();
      if (!getBlockingDialogType(text)) return false;
      return isVisibleBlockingDialogCandidate(el, text);
    });
    return candidates
      .map((el) => {
        const rect = el.getBoundingClientRect?.() || { width: 0, height: 0, top: 0, left: 0 };
        const tag = String(el.tagName || '').toLowerCase();
        const role = String(el.getAttribute?.('role') || '').toLowerCase();
        const className = String(el.className || '');
        const priority = tag.startsWith('app-dialog') ? 0 :
          (role.includes('dialog') || role.includes('alertdialog') ? 5 :
            (/dialog|modal|overlay|cdk-overlay|mat-mdc-dialog/i.test(className) ? 10 : 30));
        const centerPenalty = Math.abs((rect.left + rect.width / 2) - window.innerWidth / 2) / 100 + Math.abs((rect.top + rect.height / 2) - window.innerHeight / 2) / 100;
        return { el, rect, score: priority + centerPenalty + Math.abs(rect.width - 850) / 100 + Math.abs(rect.height - 300) / 100 };
      })
      .sort((a, b) => a.score - b.score)[0]?.el || null;
  }
  function isPointInsideRect(pointRect, containerRect) {
    const cx = pointRect.left + pointRect.width / 2;
    const cy = pointRect.top + pointRect.height / 2;
    return cx >= containerRect.left && cx <= containerRect.right && cy >= containerRect.top && cy <= containerRect.bottom;
  }
  function findAttentionCloseButton(dialog) {
    const dialogRect = dialog?.getBoundingClientRect?.();
    const candidates = deepQuerySelectorAll((el) => {
      if (!el.matches?.('button, a, [role="button"], ds-button, mat-icon, svg, .close, [aria-label]')) return false;
      if (!isVisible(el)) return false;
      const rect = el.getBoundingClientRect();
      if (dialogRect && !isPointInsideRect(rect, dialogRect)) return false;
      const text = normalize(getElementText(el));
      const cls = String(el.className || '');
      return /close|chiudi|dismiss|×|x/i.test(text) || /close|times|xmark|cancel/i.test(cls) || rect.width <= 80;
    });
    return candidates
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = normalize(getElementText(el));
        const topRightScore = dialogRect ? Math.abs(rect.top - (dialogRect.top + 30)) + Math.abs(rect.right - (dialogRect.right - 25)) : 0;
        const textBonus = /close|chiudi|dismiss|×|x/i.test(text) ? -50 : 0;
        return { el, score: topRightScore + textBonus };
      })
      .sort((a, b) => a.score - b.score)[0]?.el || null;
  }
  async function closeAttentionDialog() {
    const dialog = findAttentionDialogElement();
    for (const eventName of ['keydown', 'keyup']) {
      document.dispatchEvent(new KeyboardEvent(eventName, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent(eventName, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    }
    await sleep(600);
    if (!getBlockingAttentionMessage()) return true;
    const closeButton = findAttentionCloseButton(dialog);
    if (closeButton) {
      clickAt(closeButton);
      await waitFor(() => !getBlockingAttentionMessage(), 5000, 200);
      if (!getBlockingAttentionMessage()) return true;
    }
    if (dialog) {
      const rect = dialog.getBoundingClientRect();
      clickPoint({ x: Math.max(1, rect.right - 34), y: Math.max(1, rect.top + 34) });
      await waitFor(() => !getBlockingAttentionMessage(), 5000, 200);
      if (!getBlockingAttentionMessage()) return true;
    }
    return !getBlockingAttentionMessage();
  }
  function getCusNotFoundDialogElement() {
    const candidates = deepQuerySelectorAll((el) => {
      const text = String(getElementText(el) || '').replace(/\s+/g, ' ').trim();
      if (!/\bcus\s+not\s+found\b/i.test(text)) return false;
      if (!isVisible(el)) return false;
      return isVisibleBlockingDialogCandidate(el, text) || /dialog|modal|overlay|notice/i.test(`${el.tagName || ''} ${el.className || ''}`);
    });
    return candidates
      .map((el) => {
        const rect = el.getBoundingClientRect?.() || { width: 0, height: 0, top: 0, left: 0 };
        const tag = String(el.tagName || '').toLowerCase();
        const role = String(el.getAttribute?.('role') || '').toLowerCase();
        const className = String(el.className || '');
        const priority = tag.includes('dialog') ? 0 : (role.includes('dialog') ? 5 : (/dialog|modal|overlay|notice/i.test(className) ? 10 : 30));
        const centerPenalty = Math.abs((rect.left + rect.width / 2) - window.innerWidth / 2) / 100 + Math.abs((rect.top + rect.height / 2) - window.innerHeight / 2) / 100;
        return { el, score: priority + centerPenalty + Math.max(0, 700 - rect.width) / 250 };
      })
      .sort((a, b) => a.score - b.score)[0]?.el || null;
  }
  function hasCusNotFoundDialog() {
    return Boolean(getCusNotFoundDialogElement());
  }
  function findCusNotFoundCloseButton(dialog) {
    const dialogRect = dialog?.getBoundingClientRect?.();
    const candidates = deepQuerySelectorAll((el) => {
      if (!el.matches?.('button, a, [role="button"], ds-icon-button, lion-icon, svg, .close, .close-button, [aria-label]')) return false;
      if (!isVisible(el)) return false;
      const rect = el.getBoundingClientRect();
      if (dialogRect && !isPointInsideRect(rect, dialogRect)) return false;
      const text = normalize(getElementText(el));
      const cls = String(el.className || '');
      const iconId = String(el.getAttribute?.('icon-id') || '');
      const icoType = String(el.getAttribute?.('ico-type') || '');
      return /close|chiudi|dismiss|×|x/i.test(text) || /close|chiudi|times|xmark|cancel/i.test(`${cls} ${iconId} ${icoType}`) || (dialogRect && rect.top < dialogRect.top + 90 && rect.right > dialogRect.right - 120);
    });
    return candidates
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = normalize(getElementText(el));
        const topRightScore = dialogRect ? Math.abs(rect.top - (dialogRect.top + 30)) + Math.abs(rect.right - (dialogRect.right - 25)) : 0;
        const textBonus = /close|chiudi|dismiss|×|x/i.test(text) ? -50 : 0;
        return { el, score: topRightScore + textBonus };
      })
      .sort((a, b) => a.score - b.score)[0]?.el || null;
  }
  async function closeCusNotFoundDialog() {
    const dialog = getCusNotFoundDialogElement();
    const closeButton = findCusNotFoundCloseButton(dialog);
    if (closeButton) {
      clickAt(closeButton);
      await waitFor(() => !hasCusNotFoundDialog(), 5000, 200);
      if (!hasCusNotFoundDialog()) return true;
    }
    if (dialog) {
      const rect = dialog.getBoundingClientRect();
      clickPoint({ x: Math.max(1, rect.right - 34), y: Math.max(1, rect.top + 34) });
      await waitFor(() => !hasCusNotFoundDialog(), 5000, 200);
      if (!hasCusNotFoundDialog()) return true;
    }
    for (const eventName of ['keydown', 'keyup']) {
      document.dispatchEvent(new KeyboardEvent(eventName, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent(eventName, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    }
    await waitFor(() => !hasCusNotFoundDialog(), 3000, 200);
    return !hasCusNotFoundDialog();
  }
  function promptCusNotFoundChoice(cusCode) {
    return new Promise((resolve) => {
      setSisnUserLock(false);
      document.getElementById('mir-helper-cus-not-found-choice')?.remove();
      const overlay = document.createElement('div');
      overlay.id = 'mir-helper-cus-not-found-choice';
      overlay.innerHTML = `
        <div class="mir-helper-choice-card" role="dialog" aria-modal="true" aria-labelledby="mir-helper-cus-not-found-title">
          <div id="mir-helper-cus-not-found-title" class="mir-helper-title">CUS not found</div>
          <div class="mir-helper-body">SISN could not find${cusCode ? ` ${cusCode}` : ' the CUS'}. Choose how to continue.</div>
          <button type="button" class="mir-helper-primary" data-choice="submit-new">Submit as new, I don't have a valid CUS</button>
          <button type="button" class="mir-helper-secondary" data-choice="edit-stop">Edit CUS and Stop Automation</button>
        </div>`;
      overlay.addEventListener('click', (event) => {
        const button = event.target?.closest?.('button[data-choice]');
        if (!button) return;
        const choice = button.getAttribute('data-choice');
        overlay.remove();
        resolve(choice);
      });
      document.documentElement.appendChild(overlay);
    });
  }
  function findEnabledBackButton() {
    const candidates = deepQuerySelectorAll((el) => {
      if (!el.matches?.('button, a, [role="button"], input[type="button"], input[type="submit"], ds-button')) return false;
      if (!isVisible(el) || isDisabled(el)) return false;
      const text = normalize(getElementText(el));
      const rect = el.getBoundingClientRect();
      return /^back$/.test(text) && rect.width > 20 && rect.height > 15;
    });
    return candidates
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const bottomPreference = Math.max(0, window.innerHeight - rect.bottom);
        const leftPreference = Math.max(0, rect.left);
        return { el, score: bottomPreference / 10 + leftPreference / 100 };
      })
      .sort((a, b) => a.score - b.score)[0]?.el || null;
  }
  async function handleModuleAttentionIfPresent(context = '') {
    const message = getBlockingAttentionMessage();
    if (!message) return 'none';
    stopWithAttentionMessage(message, context);
    return 'stop';
  }
  async function waitForModuleReportPageOrAttention(timeoutMs = 45000, intervalMs = 500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (getBlockingAttentionMessage()) return 'attention';
      if (isModuleReportPage()) return 'module';
      await sleep(intervalMs);
    }
    return null;
  }
  function getFileInputsDeep() {
    return deepQuerySelectorAll((el) => el.matches?.('input[type="file"]'));
  }
  function hasUploadPageText() {
    const text = normalize(document.body?.innerText || document.body?.textContent || '');
    return /upload your xml report file/i.test(text) || /you can upload a xml file/i.test(text) || /you can upload an? xml file/i.test(text);
  }
  function hasFileInput() {
    return getFileInputsDeep().length > 0;
  }
  function getSelectedFileNames() {
    const files = [];
    for (const input of getFileInputsDeep()) {
      for (const file of Array.from(input.files || [])) {
        files.push(file.name);
      }
    }
    return [...new Set(files)];
  }
  function hasSelectedXmlFile() {
    return getSelectedFileNames().some((name) => /\.xml$/i.test(name));
  }
  function getRootHost(el) {
    try {
      const root = el?.getRootNode?.();
      return root?.host || null;
    } catch (_) {
      return null;
    }
  }
  function findRadioInputInside(el) {
    if (!el) return null;
    if (el.matches?.('input[type="radio"]')) return el;
    const direct = el.querySelector?.('input[type="radio"]');
    if (direct) return direct;
    const shadow = el.shadowRoot?.querySelector?.('input[type="radio"]');
    if (shadow) return shadow;
    return null;
  }
  function findLabelInside(el) {
    if (!el) return null;
    if (el.matches?.('label')) return el;
    return el.shadowRoot?.querySelector?.('label') || el.querySelector?.('label') || null;
  }
  function isNoCodeValue(el) {
    return /^nocode$/i.test(String(el?.value || el?.getAttribute?.('value') || '').trim());
  }
  function isDsInputRadio(el) {
    return String(el?.tagName || '').toLowerCase() === 'ds-input-radio';
  }
  function findDirectNoCodeRadioTarget() {
    const hosts = deepQuerySelectorAll((el) => isDsInputRadio(el))
      .map((host) => {
        const hostText = getElementText(host);
        const input = findRadioInputInside(host);
        const label = findLabelInside(host);
        let score = 9999;
        if (isNoCodeText(host.getAttribute?.('label'))) score = 0;
        else if (isNoCodeValue(input)) score = 5;
        else if (isNoCodeText(hostText)) score = 15;
        return { host, input, label, score, hostText };
      })
      .filter((item) => item.score < 9999)
      .sort((a, b) => a.score - b.score);
    if (hosts[0]) {
      const item = hosts[0];
      const anchor = item.input || item.label || item.host;
      const rectSource = isVisible(item.label) ? item.label : (isVisible(item.host) ? item.host : anchor);
      return {
        method: 'ds-input-radio-nocode',
        host: item.host,
        input: item.input,
        label: item.label,
        labelRect: rectSource?.getBoundingClientRect?.() || null,
        targets: uniqueElements([item.input, item.label, item.host].filter(Boolean)),
        debugText: item.hostText
      };
    }
    const inputs = deepQuerySelectorAll((el) => el.matches?.('input[type="radio"]') && isNoCodeValue(el));
    if (inputs[0]) {
      const input = inputs[0];
      const host = input.closest?.('ds-input-radio, label, [role="radio"]') || getRootHost(input);
      const label = findLabelInside(host) || (input.id ? deepQuerySelectorAll((el) => el.matches?.('label') && el.getAttribute('for') === input.id)[0] : null);
      const rectSource = isVisible(label) ? label : (isVisible(host) ? host : input);
      return {
        method: 'native-radio-value-nocode',
        host,
        input,
        label,
        labelRect: rectSource?.getBoundingClientRect?.() || null,
        targets: uniqueElements([input, label, host].filter(Boolean)),
        debugText: `input[value=${input.value}] ${getElementText(host)}`
      };
    }
    const byLabelAttribute = deepQuerySelectorAll((el) => isNoCodeText(el.getAttribute?.('label')));
    if (byLabelAttribute[0]) {
      const host = byLabelAttribute[0];
      const input = findRadioInputInside(host);
      const label = findLabelInside(host);
      const rectSource = isVisible(label) ? label : (isVisible(host) ? host : input || host);
      return {
        method: 'label-attribute-nocode',
        host,
        input,
        label,
        labelRect: rectSource?.getBoundingClientRect?.() || null,
        targets: uniqueElements([input, label, host].filter(Boolean)),
        debugText: getElementText(host)
      };
    }
    return null;
  }
  function checkedDirectNoCode(option) {
    const input = option?.input || findRadioInputInside(option?.host);
    if (input?.checked) return true;
    const host = option?.host || getRootHost(input);
    if (host?.matches?.('[aria-checked="true"]')) return true;
    if (host?.getAttribute?.('checked') === 'true') return true;
    if (/\b(checked|selected|active)\b/i.test(host?.className || '')) return true;
    return false;
  }
  async function clickDirectNoCodeOption(option) {
    const input = option?.input || findRadioInputInside(option?.host);
    const label = option?.label || findLabelInside(option?.host);
    const host = option?.host || getRootHost(input);
    console.info('[Italy MIR Helper] Direct NoCode radio target:', {
      method: option?.method,
      hostTag: host?.tagName,
      hostLabel: host?.getAttribute?.('label'),
      inputValue: input?.value,
      inputId: input?.id,
      labelText: String(getElementText(label) || '').slice(0, 120),
      hostText: String(option?.debugText || getElementText(host) || '').slice(0, 180),
      targetCount: option?.targets?.length || 0
    });
    if (input) {
      try { input.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' }); } catch (_) {}
      try { input.focus?.(); } catch (_) {}
      try { input.click?.(); } catch (_) {}
      await sleep(150);
      input.checked = true;
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      await sleep(250);
      if (checkedDirectNoCode(option)) return true;
    }
    for (const target of uniqueElements([label, host, ...(option?.targets || [])].filter(Boolean))) {
      clickAt(target);
      await sleep(150);
      if (input) {
        input.checked = true;
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }
      target.dispatchEvent?.(new Event('input', { bubbles: true, composed: true }));
      target.dispatchEvent?.(new Event('change', { bubbles: true, composed: true }));
      await sleep(250);
      if (checkedDirectNoCode(option)) return true;
    }
    return Boolean(input);
  }
  async function waitFor(conditionFn, timeoutMs = 20000, intervalMs = 500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = conditionFn();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  }
  function getRuntimeLastErrorMessage() {
    try {
      return globalThis.chrome?.runtime?.lastError?.message || '';
    } catch (error) {
      return error?.message || String(error);
    }
  }
  function isExtensionContextAvailable() {
    try {
      return Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome?.storage?.local);
    } catch (error) {
      return false;
    }
  }
  function extensionContextUnavailableResult() {
    const error = 'Extension context invalidated. Please reload the SISN tab after updating or reloading the extension.';
    if (!extensionContextInvalidated) {
      extensionContextInvalidated = true;
      showStatus(error, true);
      console.warn('[Italy MIR Helper] SISN automation paused:', error);
    }
    return error;
  }
  function getPending() {
    return new Promise((resolve) => {
      if (!isExtensionContextAvailable()) {
        extensionContextUnavailableResult();
        resolve(null);
        return;
      }
      try {
        chrome.storage.local.get(PENDING_KEY, (result) => {
          const lastErrorMessage = getRuntimeLastErrorMessage();
          if (lastErrorMessage) {
            console.warn('[Italy MIR Helper] Storage read failed:', lastErrorMessage);
            resolve(null);
            return;
          }
          const pending = result?.[PENDING_KEY];
          if (!pending?.value) {
            resolve(null);
            return;
          }
          if (Date.now() - Number(pending.createdAt || 0) > MAX_PENDING_AGE_MS) {
            clearPending();
            resolve(null);
            return;
          }
          resolve(pending);
        });
      } catch (error) {
        console.warn('[Italy MIR Helper] Storage read failed:', error?.message || error);
        if (/Extension context invalidated/i.test(error?.message || String(error))) extensionContextUnavailableResult();
        resolve(null);
      }
    });
  }
  function clearPending() {
    if (!isExtensionContextAvailable()) {
      setSisnUserLock(false);
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: 'MIR_HELPER_CLEAR_PENDING' });
    } catch (error) {
      console.warn('[Italy MIR Helper] Could not clear pending SISN automation:', error?.message || error);
      if (/Extension context invalidated/i.test(error?.message || String(error))) extensionContextUnavailableResult();
    } finally {
      setSisnUserLock(false);
    }
  }
  function findXmlUploadProxyInput() {
    return deepQuerySelectorAll((el) => {
      if (!el.matches?.('input[readonly], input[type="text"], ds-input, ds-input-upload, ds-input-upload-core')) {
        return false;
      }
      if (!isVisible(el)) return false;
      const text = normalize([
        el.value,
        el.placeholder,
        el.getAttribute?.('aria-label'),
        el.getAttribute?.('aria-labelledby'),
        getElementText(el),
        getElementText(el.closest?.('ds-input-upload, ds-input-upload-core, ds-input, .form-field, div') || el)
      ].join(' '));
      return /upload your xml report file/i.test(text);
    })[0] || null;
  }
  async function primeXmlUploadControl() {
    const proxy = findXmlUploadProxyInput();
    if (!proxy) return false;
    const host =
      proxy.closest?.('ds-input-upload, ds-input-upload-core, ds-input, .form-field, div') ||
      proxy;
    try {
      host.scrollIntoView?.({ behavior: 'auto', block: 'center', inline: 'center' });
    } catch (_) {}
    clickAt(host);
    await sleep(100);
    clickAt(proxy);
    await sleep(250);
    console.info('[Italy MIR Helper] Primed SISN XML upload control.', {
      proxyTag: proxy.tagName,
      proxyId: proxy.id,
      proxyValue: proxy.value,
      hostTag: host.tagName,
      fileInputsAfterPrime: getFileInputsDeep().length
    });
    return true;
  }
  function sendUploadMessage() {
    return new Promise((resolve) => {
      if (!isExtensionContextAvailable()) {
        resolve({ ok: false, error: extensionContextUnavailableResult() });
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: 'MIR_HELPER_UPLOAD_LATEST_XML' }, (response) => {
          const lastErrorMessage = getRuntimeLastErrorMessage();
          if (lastErrorMessage) {
            resolve({ ok: false, error: lastErrorMessage });
            return;
          }
          resolve(response || { ok: false, error: 'No response from extension service worker.' });
        });
      } catch (error) {
        const message = error?.message || String(error);
        if (/Extension context invalidated/i.test(message)) extensionContextUnavailableResult();
        resolve({ ok: false, error: message });
      }
    });
  }
  function isCusValue(el) {
    return /^cus$/i.test(String(el?.value || el?.getAttribute?.('value') || '').trim());
  }
  function findDirectCusRadioTarget() {
    const hosts = deepQuerySelectorAll((el) => isDsInputRadio(el))
      .map((host) => {
        const hostText = getElementText(host);
        const input = findRadioInputInside(host);
        const label = findLabelInside(host);
        let score = 9999;
        if (/^cus$/i.test(String(host.getAttribute?.('label') || '').trim())) score = 0;
        else if (isCusValue(input)) score = 5;
        else if (/\bcus\b/i.test(hostText) && !/don['’]?t|mfr\s*ref/i.test(hostText)) score = 20;
        return { host, input, label, score, hostText };
      })
      .filter((item) => item.score < 9999)
      .sort((a, b) => a.score - b.score);
    if (hosts[0]) {
      const item = hosts[0];
      return {
        method: 'ds-input-radio-cus',
        host: item.host,
        input: item.input,
        label: item.label,
        targets: uniqueElements([item.input, item.label, item.host].filter(Boolean)),
        debugText: item.hostText
      };
    }
    const input = deepQuerySelectorAll((el) => el.matches?.('input[type="radio"]') && isCusValue(el))[0];
    if (input) {
      const host = input.closest?.('ds-input-radio, label, [role="radio"]') || getRootHost(input);
      const label = findLabelInside(host);
      return {
        method: 'native-radio-value-cus',
        host,
        input,
        label,
        targets: uniqueElements([input, label, host].filter(Boolean)),
        debugText: `input[value=${input.value}] ${getElementText(host)}`
      };
    }
    return null;
  }
  function checkedDirectRadio(option) {
    const input = option?.input || findRadioInputInside(option?.host);
    if (input?.checked) return true;
    const host = option?.host || getRootHost(input);
    if (host?.matches?.('[aria-checked="true"]')) return true;
    if (host?.getAttribute?.('checked') === 'true') return true;
    if (/\b(checked|selected|active)\b/i.test(host?.className || '')) return true;
    return false;
  }
  async function clickDirectRadioOption(option) {
    const input = option?.input || findRadioInputInside(option?.host);
    const label = option?.label || findLabelInside(option?.host);
    const host = option?.host || getRootHost(input);
    if (input) {
      input.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' });
      input.focus?.();
      input.click?.();
      await sleep(150);
      input.checked = true;
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      if (checkedDirectRadio(option)) return true;
    }
    for (const target of uniqueElements([label, host, ...(option?.targets || [])].filter(Boolean))) {
      clickAt(target);
      await sleep(150);
      if (input) {
        input.checked = true;
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }
      if (checkedDirectRadio(option)) return true;
    }
    return Boolean(input);
  }
  function findCusTextInput() {
    return deepQuerySelectorAll((el) => {
      if (!el.matches?.('input[type="text"], input:not([type]), textarea')) return false;
      if (!isVisible(el) || isDisabled(el)) return false;
      const joined = [
        el.id,
        el.name,
        el.getAttribute?.('formcontrolname'),
        el.getAttribute?.('placeholder'),
        el.getAttribute?.('aria-label'),
        el.getAttribute?.('label'),
        getElementText(el.closest?.('ds-input, form, .col-4, .form-field') || el)
      ].join(' ');
      return /\bcus\b/i.test(joined);
    })[0] || null;
  }
  function setTextInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ||
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, composed: true }));
  }
  async function selectCusAndContinue(cusCode) {
    showStatus(`Selecting CUS and entering ${cusCode}...`);
    const option = await waitFor(findDirectCusRadioTarget, 35000, 500);
    if (!option) {
      showStatus('Could not find the CUS option; using no-code flow.', true);
      return false;
    }
    await clickDirectRadioOption(option);
    const input = await waitFor(findCusTextInput, 20000, 400);
    if (!input) {
      showStatus('Could not find the CUS entry field; using no-code flow.', true);
      return false;
    }
    input.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' });
    input.focus?.();
    setTextInputValue(input, cusCode);
    await sleep(500);
    const continueButton = await waitFor(findEnabledContinueButton, 15000, 400);
    if (!continueButton) {
      showStatus('CUS needs to be fixed', true);
      clearPending();
      return 'stop';
    }
    showStatus('Opening the XML upload step...');
    clickAt(continueButton);
    const outcome = await waitForCusContinueOutcome(10000, 100);
    if (outcome === 'cus-not-found') {
      const choice = await promptCusNotFoundChoice(cusCode);
      await closeCusNotFoundDialog();
      if (choice === 'submit-new') {
        setSisnUserLock(true, 'Continuing SISN automation with “I don’t have any code”. Please wait...');
        showStatus('CUS not found. Restarting with “I don’t have any code”...');
        return false;
      }
      setSisnUserLock(false);
      showStatus('CUS not found. Automation stopped so you can edit the CUS.', true, 10000);
      clearPending();
      return 'stop';
    }
    return true;
  }
  async function selectNoCodeAndContinue() {
    showStatus('Selecting “I don’t have any code”...');
    const directOption = await waitFor(findDirectNoCodeRadioTarget, 35000, 500);
    if (directOption) {
      const directClicked = await clickDirectNoCodeOption(directOption);
      const continueButton = await waitFor(findEnabledContinueButton, 15000, 400);
      if (continueButton) {
        showStatus('Opening the XML upload step...');
        console.info('[Italy MIR Helper] Clicking first CONTINUE button after direct NoCode selection.', {
          selectedVerified: checkedDirectNoCode(directOption),
          directClicked
        });
        clickAt(continueButton);
        return true;
      }
      showStatus('No-code was found, but CONTINUE did not become enabled.', true);
      console.warn('[Italy MIR Helper] CONTINUE was not enabled after direct NoCode selection.', {
        selectedVerified: checkedDirectNoCode(directOption),
        directClicked
      });
      return false;
    }
    const option = await waitFor(findNoCodeOption, 10000, 500);
    if (!option?.targets?.length) {
      showStatus('Could not find “I don’t have any code”.', true);
      console.warn('[Italy MIR Helper] Could not find “I don\'t have any code” option.');
      return false;
    }
    console.info('[Italy MIR Helper] Fallback no-code option candidates:', {
      method: option.method,
      labelText: String(getElementText(option.label) || '').slice(0, 160),
      labelRect: option.labelRect ? {
        left: Math.round(option.labelRect.left),
        top: Math.round(option.labelRect.top),
        width: Math.round(option.labelRect.width),
        height: Math.round(option.labelRect.height)
      } : null,
      targetCount: option.targets.length,
      targets: option.targets.slice(0, 8).map((target) => ({
        tag: target.tagName,
        text: String(getElementText(target) || '').slice(0, 80),
        className: String(target.className || '').slice(0, 80)
      }))
    });
    for (const target of option.targets) {
      const targetText = normalize(getElementText(target));
      if (/^cus$/.test(targetText) || /^mfr\s*ref$/.test(targetText) || /\bcus\b.*\bmfr\s*ref\b/i.test(targetText)) {
        continue;
      }
      clickAt(target);
      setRadioCheckedIfInput(target);
      await sleep(250);
      if (checkedStateNearNoCode(option)) break;
    }
    const continueButton = await waitFor(findEnabledContinueButton, 15000, 400);
    if (!continueButton) {
      showStatus('The CONTINUE button did not become enabled after selecting no-code.', true);
      console.warn('[Italy MIR Helper] CONTINUE was not enabled after fallback no-code selection.', {
        selectedVerified: checkedStateNearNoCode(option)
      });
      return false;
    }
    showStatus('Opening the XML upload step...');
    console.info('[Italy MIR Helper] Clicking first CONTINUE button after fallback selection.');
    clickAt(continueButton);
    return true;
  }
  async function selectDownloadedXmlOnUploadPage() {
    if (uploadAttemptRunning) return false;
    if (hasSelectedXmlFile()) {
      return await clickUploadContinueAfterXmlSelected();
    }
    if (Date.now() - lastUploadAttemptAt < 1000) return false;
    lastUploadAttemptAt = Date.now();
    uploadAttemptRunning = true;
    try {
      showStatus('Selecting the downloaded XML file...');
      primeXmlUploadControl();
      console.info('[Italy MIR Helper] Requesting latest XML download upload. Deep file inputs:', getFileInputsDeep().length);
      const response = await sendUploadMessage();
      if (!response?.ok) {
        showStatus(`Could not select the XML file: ${response?.error || 'unknown error'}`, true);
        console.warn('[Italy MIR Helper] XML upload selection failed:', response);
        return false;
      }
      await waitFor(
        () => hasSelectedXmlFile() || findEnabledContinueButton(),
        UPLOAD_SELECTION_SETTLE_MS,
        UPLOAD_SELECTION_POLL_MS
      );
      const selectedNames = getSelectedFileNames();
      const displayName = selectedNames[0] || response.filename;
      showStatus(`Selected XML file: ${displayName}. Clicking CONTINUE...`);
      console.info('[Italy MIR Helper] XML file selected on SISN upload page:', {
        response,
        selectedNames,
        deepFileInputs: getFileInputsDeep().length
      });
      const continueButton =
        findEnabledContinueButton() ||
        await waitFor(findEnabledContinueButton, 2500, UPLOAD_SELECTION_POLL_MS);
      if (continueButton) {
        showStatus(`XML file selected: ${displayName}. Clicking CONTINUE.`);
        clickAt(continueButton);
        uploadContinueClicked = true;
        return true;
      }
      return false;
    } finally {
      uploadAttemptRunning = false;
    }
  }
  async function runAutomationTick() {
    if (automationRunning) return;
    automationRunning = true;
    try {
      const pending = await getPending();
      if (!pending) {
        setSisnUserLock(false);
        return;
      }
      setSisnUserLock(true, 'SISN automation is running. Please wait until it completes or asks for input.');
      if (stopIfAttentionDialog()) return;
      const uploadPage = hasUploadPageText() || hasFileInput();
      const referencePage = hasReferenceCodePageText();
      const signature = JSON.stringify({
        uploadPage,
        referencePage,
        href: location.href
      });
      if (signature !== lastPageSignature) {
        lastPageSignature = signature;
        console.info('[Italy MIR Helper] SISN page state:', {
          uploadPage,
          referencePage,
          href: location.href,
          pending
        });
      }
      if (uploadPage) {
        await waitFor(() => hasUploadPageText() || hasFileInput(), 45000, 500);
        const continued = await selectDownloadedXmlOnUploadPage();
        if (continued) {
          showStatus('Waiting for the uploaded report to finish loading.');
          const moduleState = await waitForModuleReportPageOrAttention(45000, 500);
          if (moduleState === 'module') await autoAdvanceModulePages();
        }
        return;
      }
      if (isModuleReportPage()) {
        await autoAdvanceModulePages();
        return;
      }
      if (referencePage || /#\/?$/.test(location.hash || '')) {
        if (pending?.cusLookup?.pending) {
          setSisnUserLock(true, 'Waiting for the CRM CUS lookup. SISN will stay locked until the lookup finishes.');
          showStatus('Waiting for CRM CUS lookup while SISN loads...');
          return;
        }
        const cusCode = String(pending?.cusCode || '').trim();
        const cusMoveResult = cusCode ? await selectCusAndContinue(cusCode) : false;
        if (cusMoveResult === 'stop') return;
        const moved = cusMoveResult || await selectNoCodeAndContinue();
        if (moved) {
          await waitFor(() => hasUploadPageText() || hasFileInput(), 45000, 500);
          const continued = await selectDownloadedXmlOnUploadPage();
          if (continued) {
            const moduleState = await waitForModuleReportPageOrAttention(45000, 500);
            if (moduleState === 'module') await autoAdvanceModulePages();
          }
        }
      }
    } catch (error) {
      showStatus(`SISN automation failed: ${error?.message || String(error)}`, true);
      console.error('[Italy MIR Helper] SISN automation error:', error);
      clearPending();
    } finally {
      automationRunning = false;
    }
  }
  function boot() {
    runAutomationTick();
    let tickScheduled = false;
    function scheduleTick() {
      if (tickScheduled) return;
      tickScheduled = true;
      const run = () => {
        tickScheduled = false;
        runAutomationTick();
      };
      if ('requestIdleCallback' in window) {
        window.setTimeout(run, 0);
      } else {
        window.setTimeout(run, 500);
      }
    }
    window.setInterval(scheduleTick, 750);
    const observer = new MutationObserver(scheduleTick);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    window.addEventListener('hashchange', scheduleTick);
    window.addEventListener('popstate', scheduleTick);
  }
  boot();
})();