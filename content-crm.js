'use strict';
(() => {
  const REQUIRED_BCC = 'RS.ITALYMIRREPORTS@MEDTRONIC.COM';
  const POPUP_ID = 'mir-helper-popup';
  const CHECK_INTERVAL_MS = 1200;
  const XML_TEXT_RE = /\.xml\b/i;
  let userDismissed = false;
  let lastConditionState = false;
  let popupHideTimer = null;
  let crmLockInstalled = false;
  const CRM_LOCK_OVERLAY_ID = 'mir-helper-crm-lock-overlay';
  const CRM_LOCK_EVENTS = [
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
  let cusLookupState = { key: '', promise: null, searchedEventNumber: '' };
  let regulatoryReportsContainerCache = null;
  let regulatoryReportRowsCache = null;
  console.info('[Italy MIR Helper] GCH content script loaded:', {
    url: location.href,
    frame: window.top === window ? 'top' : 'iframe'
  });
  function blockTrustedCrmLockEvent(event) {
    if (!crmLockInstalled || !event?.isTrusted) return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
  }
  function ensureCrmLockOverlay(message = 'Looking up CUS in GCH. Please wait...') {
    if (window.top !== window || !document.documentElement) return;
    let overlay = document.getElementById(CRM_LOCK_OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = CRM_LOCK_OVERLAY_ID;
      overlay.setAttribute('role', 'status');
      overlay.setAttribute('aria-live', 'polite');
      overlay.innerHTML = '<div class="mir-helper-crm-lock-card"><div class="mir-helper-title">GCH is locked</div><div class="mir-helper-body"></div></div>';
      document.documentElement.appendChild(overlay);
    }
    const body = overlay.querySelector('.mir-helper-body');
    if (body) body.textContent = message;
  }
  function setCrmUserLock(locked, message) {
    if (locked) {
      if (!crmLockInstalled) {
        CRM_LOCK_EVENTS.forEach((eventName) => {
          window.addEventListener(eventName, blockTrustedCrmLockEvent, { capture: true });
          document.addEventListener(eventName, blockTrustedCrmLockEvent, { capture: true });
        });
        crmLockInstalled = true;
      }
      ensureCrmLockOverlay(message);
      console.info('[Italy MIR Helper] GCH user editing locked for automated CUS lookup:', {
        frame: window.top === window ? 'top' : 'iframe',
        url: location.href
      });
      return;
    }
    if (crmLockInstalled) {
      CRM_LOCK_EVENTS.forEach((eventName) => {
        window.removeEventListener(eventName, blockTrustedCrmLockEvent, { capture: true });
        document.removeEventListener(eventName, blockTrustedCrmLockEvent, { capture: true });
      });
      crmLockInstalled = false;
    }
    if (window.top === window) document.getElementById(CRM_LOCK_OVERLAY_ID)?.remove();
  }
  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
  function normalize(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  }
  function getElementText(el) {
    if (!el) return '';
    return [
      el.innerText,
      el.textContent,
      el.value,
      el.title,
      el.alt,
      el.name,
      el.id,
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('href')
    ]
      .filter(Boolean)
      .join(' ');
  }
  function extractCusCode(text) {
    const match = String(text || '')
      .replace(/\u00a0/g, ' ')
      .match(/\bCUS[\s-]+\d{2,4}-\d+\b/i);
    return match ? match[0].replace(/\s+/g, ' ').toUpperCase() : '';
  }
  function getPageSearchText() {
    const parts = [];
    if (document.body) {
      parts.push(document.body.innerText || document.body.textContent || '');
    }
    document.querySelectorAll('input, textarea, select, option').forEach((el) => {
      parts.push(getElementText(el));
    });
    document.querySelectorAll('[title], [aria-label], a[href], [onclick], [ondblclick]').forEach((el) => {
      parts.push(getElementText(el));
    });
    return normalize(parts.join('\n'));
  }
  function hasRequiredBcc() {
    return getPageSearchText().includes(REQUIRED_BCC);
  }
  function isVisibleElement(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function xmlNameFromText(text) {
    const match = String(text || '').match(/[^\n\r;|<>]*?\.xml\b/i);
    return match ? match[0].trim() : '';
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
  function textNodeIsVisible(textNode) {
    const parent = textNode.parentElement;
    if (!isVisibleElement(parent)) return false;
    const text = textNode.nodeValue || '';
    const xmlIndex = text.search(XML_TEXT_RE);
    if (xmlIndex < 0) return false;
    const range = makeTextRange(textNode, Math.max(0, xmlIndex - 8), Math.min(text.length, xmlIndex + 4));
    if (!range) return false;
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    range.detach?.();
    return rects.length > 0;
  }
  function findXmlTextTargets() {
    if (!document.body) return [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const text = node.nodeValue || '';
          if (!XML_TEXT_RE.test(text)) return NodeFilter.FILTER_REJECT;
          if (!node.parentElement) return NodeFilter.FILTER_REJECT;
          if (!textNodeIsVisible(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    const targets = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || '';
      const xmlIndex = text.search(XML_TEXT_RE);
      const start = Math.max(0, xmlIndex - 8);
      const end = Math.min(text.length, xmlIndex + 4);
      const range = makeTextRange(node, start, end);
      if (!range) continue;
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      range.detach?.();
      for (const rect of rects) {
        const point = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        };
        const elementAtPoint = document.elementFromPoint(point.x, point.y);
        const element = elementAtPoint || node.parentElement;
        targets.push({
          text,
          xmlName: xmlNameFromText(text),
          textNode: node,
          element,
          parent: node.parentElement,
          rect,
          point
        });
      }
    }
    targets.sort((a, b) => {
      const aArea = a.rect.width * a.rect.height;
      const bArea = b.rect.width * b.rect.height;
      return aArea - bArea;
    });
    return targets;
  }
  function findXmlElementTargets() {
    const selector = [
      'a',
      'button',
      '[role="button"]',
      '[onclick]',
      '[ondblclick]',
      'span',
      'td',
      'div',
      'input',
      'textarea'
    ].join(',');
    return Array.from(document.querySelectorAll(selector))
      .filter(isVisibleElement)
      .map((el) => {
        const text = getElementText(el);
        const xmlName = xmlNameFromText(text);
        const rect = el.getBoundingClientRect();
        return { el, text, xmlName, rect, normalized: normalize(text) };
      })
      .filter(({ normalized, xmlName }) => Boolean(xmlName) || /\.XML\b/.test(normalized))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      .sort((a, b) => {
        const aClickable = a.el.matches('a, button, [role="button"], [onclick], [ondblclick]') ? 0 : 1;
        const bClickable = b.el.matches('a, button, [role="button"], [onclick], [ondblclick]') ? 0 : 1;
        if (aClickable !== bClickable) return aClickable - bClickable;
        return (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
      });
  }
  function findXmlAttachmentTarget() {
    const textTargets = findXmlTextTargets();
    if (textTargets.length) return { type: 'text-point', ...textTargets[0] };
    const elementTargets = findXmlElementTargets();
    if (elementTargets.length) {
      const first = elementTargets[0];
      return {
        type: 'element',
        element: first.el,
        parent: first.el,
        xmlName: first.xmlName,
        text: first.text,
        rect: first.rect,
        point: {
          x: first.rect.left + first.rect.width / 2,
          y: first.rect.top + first.rect.height / 2
        }
      };
    }
    return null;
  }
  function hasXmlAttachment() {
    return Boolean(findXmlAttachmentTarget());
  }
  function removePopup() {
    if (popupHideTimer) {
        window.clearTimeout(popupHideTimer);
        popupHideTimer = null;
    }
    document.getElementById(POPUP_ID)?.remove();
  }
  function setStatus(message, isError = false, autoDismissMs = 0) {
    const status = document.getElementById('mir-helper-status');
    if (!status) return;
    if (popupHideTimer) {
        window.clearTimeout(popupHideTimer);
        popupHideTimer = null;
    }
    status.textContent = message;
    status.style.color = isError ? '#b00020' : '#17324d';
    if (!isError && autoDismissMs > 0) {
        popupHideTimer = window.setTimeout(() => {
        const currentStatus = document.getElementById('mir-helper-status');
        if (currentStatus && currentStatus.textContent === message) {
            userDismissed = true;
            document.getElementById(POPUP_ID)?.remove();
        }
        popupHideTimer = null;
        }, autoDismissMs);
    }
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
  function dispatchMouseSequence(el, point, detail = 1, preventClickDefault = false) {
    if (!el) return;
    const originalHref = el.getAttribute?.('href');
    for (const eventName of ['mouseover', 'mousemove', 'mousedown', 'mouseup', 'click']) {
      const event = new MouseEvent(eventName, eventOptions(point, detail));
      let cancelJavascriptHref = null;
      if (preventClickDefault && eventName === 'click') {
        cancelJavascriptHref = (clickEvent) => clickEvent.preventDefault();
        window.addEventListener('click', cancelJavascriptHref, { capture: true, once: true });
        if (hasJavascriptHref(el)) el.setAttribute('href', '#');
      }
      el.dispatchEvent(event);
      if (cancelJavascriptHref) {
        window.removeEventListener('click', cancelJavascriptHref, { capture: true });
        if (originalHref !== null && el.getAttribute?.('href') !== originalHref) el.setAttribute('href', originalHref);
      }
    }
  }
  function hasJavascriptHref(el) {
    return /^\s*javascript\s*:/i.test(el?.getAttribute?.('href') || '');
  }
  function activateElement(el, point, detail = 1) {
    if (!el) return;
    const preventClickDefault = hasJavascriptHref(el);
    dispatchPointerSequence(el, point, detail);
    dispatchMouseSequence(el, point, detail, preventClickDefault);
    if (!preventClickDefault) el.click?.();
  }
  function dispatchPointerSequence(el, point, detail = 1) {
    if (!el || typeof PointerEvent === 'undefined') return;
    for (const eventName of ['pointerover', 'pointermove', 'pointerdown', 'pointerup']) {
      el.dispatchEvent(new PointerEvent(eventName, {
        ...eventOptions(point, detail),
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: eventName.endsWith('down') ? 1 : 0
      }));
    }
  }
  function getSubjectValue() {
    const subjectId = document.getElementById('subject_id')?.value;
    const candidates = [
      subjectId ? document.getElementById(subjectId) : null,
      document.querySelector('input.GUIDE-Email[id$="_subjectField"]'),
      document.querySelector('input[id*="subjectField" i]'),
      ...Array.from(document.querySelectorAll('input')).filter((el) => /subject/i.test(`${el.id} ${el.name} ${el.className}`))
    ].filter(Boolean);
    return candidates.map((el) => el.value || el.getAttribute('value') || '').find(Boolean) || '';
  }
  function normalizeEventNumber(rawEventNumber) {
    const digits = String(rawEventNumber || '').replace(/\D/g, '');
    if (!digits) return '';
    return digits.length < 10 ? digits.padStart(10, '0') : digits;
  }
  function getEventInfoFromSubject() {
    const subject = getSubjectValue();
    const match = String(subject || '').match(/(?:^|\D)(\d{8,12})-(\d+)(?=\D|$)/);
    if (!match) return { subject, eventNumber: '', pliNumber: '', rawEventNumber: '' };
    return {
      subject,
      eventNumber: normalizeEventNumber(match[1]),
      rawEventNumber: match[1],
      pliNumber: match[2]
    };
  }
  function findQuickSearchInput() {
    return document.getElementById('C17_W52_V53_SearchValue') ||
      document.querySelector('input[id$="_SearchValue"]') ||
      document.querySelector('input[tempname$="_search_value"]') ||
      Array.from(document.querySelectorAll('input')).find((el) => /search[_-]?value|quicksearch/i.test(`${el.id} ${el.name} ${el.getAttribute('tempname') || ''}`));
  }
  function findQuickSearchGo() {
    const direct = document.getElementById('C17_W52_V53_QUICKSEARCH') ||
      document.querySelector('a[id$="_QUICKSEARCH"], button[id$="_QUICKSEARCH"], input[id$="_QUICKSEARCH"]');
    if (direct && isVisibleElement(direct)) return direct;
    return Array.from(document.querySelectorAll('a, button, [role="button"], input[type="button"], input[type="submit"]'))
      .find((el) => isVisibleElement(el) && /^go$/i.test(normalize(getFastElementText(el))));
  }
  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function isElementInViewport(el) {
    if (!el || !isVisibleElement(el)) return false;
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
  }
  function ensureElementInView(el) {
    if (!el || isElementInViewport(el)) return;
    el.scrollIntoView?.({ behavior: 'auto', block: 'center', inline: 'center' });
  }
  function nativeClickElement(el, point = null, detail = 1) {
    if (!el) return false;
    const p = point || centerOfElement(el);
    const preventJavascriptNavigation = hasJavascriptHref(el);
    dispatchPointerSequence(el, p, detail);
    for (const eventName of ['mouseover', 'mousemove', 'mousedown', 'mouseup']) {
      el.dispatchEvent(new MouseEvent(eventName, eventOptions(p, detail)));
    }
    const cancelJavascriptHref = (clickEvent) => {
      clickEvent.preventDefault();
    };
    if (preventJavascriptNavigation) {
      window.addEventListener('click', cancelJavascriptHref, {
        capture: true,
        once: true
      });
    }
    try {
      el.click?.();
    } finally {
      if (preventJavascriptNavigation) {
        window.removeEventListener('click', cancelJavascriptHref, {
          capture: true
        });
      }
    }
    return true;
  }
  async function performQuickSearch(eventNumber, timeoutMs = 8000) {
    const input = await waitFor(findQuickSearchInput, timeoutMs, 50);
    if (!input) throw new Error('Could not find the GCH quick-search input.');
    ensureElementInView(input);
    input.focus?.();
    setInputValue(input, eventNumber);
    await sleep(0);
    const go = findQuickSearchGo();
    if (go) {
      ensureElementInView(go);
      activateElement(go, centerOfElement(go));
    } else {
      for (const eventName of ['keydown', 'keypress', 'keyup']) {
        input.dispatchEvent(new KeyboardEvent(eventName, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        }));
      }
    }
  }
  function centerOfElement(el) {
    const rect = el?.getBoundingClientRect?.();
    if (
      rect &&
      Number.isFinite(rect.left) &&
      Number.isFinite(rect.top) &&
      rect.width > 0 &&
      rect.height > 0
    ) {
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return {
        x: Math.max(1, Math.min(window.innerWidth - 2, x)),
        y: Math.max(1, Math.min(window.innerHeight - 2, y))
      };
    }
    return {
      x: Math.max(1, Math.floor(window.innerWidth / 2)),
      y: Math.max(1, Math.floor(window.innerHeight / 2))
    };
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
  function getFastElementText(el) {
    if (!el) return '';
    return [
      el.textContent,
      el.value,
      el.title,
      el.alt,
      el.name,
      el.id,
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('href')
    ]
      .filter(Boolean)
      .join(' ');
  }
  function getRegulatoryReportsContainers() {
    const containers = [];
    const add = (el) => {
      if (!el || !(el instanceof Element) || !el.isConnected) return;
      if (containers.includes(el)) return;
      containers.push(el);
    };
    document.querySelectorAll('.RegulatoryReports').forEach(add);
    if (!containers.length) {
      const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6, legend, .section-header, .title, .header');
      for (const heading of headings) {
        if (!/regulatory report/i.test(getFastElementText(heading))) continue;
        add(heading.closest('.RegulatoryReports, .section, .panel, .ch-section, .th-section, div') || heading.parentElement);
      }
    }
    if (!containers.length) {
      for (const div of document.querySelectorAll('div')) {
        if (isVisibleElement(div) && /regulatory report/i.test(getFastElementText(div))) {
          add(div);
        }
      }
    }
    return containers;
  }
  function getRegulatoryReportsContainer() {
    const containers = getRegulatoryReportsContainers();
    regulatoryReportsContainerCache = containers[0] || null;
    return regulatoryReportsContainerCache;
  }
  function hasRegulatoryReportRows(container) {
    if (!container) return false;
    return Array.from(container.querySelectorAll('.item-number, a.GUIDE-sideNav, a'))
      .some((el) => {
        if (el.matches?.('.item-number')) return true;
        return isEuropeanVigilanceReportLink(el);
      });
  }
  function isRegulatoryReportsExpanded(container) {
    if (!container) return false;
    const wrapper = container.querySelector('.data-wrapper');
    if (wrapper && getComputedStyle(wrapper).display === 'none') return false;
    return hasRegulatoryReportRows(container);
  }
  async function expandRegulatoryReportsContainer(container) {
    if (!container) return null;
    if (isRegulatoryReportsExpanded(container)) return container;
    const clicker = container.querySelector('.clicker') || container;
    clicker.scrollIntoView?.({ behavior: 'auto', block: 'center', inline: 'center' });
    activateElement(clicker, centerOfElement(clicker));
    regulatoryReportRowsCache = null;
    await waitFor(() => isRegulatoryReportsExpanded(container), 1500, 75);
    return container;
  }
  async function expandAllRegulatoryReports() {
    const found = await waitFor(() => {
      const containers = getRegulatoryReportsContainers();
      return containers.length ? containers : null;
    }, 45000, 100);
    if (!found?.length) throw new Error('Could not find the GCH Regulatory Report section.');
    for (const container of found) {
      await expandRegulatoryReportsContainer(container);
      await sleep(100);
    }
    return getRegulatoryReportsContainers();
  }
  async function expandRegulatoryReports() {
    const containers = await expandAllRegulatoryReports();
    return containers[0] || null;
  }
  function escapeCssValue(value) {
    if (window.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
  function isEuropeanVigilanceReportLink(link) {
    if (!link) return false;
    const title = String(link.getAttribute?.('title') || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const text = String(getElementText(link) || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    return title === 'European Vigilance' || text === 'European Vigilance';
  }
  function getRegulatoryReportRows(container = getRegulatoryReportsContainer()) {
    if (!container) return [];
    if (regulatoryReportRowsCache?.container === container) return regulatoryReportRowsCache.rows;
    const dataRows = Array.from(container.querySelectorAll('.data'));
    const candidates = dataRows.length ? dataRows : Array.from(container.querySelectorAll('a.GUIDE-sideNav'));
    const rows = candidates
      .map((el, index) => makeRegulatoryReportRow(el, index))
      .filter(({ link }) => link && isEuropeanVigilanceReportLink(link));
    if (rows.length) regulatoryReportRowsCache = { container, rows };
    return rows;
  }
  function makeItemNumberPattern(itemNumber) {
    const item = String(itemNumber || '').trim();
    if (!item) return null;
    const escapedItem = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\(${escapedItem}\\)\\s*:`, 'i');
  }
  function makeRegulatoryReportRow(el, index = 0) {
    const row = el?.matches?.('.data') ? el : el?.closest?.('.data');
    const link = el?.matches?.('a') ? el : row?.querySelector?.('a.GUIDE-sideNav, a');
    const itemNumberEl = row?.querySelector?.('.item-number');
    const itemText = getFastElementText(itemNumberEl) || getFastElementText(row || el);
    const transId = link?.getAttribute?.('data-trans-id') || '';
    return { row, link, itemText, transId, index };
  }
  function findRegulatoryReportRowsByItemNumberFast(itemNumber, container = getRegulatoryReportsContainer()) {
    const itemNumberPattern = makeItemNumberPattern(itemNumber);
    if (!container || !itemNumberPattern) return [];
    const matches = [];
    const seenRows = new Set();
    for (const itemEl of Array.from(container.querySelectorAll('.item-number'))) {
      if (!itemNumberPattern.test(getFastElementText(itemEl))) continue;
      const row = itemEl.closest?.('.data') || itemEl.closest?.('tr, [role="row"], li, div');
      if (!row || seenRows.has(row)) continue;
      seenRows.add(row);
      const report = makeRegulatoryReportRow(row, matches.length);
      if (report.link && isEuropeanVigilanceReportLink(report.link)) matches.push(report);
    }
    if (matches.length) return matches;
    return Array.from(container.querySelectorAll('a.GUIDE-sideNav, a'))
      .filter(isEuropeanVigilanceReportLink)
      .map((link, index) => makeRegulatoryReportRow(link, index))
      .filter(({ itemText }) => itemNumberPattern.test(itemText));
  }
  function getRegulatoryReportRowsByItemNumber(itemNumber, container = getRegulatoryReportsContainer()) {
    const itemNumberPattern = makeItemNumberPattern(itemNumber);
    if (!itemNumberPattern || !container) return [];
    const fastRows = findRegulatoryReportRowsByItemNumberFast(itemNumber, container);
    if (fastRows.length) return fastRows;
    return getRegulatoryReportRows(container).filter(({ itemText }) => itemNumberPattern.test(itemText));
  }
  function getRegulatoryReportRowsByItemNumberAcrossContainers(itemNumber) {
    const results = [];
    const seen = new Set();
    getRegulatoryReportsContainers().forEach((container, containerIndex) => {
      const rows = getRegulatoryReportRowsByItemNumber(itemNumber, container);
      rows.forEach((row, matchIndex) => {
        const key = [
          containerIndex,
          row.transId || '',
          matchIndex,
          normalize(row.itemText || ''),
          normalize(getFastElementText(row.link) || '')
        ].join('|');
        if (seen.has(key)) return;
        seen.add(key);
        results.push({
          ...row,
          itemNumber,
          containerIndex,
          matchIndex
        });
      });
    });
    return results;
  }
  function getRegulatoryReportLink(report) {
    if (!report) return null;
    const containers = getRegulatoryReportsContainers();
    const container = Number.isInteger(report.containerIndex)
      ? containers[report.containerIndex]
      : getRegulatoryReportsContainer();
    if (!container) return null;
    if (report.transId) {
      const direct = container.querySelector(`a.GUIDE-sideNav[data-trans-id="${escapeCssValue(report.transId)}"]`);
      if (direct) return direct;
    }
    return getRegulatoryReportRowsByItemNumber(report.itemNumber, container)[report.matchIndex]?.link || null;
  }
  function getRbAcknowledgementElement() {
    return document.getElementById('GUIDE-RegReportDetails-RegulatoryBodyInfo-RBAcknowledgement') ||
      document.querySelector('[id*="RBAcknowledgement"]');
  }
  function getRegReportDetailsRoot() {
    const ack = getRbAcknowledgementElement();
    if (ack) {
      return ack.closest?.('[id*="RegReportDetails"], .RegReportDetails, .details, .section, .panel, table, div') || ack.parentElement;
    }
    const byId = document.querySelector('[id*="RegReportDetails"]');
    return byId?.closest?.('.RegReportDetails, .details, .section, .panel, div') || byId || null;
  }
  function getRbAcknowledgementText() {
    const cell = getRbAcknowledgementElement();
    if (cell) return getElementText(cell);
    const labels = Array.from(document.querySelectorAll('label'))
      .filter((label) => /RB\s*Acknowledgement\s*#?\s*:/i.test(getElementText(label)));
    for (const label of labels) {
      const labelTargetId = label.getAttribute('for');
      const target = labelTargetId ? document.getElementById(labelTargetId) : null;
      const targetText = getElementText(target);
      if (targetText) return targetText;
      const row = label.closest('tr, .ch-grid-row, .th-grid-row, [role="row"]');
      const rowText = getElementText(row);
      if (rowText) return rowText;
    }
    return null;
  }
  function readRbAcknowledgement() {
    const text = getRbAcknowledgementText();
    const directMatch = extractCusCode(text);
    if (directMatch) return directMatch;
    const root = getRegReportDetailsRoot();
    return root ? extractCusCode(getElementText(root)) : '';
  }
  function getRegReportDetailFingerprint() {
    const root = getRegReportDetailsRoot();
    const ack = getRbAcknowledgementText();
    const text = getFastElementText(root || getRbAcknowledgementElement() || document.body);
    return JSON.stringify({
      href: location.href,
      ack: normalize(ack || ''),
      cus: extractCusCode(text),
      len: text.length,
      head: normalize(text).slice(0, 800)
    });
  }
  function hasCrmLoadingState() {
    return Boolean(Array.from(document.querySelectorAll('[aria-busy="true"], .loading, .spinner, .progress, .progressBar, .wait, .busy'))
      .some(isVisibleElement));
  }
  async function waitForRegReportDetailAfterClick(beforeFingerprint, timeoutMs = 5000) {
    const start = Date.now();
    let lastFingerprint = '';
    let stableSince = 0;
    while (Date.now() - start < timeoutMs) {
      const cus = readRbAcknowledgement();
      if (cus) return true;
      if (hasCrmLoadingState()) {
        lastFingerprint = '';
        stableSince = 0;
        await sleep(50);
        continue;
      }
      const fingerprint = getRegReportDetailFingerprint();
      const ackTextKnown = getRbAcknowledgementText() !== null;
      if (ackTextKnown && fingerprint !== beforeFingerprint) {
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 125) {
          return true;
        }
      }
      await sleep(50);
    }
    return Boolean(readRbAcknowledgement());
  }
  async function runCusLookup({ eventNumber, pliNumber }) {
    if (cusLookupState.searchedEventNumber !== eventNumber) {
      regulatoryReportsContainerCache = null;
      regulatoryReportRowsCache = null;
      await performQuickSearch(eventNumber);
      cusLookupState.searchedEventNumber = eventNumber;
      await waitFor(getRegulatoryReportsContainer, 12000, 75);
    }
    const containers = await expandAllRegulatoryReports();
    const reports = await waitFor(() => {
      const found = getRegulatoryReportRowsByItemNumberAcrossContainers(pliNumber);
      return found.length ? found.map((report) => ({
        itemNumber: pliNumber,
        containerIndex: report.containerIndex,
        matchIndex: report.matchIndex,
        transId: report.transId,
        title: report.link?.getAttribute?.('title') || getFastElementText(report.link),
        itemText: report.itemText
      })) : null;
    }, 15000, 50);
    if (!reports?.length) {
      return {
        ok: true,
        cusCode: '',
        reason: `No Regulatory Report links found for item number ${pliNumber}.`
      };
    }
    console.info('[Italy MIR Helper] Regulatory Report candidates for CUS lookup:', {
      itemNumber: pliNumber,
      containerCount: containers.length,
      reportCount: reports.length,
      reports
    });
    for (const report of reports) {
      const link = getRegulatoryReportLink(report);
      if (!link) {
        console.warn('[Italy MIR Helper] Could not re-find Regulatory Report link:', report);
        continue;
      }
      if (isVisibleElement(link)) ensureElementInView(link);
      const beforeFingerprint = getRegReportDetailFingerprint();
      console.info('[Italy MIR Helper] Opening Regulatory Report candidate:', {
        itemNumber: report.itemNumber,
        containerIndex: report.containerIndex,
        matchIndex: report.matchIndex,
        transId: report.transId,
        title: report.title,
        linkText: getFastElementText(link)
      });
      activateElement(link, centerOfElement(link));
      await waitForRegReportDetailAfterClick(beforeFingerprint, 8000);
      const cusCode = readRbAcknowledgement();
      console.info('[Italy MIR Helper] RB Acknowledgement check result:', {
        itemNumber: report.itemNumber,
        containerIndex: report.containerIndex,
        matchIndex: report.matchIndex,
        cusCode
      });
      if (cusCode) return { ok: true, cusCode };
    }
    return {
      ok: true,
      cusCode: '',
      reason: `Regulatory Reports for item number ${pliNumber} did not have an RB Acknowledgement #.`
    };
  }
  async function findCusForEvent({ eventNumber, pliNumber }) {
    const key = `${eventNumber || ''}-${pliNumber || ''}`;
    if (cusLookupState.promise && cusLookupState.key === key) {
      console.info('[Italy MIR Helper] Reusing in-flight GCH CUS lookup:', key);
      return cusLookupState.promise;
    }
    cusLookupState.key = key;
    cusLookupState.promise = runCusLookup({ eventNumber, pliNumber })
      .finally(() => {
        if (cusLookupState.key === key) cusLookupState.promise = null;
      });
    return cusLookupState.promise;
  }
  function uniqueElements(elements) {
    const seen = new Set();
    return elements.filter((el) => {
      if (!el || seen.has(el)) return false;
      seen.add(el);
      return true;
    });
  }
  function usefulClickAncestors(el) {
    const results = [];
    let cur = el;
    let depth = 0;
    while (cur && cur instanceof Element && depth < 6) {
      if (
        cur.matches('a, button, [role="button"], [onclick], [ondblclick], span, td, tr, div') &&
        isVisibleElement(cur)
      ) {
        results.push(cur);
      }
      cur = cur.parentElement;
      depth += 1;
    }
    return uniqueElements(results);
  }
  async function clickXmlAttachment(targetInfo) {
    const point = targetInfo.point;
    const startElement = document.elementFromPoint(point.x, point.y) || targetInfo.element || targetInfo.parent;
    const clickTargets = uniqueElements([
      startElement,
      targetInfo.element,
      targetInfo.parent,
      ...usefulClickAncestors(startElement),
      ...usefulClickAncestors(targetInfo.parent)
    ]);
    console.info('[Italy MIR Helper] XML click target:', {
      type: targetInfo.type,
      xmlName: targetInfo.xmlName,
      text: String(targetInfo.text || '').slice(0, 120),
      point,
      startTag: startElement?.tagName,
      startText: String(getElementText(startElement) || '').slice(0, 120),
      targetCount: clickTargets.length
    });
    targetInfo.parent?.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' });
    await sleep(250);
    const refreshedElement = document.elementFromPoint(point.x, point.y) || startElement;
    const finalTargets = uniqueElements([refreshedElement, ...clickTargets]);
    for (const el of finalTargets) {
      try { el.focus?.(); } catch (_) {}
      dispatchPointerSequence(el, point, 1);
      dispatchMouseSequence(el, point, 1);
      await sleep(120);
      dispatchPointerSequence(el, point, 2);
      dispatchMouseSequence(el, point, 2);
      el.dispatchEvent(new MouseEvent('dblclick', eventOptions(point, 2)));
      await sleep(120);
    }
    const clickable = finalTargets.find((el) => el.matches?.('a, button, [role="button"], [onclick], [ondblclick]'));
    if (clickable && typeof clickable.click === 'function') {
      clickable.click();
    }
  }
  async function startMirFlow() {
    const targetInfo = findXmlAttachmentTarget();
    if (!targetInfo) {
      setStatus('Could not find the XML attachment. Refresh the page and try again.', true);
      return;
    }
    const eventInfo = getEventInfoFromSubject();
    console.info('[Italy MIR Helper] GCH event info before XML click:', eventInfo);
    const startButton = document.getElementById('mir-helper-start');
    if (startButton) startButton.disabled = true;
    setStatus('Double-clicking the XML filename...');
    const downloadStartedAt = Date.now();
    await clickXmlAttachment(targetInfo);
    setStatus(eventInfo.eventNumber ? `Looking up RB Acknowledgement # for event ${eventInfo.eventNumber}-${eventInfo.pliNumber}...` : 'Opening SISN MIR portal...');
    chrome.runtime.sendMessage({
      type: 'MIR_HELPER_OPEN_SISN',
      xmlName: targetInfo.xmlName || '',
      eventInfo,
      downloadStartedAt
    }, (response) => {
      if (chrome.runtime.lastError) {
        setStatus(`Could not open SISN portal: ${chrome.runtime.lastError.message}`, true);
        if (startButton) startButton.disabled = false;
        return;
      }
      if (!response?.ok) {
        setStatus(`Could not open SISN portal: ${response?.error || 'unknown error'}`, true);
        if (startButton) startButton.disabled = false;
        return;
      }
      setStatus(
        'SISN portal opened. The helper will select the XML file on the upload step.',
        false,
        5000
      );
    });
  }
  function showPopup() {
    if (userDismissed || document.getElementById(POPUP_ID)) return;
    const popup = document.createElement('div');
    popup.id = POPUP_ID;
    popup.innerHTML = `
      <div class="mir-helper-title">Italy MIR XML detected</div>
      <button id="mir-helper-start" class="mir-helper-primary" type="button">
        Download XML & Open MIR Portal
      </button>
      <button id="mir-helper-close" class="mir-helper-secondary" type="button">
        Dismiss
      </button>
      <div id="mir-helper-status" class="mir-helper-status"></div>
    `;
    document.documentElement.appendChild(popup);
    document.getElementById('mir-helper-start')?.addEventListener('click', startMirFlow);
    document.getElementById('mir-helper-close')?.addEventListener('click', () => {
      userDismissed = true;
      removePopup();
    });
  }
  function checkConditions() {
    const bcc = hasRequiredBcc();
    let xmlTarget = null;
    if (bcc) {
      xmlTarget = findXmlAttachmentTarget();
    }
    const xml = Boolean(xmlTarget);
    const conditionMet = bcc && xml;
    if (conditionMet !== lastConditionState) {
      lastConditionState = conditionMet;
      if (!conditionMet) userDismissed = false;
      console.info('[Italy MIR Helper] GCH condition check:', {
        bcc,
        xml,
        conditionMet,
        xmlName: xmlTarget?.xmlName,
        xmlTargetType: xmlTarget?.type,
        url: location.href
      });
    }
    if (conditionMet) {
      showPopup();
    } else {
      removePopup();
    }
  }
  function boot() {
    checkConditions();
    let checkScheduled = false;
    function scheduleCheck() {
      if (checkScheduled) return;
      checkScheduled = true;
      const run = () => {
        checkScheduled = false;
        checkConditions();
      };
      if ('requestIdleCallback' in window) {
        requestIdleCallback(run, { timeout: 1500 });
      } else {
        window.setTimeout(run, 500);
      }
    }
    const observer = new MutationObserver(scheduleCheck);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    window.setInterval(scheduleCheck, 5000);
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'MIR_HELPER_CRM_SET_USER_LOCK') {
      setCrmUserLock(Boolean(message.locked), message.message);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type !== 'MIR_HELPER_CRM_FIND_CUS') return false;
    const input = findQuickSearchInput();
    if (!input || !isVisibleElement(input)) return false;
    (async () => {
      const eventInfo = message.eventInfo || {};
      console.info('[Italy MIR Helper] CUS lookup accepted by quick-search frame:', {
        eventNumber: eventInfo.eventNumber,
        pliNumber: eventInfo.pliNumber,
        frame: window.top === window ? 'top' : 'iframe',
        url: location.href
      });
      return findCusForEvent(eventInfo);
    })()
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message || String(error)
      }));
    return true;
  });
  function bootWhenReady() {
    if (!document.documentElement) {
      window.setTimeout(bootWhenReady, 25);
      return;
    }
    boot();
  }
  bootWhenReady();
})();