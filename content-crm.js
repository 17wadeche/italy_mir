'use strict';
(() => {
  const REQUIRED_BCC = 'RS.ITALYMIRREPORTS@MEDTRONIC.COM';
  const POPUP_ID = 'mir-helper-popup';
  const CHECK_INTERVAL_MS = 1200;
  const XML_TEXT_RE = /\.xml\b/i;
  let userDismissed = false;
  let lastConditionState = false;
  let popupHideTimer = null;
  let cusLookupState = { key: '', promise: null, searchedEventNumber: '' };
  console.info('[Italy MIR Helper] CRM content script loaded:', {
    url: location.href,
    frame: window.top === window ? 'top' : 'iframe'
  });
  function crmLookupLog(message, details = {}) {
    try {
      chrome.runtime.sendMessage({
        type: 'MIR_HELPER_CRM_LOOKUP_LOG',
        message,
        details: {
          ...details,
          frame: window.top === window ? 'top' : 'iframe',
          url: location.href
        }
      });
    } catch (_) {}
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
    return document.getElementById('C17_W52_V53_QUICKSEARCH') ||
      Array.from(document.querySelectorAll('a, button, [role="button"], input[type="button"], input[type="submit"]'))
        .find((el) => isVisibleElement(el) && /^go$/i.test(normalize(getElementText(el))));
  }
  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function performQuickSearch(eventNumber) {
    const input = await waitFor(findQuickSearchInput, 30000, 500);
    if (!input) throw new Error('Could not find the CRM quick-search input.');
    input.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' });
    input.focus?.();
    setInputValue(input, eventNumber);
    await sleep(300);
    const go = findQuickSearchGo();
    if (go) {
      const point = centerOfElement(go);
      activateElement(go, point);
    } else {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }
  function centerOfElement(el) {
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
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
  function getRegulatoryReportsContainer() {
    return document.querySelector('.RegulatoryReports') ||
      Array.from(document.querySelectorAll('div')).find((el) => isVisibleElement(el) && /regulatory report/i.test(getElementText(el)));
  }
  async function expandRegulatoryReports() {
    const container = await waitFor(getRegulatoryReportsContainer, 45000, 500);
    if (!container) throw new Error('Could not find the CRM Regulatory Report section.');
    const wrapper = container.querySelector('.data-wrapper');
    if (wrapper && getComputedStyle(wrapper).display !== 'none') return container;
    const clicker = container.querySelector('.clicker') || container;
    clicker.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' });
    activateElement(clicker, centerOfElement(clicker));
    await sleep(1500);
    return container;
  }
  function escapeCssValue(value) {
    if (window.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
  function getRegulatoryReportRowsByItemNumber(itemNumber) {
    const item = String(itemNumber || '').trim();
    const container = getRegulatoryReportsContainer();
    if (!container || !item) return [];
    const escapedItem = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const itemNumberPattern = new RegExp(`\\(${escapedItem}\\)\\s*:`, 'i');
    const candidates = container.querySelectorAll('.data').length
      ? container.querySelectorAll('.data')
      : container.querySelectorAll('a.GUIDE-sideNav');
    return Array.from(candidates)
      .map((el, index) => {
        const row = el.matches?.('.data') ? el : el.closest?.('.data');
        const link = el.matches?.('a') ? el : row?.querySelector?.('a.GUIDE-sideNav, a');
        const itemNumberEl = row?.querySelector?.('.item-number');
        const itemText = getElementText(itemNumberEl) || getElementText(row || el);
        const transId = link?.getAttribute?.('data-trans-id') || '';
        return { row, link, itemText, transId, index };
      })
      .filter(({ link, itemText }) => link && itemNumberPattern.test(itemText));
  }
  function summarizeRegulatoryReport(report, index) {
    return {
      index,
      matchIndex: report?.matchIndex,
      rowIndex: report?.index,
      itemNumber: report?.itemNumber,
      itemText: report?.itemText,
      transId: report?.transId,
      title: report?.title
    };
  }
  function getRegulatoryReportLink(report) {
    const container = getRegulatoryReportsContainer();
    if (!container || !report) {
      crmLookupLog('Regulatory Report link lookup skipped', {
        hasContainer: Boolean(container),
        hasReport: Boolean(report),
        report: summarizeRegulatoryReport(report)
      });
      return null;
    }
    if (report.transId) {
      const link = container.querySelector(`a.GUIDE-sideNav[data-trans-id="${escapeCssValue(report.transId)}"]`);
      crmLookupLog('Regulatory Report link lookup by trans id', {
        report: summarizeRegulatoryReport(report),
        found: Boolean(link)
      });
      return link;
    }
    const link = getRegulatoryReportRowsByItemNumber(report.itemNumber)[report.matchIndex]?.link || null;
    crmLookupLog('Regulatory Report link lookup by duplicate index', {
      report: summarizeRegulatoryReport(report),
      found: Boolean(link)
    });
    return link;
  }
  function readRbAcknowledgement() {
    const cell = document.getElementById('GUIDE-RegReportDetails-RegulatoryBodyInfo-RBAcknowledgement');
    const text = (cell ? getElementText(cell) : '') ||
      getElementText(document.querySelector('[id*="RBAcknowledgement"]'));
    const cleaned = String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const match = cleaned.match(/\bCUS-\d{2,4}-\d+\b/i);
    return match ? match[0].toUpperCase() : '';
  }
  async function readCusAfterTransIdSearch(report, index, total) {
    if (!report?.transId) return '';
    crmLookupLog('Searching Regulatory Report by transaction id', {
      attempt: index + 1,
      total,
      report: summarizeRegulatoryReport(report, index)
    });
    await performQuickSearch(report.transId);
    await sleep(4000);
    const cusCode = await waitFor(readRbAcknowledgement, 12000, 500);
    crmLookupLog('RB Acknowledgement result after transaction id search', {
      attempt: index + 1,
      total,
      transId: report.transId,
      title: report.title,
      cusCode: cusCode || ''
    });
    return cusCode || '';
  }
  async function runCusLookup({ eventNumber, pliNumber }) {
    if (cusLookupState.searchedEventNumber !== eventNumber) {
      await performQuickSearch(eventNumber);
      cusLookupState.searchedEventNumber = eventNumber;
      await sleep(4000);
    }
    await expandRegulatoryReports();
    crmLookupLog('Starting Regulatory Report CUS lookup', { eventNumber, pliNumber });
    const reports = await waitFor(() => {
      const found = getRegulatoryReportRowsByItemNumber(pliNumber);
      if (!found.length) return null;
      crmLookupLog('Regulatory Report rows matching item number', {
        pliNumber,
        count: found.length,
        reports: found.map((report, matchIndex) => summarizeRegulatoryReport({
          itemNumber: pliNumber,
          matchIndex,
          index: report.index,
          itemText: report.itemText,
          transId: report.transId,
          title: report.link?.getAttribute?.('title') || getElementText(report.link)
        }, matchIndex))
      });
      return found.map((report, matchIndex) => ({
        itemNumber: pliNumber,
        matchIndex,
        index: report.index,
        itemText: report.itemText,
        transId: report.transId,
        title: report.link?.getAttribute?.('title') || getElementText(report.link)
      }));
    }, 30000, 500);
    if (!reports?.length) {
      crmLookupLog('No Regulatory Report links found for item number', { pliNumber });
      return { ok: true, cusCode: '', reason: `No Regulatory Report links found for item number ${pliNumber}.` };
    }
    crmLookupLog('Regulatory Report lookup snapshot', {
      pliNumber,
      count: reports.length,
      reports: reports.map(summarizeRegulatoryReport)
    });
    for (const [index, report] of reports.entries()) {
      crmLookupLog('Attempting Regulatory Report', {
        attempt: index + 1,
        total: reports.length,
        report: summarizeRegulatoryReport(report, index)
      });
      await expandRegulatoryReports();
      const link = getRegulatoryReportLink(report);
      if (!link) {
        crmLookupLog('Regulatory Report link was not found; falling back to transaction id search', {
          attempt: index + 1,
          total: reports.length,
          report: summarizeRegulatoryReport(report, index)
        });
        const cusCode = await readCusAfterTransIdSearch(report, index, reports.length);
        if (cusCode) return { ok: true, cusCode };
        continue;
      }
      crmLookupLog('Clicking Regulatory Report', {
        attempt: index + 1,
        total: reports.length,
        transId: report.transId,
        title: report.title,
        linkText: getElementText(link)
      });
      link.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' });
      activateElement(link, centerOfElement(link));
      await sleep(2500);
      let cusCode = await waitFor(readRbAcknowledgement, 12000, 500);
      crmLookupLog('RB Acknowledgement result after Regulatory Report click', {
        attempt: index + 1,
        total: reports.length,
        transId: report.transId,
        title: report.title,
        cusCode: cusCode || ''
      });
      if (cusCode) return { ok: true, cusCode };
      cusCode = await readCusAfterTransIdSearch(report, index, reports.length);
      if (cusCode) return { ok: true, cusCode };
    }
    return { ok: true, cusCode: '', reason: `Regulatory Reports for item number ${pliNumber} did not have an RB Acknowledgement #.` };
  }
  async function findCusForEvent({ eventNumber, pliNumber }) {
    const key = `${eventNumber || ''}-${pliNumber || ''}`;
    if (cusLookupState.promise && cusLookupState.key === key) {
      console.info('[Italy MIR Helper] Reusing in-flight CRM CUS lookup:', key);
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
    console.info('[Italy MIR Helper] CRM event info before XML click:', eventInfo);
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
      console.info('[Italy MIR Helper] CRM condition check:', {
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
    if (message?.type !== 'MIR_HELPER_CRM_FIND_CUS') return false;
    (async () => findCusForEvent(message.eventInfo || {}))()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });
  boot();
})();