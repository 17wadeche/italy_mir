'use strict';
const SISN_URL = 'https://sisn.salute.gov.it/app/dmirfe/#/';
const PENDING_KEY = 'mirHelperPendingSisnStart';
const MAX_DOWNLOAD_WAIT_MS = 30000;
const DOWNLOAD_POLL_MS = 150;
chrome.runtime.onInstalled.addListener(() => {
  console.info('[Italy MIR Helper] Installed/updated.');
});
function chromeLastErrorMessage() {
  return chrome.runtime.lastError?.message || null;
}
function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const err = chromeLastErrorMessage();
      if (err) reject(new Error(err));
      else resolve(result || {});
    });
  });
}
function storageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const err = chromeLastErrorMessage();
      if (err) reject(new Error(err));
      else resolve();
    });
  });
}
function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const err = chromeLastErrorMessage();
      if (err) reject(new Error(err));
      else resolve();
    });
  });
}
function tabsCreate(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      const err = chromeLastErrorMessage();
      if (err) reject(new Error(err));
      else resolve(tab);
    });
  });
}
function tabsDuplicate(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.duplicate(tabId, (tab) => {
      const err = chromeLastErrorMessage();
      if (err) reject(new Error(err));
      else resolve(tab);
    });
  });
}
function tabsRemove(tabId) {
  return new Promise((resolve) => {
    if (!tabId) {
      resolve();
      return;
    }
    chrome.tabs.remove(tabId, () => resolve());
  });
}
function tabsSendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chromeLastErrorMessage();
      if (err) reject(new Error(err));
      else resolve(response);
    });
  });
}
function tabsUpdate(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, updateProperties, (tab) => {
      const err = chromeLastErrorMessage();
      if (err) reject(new Error(err));
      else resolve(tab);
    });
  });
}
function windowsUpdate(windowId, updateInfo) {
  return new Promise((resolve) => {
    if (!windowId) {
      resolve();
      return;
    }
    chrome.windows.update(windowId, updateInfo, () => resolve());
  });
}
function tabsGet(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const err = chromeLastErrorMessage();
      if (err) reject(new Error(err));
      else resolve(tab);
    });
  });
}
async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const endTime = Date.now() + timeoutMs;
  while (Date.now() < endTime) {
    const tab = await tabsGet(tabId);
    if (tab?.status === 'complete') return tab;
    await sleep(150);
  }
  return await tabsGet(tabId);
}
function downloadsSearch(query) {
  return new Promise((resolve, reject) => {
    chrome.downloads.search(query, (items) => {
      const err = chromeLastErrorMessage();
      if (err) reject(new Error(err));
      else resolve(items || []);
    });
  });
}
function debuggerAttach(target, version = '1.3') {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, version, () => {
      const err = chromeLastErrorMessage();
      if (err) reject(new Error(err));
      else resolve();
    });
  });
}
function debuggerDetach(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => resolve());
  });
}
function debuggerSendCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const err = chromeLastErrorMessage();
      if (err) reject(new Error(`${method}: ${err}`));
      else resolve(result || {});
    });
  });
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function basename(path) {
  return String(path || '').split(/[\\/]/).pop() || '';
}
function normalizeFileName(name) {
  return basename(name)
    .toLowerCase()
    .replace(/\s*\(\d+\)(?=\.xml$)/i, '')
    .trim();
}
function scoreDownload(item, expectedXmlName) {
  const base = basename(item.filename || '');
  let score = 0;
  if (!/\.xml$/i.test(base)) return Number.POSITIVE_INFINITY;
  if (item.state !== 'complete') score += 100000;
  if (item.exists === false) score += 50000;
  if (expectedXmlName) {
    const expected = normalizeFileName(expectedXmlName);
    const actual = normalizeFileName(base);
    if (actual === expected) score -= 1000;
    else if (actual.includes(expected) || expected.includes(actual)) score -= 500;
    else score += 5000;
  }
  const startMs = Date.parse(item.startTime || '') || 0;
  score -= Math.min(1000, Math.floor(startMs / 100000000));
  return score;
}
async function findLatestCompletedXmlDownload({ sinceMs, expectedXmlName }) {
  const workflowStartMs = Number(sinceMs || 0);
  const startedAfter = new Date(Math.max(0, workflowStartMs - 2 * 60 * 1000)).toISOString();
  const endTime = Date.now() + MAX_DOWNLOAD_WAIT_MS;
  function isXmlDownload(item) {
    return /\.xml$/i.test(basename(item.filename || ''));
  }
  function isUsableDownload(item) {
    return (
      isXmlDownload(item) &&
      item.state === 'complete' &&
      item.filename &&
      item.exists !== false
    );
  }
  function describe(item) {
    return {
      id: item.id,
      filename: item.filename,
      basename: basename(item.filename || ''),
      state: item.state,
      exists: item.exists,
      startTime: item.startTime,
      url: item.url
    };
  }
  async function searchCandidates(query, label) {
    const items = await downloadsSearch(query);
    const xmlItems = items
      .filter(isXmlDownload)
      .map(describe);
    console.info(`[Italy MIR Helper] XML download search: ${label}`, {
      query,
      totalItems: items.length,
      xmlItems
    });
    return items
      .filter(isUsableDownload)
      .sort((a, b) => scoreDownload(a, expectedXmlName) - scoreDownload(b, expectedXmlName));
  }
  while (Date.now() < endTime) {
    const candidates = await searchCandidates({
      startedAfter,
      orderBy: ['-startTime'],
      limit: 1000
    }, 'workflow window');
    if (candidates[0]) {
      console.info('[Italy MIR Helper] Found XML download in workflow window:', describe(candidates[0]));
      return candidates[0];
    }
    await sleep(DOWNLOAD_POLL_MS);
  }
  const fallbackStartedAfter = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const fallbackCandidates = await searchCandidates({
    startedAfter: fallbackStartedAfter,
    orderBy: ['-startTime'],
    limit: 1000
  }, 'last 60 minutes fallback');
  if (fallbackCandidates[0]) {
    console.warn('[Italy MIR Helper] Using fallback XML download:', describe(fallbackCandidates[0]));
    return fallbackCandidates[0];
  }
  return null;
}
function attrsToMap(attributes) {
  const map = {};
  const list = Array.isArray(attributes) ? attributes : [];
  for (let i = 0; i < list.length; i += 2) {
    map[String(list[i] || '').toLowerCase()] = String(list[i + 1] || '');
  }
  return map;
}
function scoreFileInputAttributes(attrs) {
  let score = 0;
  const joined = [attrs.accept, attrs.name, attrs.id, attrs.class, attrs['aria-label'], attrs.label].join(' ').toLowerCase();
  if (/xml/.test(attrs.accept || '')) score -= 100;
  if (/xml/.test(joined)) score -= 50;
  if (/upload/.test(joined)) score -= 25;
  if (attrs.disabled !== undefined) score += 1000;
  return score;
}
async function findFileInputNodeInfo(target) {
  await debuggerSendCommand(target, 'Runtime.enable');
  const expression = `(() => {
    const seen = new Set();
    const inputs = [];
    function visit(node) {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.matches && node.matches('input[type="file"]')) inputs.push(node);
        if (node.shadowRoot) visit(node.shadowRoot);
      }
      const children = node.children || node.childNodes || [];
      for (const child of Array.from(children)) visit(child);
    }
    visit(document);
    inputs.sort((a, b) => {
      const score = (input) => {
        const joined = [input.accept, input.name, input.id, input.className, input.getAttribute('aria-label'), input.getAttribute('label')].join(' ').toLowerCase();
        let value = 0;
        if (/xml/.test(input.accept || '')) value -= 100;
        if (/xml/.test(joined)) value -= 50;
        if (/upload/.test(joined)) value -= 25;
        if (input.disabled) value += 1000;
        return value;
      };
      return score(a) - score(b);
    });
    return inputs[0] || null;
  })()`;
  try {
    const evalResult = await debuggerSendCommand(target, 'Runtime.evaluate', {
      expression,
      objectGroup: 'mir-helper',
      includeCommandLineAPI: false
    });
    const objectId = evalResult?.result?.objectId;
    if (objectId) {
      return { objectId, selector: 'runtime deep input[type=file]', method: 'Runtime.evaluate deep traversal' };
    }
  } catch (error) {
    console.warn('[Italy MIR Helper] Runtime file input search failed:', error?.message || String(error));
  }
  await debuggerSendCommand(target, 'DOM.enable');
  try {
    const { root } = await debuggerSendCommand(target, 'DOM.getDocument', {
      depth: 2,
      pierce: true
    });
    for (const selector of ['input[type="file"][accept*="xml" i]', 'input[type="file"]']) {
      const result = await debuggerSendCommand(target, 'DOM.querySelector', {
        nodeId: root.nodeId,
        selector
      });

      if (result?.nodeId) {
        return { nodeId: result.nodeId, selector, method: 'DOM.querySelector' };
      }
    }
  } catch (error) {
    console.warn('[Italy MIR Helper] Light-DOM file input search failed:', error?.message || String(error));
  }
  try {
    const flattened = await debuggerSendCommand(target, 'DOM.getFlattenedDocument', {
      depth: -1,
      pierce: true
    });
    const candidates = (flattened.nodes || [])
      .filter((node) => String(node.nodeName || '').toUpperCase() === 'INPUT')
      .map((node) => ({ node, attrs: attrsToMap(node.attributes) }))
      .filter(({ attrs }) => String(attrs.type || '').toLowerCase() === 'file')
      .map(({ node, attrs }) => ({
        node,
        attrs,
        score: scoreFileInputAttributes(attrs)
      }))
      .sort((a, b) => a.score - b.score);
    if (candidates[0]) {
      return {
        nodeId: candidates[0].node.nodeId,
        backendNodeId: candidates[0].node.backendNodeId,
        selector: 'deep input[type=file]',
        method: 'DOM.getFlattenedDocument(pierce)',
        attrs: candidates[0].attrs
      };
    }
  } catch (error) {
    console.warn('[Italy MIR Helper] Flattened shadow-DOM file input search failed:', error?.message || String(error));
  }
  return null;
}
function fileInputSetParams(inputInfo, filePath) {
  const params = { files: [filePath] };
  if (inputInfo?.nodeId) params.nodeId = inputInfo.nodeId;
  else if (inputInfo?.backendNodeId) params.backendNodeId = inputInfo.backendNodeId;
  else if (inputInfo?.objectId) params.objectId = inputInfo.objectId;
  return params;
}
async function resolveInputObjectId(target, inputInfo) {
  if (inputInfo?.objectId) return inputInfo.objectId;
  if (inputInfo?.nodeId || inputInfo?.backendNodeId) {
    const params = { objectGroup: 'mir-helper' };
    if (inputInfo.nodeId) params.nodeId = inputInfo.nodeId;
    if (inputInfo.backendNodeId) params.backendNodeId = inputInfo.backendNodeId;
    const resolved = await debuggerSendCommand(target, 'DOM.resolveNode', params);
    return resolved?.object?.objectId || '';
  }
  return '';
}
async function dispatchFileEventsInPage(target, inputInfo) {
  const objectId = await resolveInputObjectId(target, inputInfo);
  if (!objectId) {
    throw new Error('Could not resolve SISN file input after setting XML file.');
  }
  return await debuggerSendCommand(target, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function () {
      const input = this;
      const eventInit = { bubbles: true, composed: true };
      for (const eventName of ['input', 'change']) {
        input.dispatchEvent(new Event(eventName, eventInit));
      }
      const hosts = [];
      let root = input.getRootNode && input.getRootNode();
      while (root && root.host) {
        hosts.push(root.host.tagName || root.host.localName || 'host');
        for (const eventName of ['input', 'change']) {
          root.host.dispatchEvent(new Event(eventName, eventInit));
        }
        root = root.host.getRootNode && root.host.getRootNode();
      }
      const composedTarget =
        input.closest &&
        input.closest('form, ds-input-upload, ds-input-upload-core, .form-field');
      if (composedTarget) {
        for (const eventName of ['input', 'change']) {
          composedTarget.dispatchEvent(new Event(eventName, eventInit));
        }
      }
      return {
        ok: true,
        files: Array.from(input.files || []).map((file) => file.name),
        accept: input.accept || '',
        name: input.name || '',
        id: input.id || '',
        hosts
      };
    }`,
    awaitPromise: true,
    returnByValue: true
  });
}
async function setDownloadedFileOnSisnTab(tabId, filePath) {
  const target = { tabId };
  let attached = false;
  try {
    await debuggerAttach(target);
    attached = true;
    const inputInfo = await findFileInputNodeInfo(target);
    if (!inputInfo?.nodeId && !inputInfo?.backendNodeId && !inputInfo?.objectId) {
      throw new Error('Could not find the SISN XML file input, including inside shadow DOM.');
    }
    console.info('[Italy MIR Helper] Setting SISN file input:', {
      filePath,
      inputInfo
    });
    await debuggerSendCommand(target, 'DOM.setFileInputFiles', fileInputSetParams(inputInfo, filePath));
    const dispatchResult = await dispatchFileEventsInPage(target, inputInfo);
    console.info('[Italy MIR Helper] SISN file input event dispatch result:', dispatchResult?.result?.value || dispatchResult);
    return { ok: true, inputInfo, dispatchResult: dispatchResult?.result?.value || null };
  } finally {
    if (attached) await debuggerDetach(target);
  }
}
async function lookupCusInDuplicateCrmTab({ sourceTabId, eventInfo }) {
  if (!sourceTabId || !eventInfo?.eventNumber || !eventInfo?.pliNumber) {
    console.warn('[Italy MIR Helper] Skipping GCH tab duplicate for CUS lookup because required data is missing:', {
      sourceTabId,
      eventInfo
    });
    return { ok: true, cusCode: '', skipped: true };
  }
  let duplicateTab = null;
  try {
    console.info('[Italy MIR Helper] Duplicating GCH tab for CUS lookup:', {
      sourceTabId,
      eventInfo
    });
    duplicateTab = await tabsDuplicate(sourceTabId);
    console.info('[Italy MIR Helper] GCH duplicate tab created for CUS lookup:', {
      duplicateTabId: duplicateTab?.id,
      duplicateUrl: duplicateTab?.url,
      windowId: duplicateTab?.windowId
    });
    await windowsUpdate(duplicateTab.windowId, { focused: true });
    duplicateTab = await tabsUpdate(duplicateTab.id, { active: true });
    await waitForTabComplete(duplicateTab.id, 30000);
    await sleep(1000);
    try {
      await tabsSendMessage(duplicateTab.id, {
        type: 'MIR_HELPER_CRM_SET_USER_LOCK',
        locked: true,
        message: 'Looking up CUS in GCH. Please wait until the automation closes this tab.'
      });
    } catch (error) {
      console.warn('[Italy MIR Helper] Could not lock GCH duplicate tab during CUS lookup:', error?.message || String(error));
    }
    const endTime = Date.now() + 120000;
    let lastError = '';
    while (Date.now() < endTime) {
      try {
        const response = await tabsSendMessage(duplicateTab.id, {
          type: 'MIR_HELPER_CRM_FIND_CUS',
          eventInfo
        });
        if (response?.ok) return response;
        lastError = response?.error || 'Unknown GCH CUS lookup error.';
      } catch (error) {
        lastError = error?.message || String(error);
      }
      await sleep(125);
    }
    return { ok: false, cusCode: '', error: lastError || 'Timed out waiting for GCH CUS lookup.' };
  } finally {
    if (duplicateTab?.id) {
      try {
        await tabsSendMessage(duplicateTab.id, { type: 'MIR_HELPER_CRM_SET_USER_LOCK', locked: false });
      } catch (_) {}
    }
    await tabsRemove(duplicateTab?.id);
  }
}
async function mergePendingSisnStart(values) {
  const current = await storageGet(PENDING_KEY);
  const pending = current?.[PENDING_KEY] || {};
  if (!pending?.value) return;
  await storageSet({
    [PENDING_KEY]: {
      ...pending,
      ...values
    }
  });
}
async function resolveAndStoreXmlDownload({ sinceMs, expectedXmlName }) {
  try {
    const download = await findLatestCompletedXmlDownload({ sinceMs, expectedXmlName });
    if (!download?.filename) {
      await mergePendingSisnStart({ xmlDownload: { ok: false, pending: false, error: 'No completed XML download found yet.' } });
      return null;
    }
    const xmlDownload = {
      ok: true,
      pending: false,
      id: download.id,
      filename: download.filename,
      basename: basename(download.filename),
      startTime: download.startTime
    };
    await mergePendingSisnStart({ xmlDownload });
    console.info('[Italy MIR Helper] Cached XML download for SISN upload:', xmlDownload);
    return download;
  } catch (error) {
    const message = error?.message || String(error);
    await mergePendingSisnStart({ xmlDownload: { ok: false, pending: false, error: message } });
    console.warn('[Italy MIR Helper] XML download pre-resolution failed:', message);
    return null;
  }
}
async function lookupAndStoreCus({ sourceTabId, eventInfo }) {
  const lookupResult = await lookupCusInDuplicateCrmTab({ sourceTabId, eventInfo });
  if (!lookupResult?.ok) {
    console.warn('[Italy MIR Helper] GCH CUS lookup failed; continuing with no-code flow.', lookupResult);
  }
  await mergePendingSisnStart({
    cusCode: lookupResult?.cusCode || '',
    cusLookup: lookupResult || { ok: false, pending: false, error: 'Unknown GCH CUS lookup error.' }
  });
}
async function handleOpenSisn(message, sender) {
  const now = Date.now();
  const sourceTabId = sender?.tab?.id || null;
  const eventInfo = message?.eventInfo || {};
  const downloadStartedAt = Number(message?.downloadStartedAt || now);
  const expectedXmlName = message?.xmlName || '';
  const basePayload = {
    value: true,
    createdAt: now,
    downloadStartedAt,
    sourceUrl: sender?.url || sender?.tab?.url || '',
    expectedXmlName,
    crmTabId: sourceTabId,
    eventInfo,
    cusCode: '',
    cusLookup: { ok: true, pending: true },
    xmlDownload: { ok: false, pending: true }
  };
  await storageSet({ [PENDING_KEY]: basePayload });
  const tab = await tabsCreate({ url: SISN_URL, active: true });
  lookupAndStoreCus({ sourceTabId, eventInfo }).catch((error) => {
    console.warn('[Italy MIR Helper] Background GCH CUS lookup failed:', error?.message || String(error));
  });
  resolveAndStoreXmlDownload({ sinceMs: downloadStartedAt, expectedXmlName }).catch((error) => {
    console.warn('[Italy MIR Helper] Background XML download resolution failed:', error?.message || String(error));
  });
  return { ok: true, tabId: tab?.id || null };
}
async function handleUploadLatestXml(sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) throw new Error('Could not identify the SISN browser tab.');
  const result = await storageGet(PENDING_KEY);
  const pending = result?.[PENDING_KEY] || {};
  const sinceMs = Number(pending.downloadStartedAt || pending.createdAt || Date.now() - 60000);
  const expectedXmlName = pending.expectedXmlName || '';
  const cachedDownload = pending.xmlDownload?.ok && pending.xmlDownload?.filename
    ? {
      id: pending.xmlDownload.id,
      filename: pending.xmlDownload.filename,
      state: 'complete',
      exists: true,
      startTime: pending.xmlDownload.startTime
    }
    : null;
  const download = cachedDownload || await findLatestCompletedXmlDownload({ sinceMs, expectedXmlName });
  if (cachedDownload) {
    console.info('[Italy MIR Helper] Using cached XML download for SISN upload:', pending.xmlDownload);
  }
  if (!download?.filename) {
    const recent = await downloadsSearch({
      orderBy: ['-startTime'],
      limit: 20
    });
    console.warn('[Italy MIR Helper] Recent Chrome downloads:', recent.map((item) => ({
      id: item.id,
      filename: item.filename,
      basename: basename(item.filename || ''),
      state: item.state,
      exists: item.exists,
      startTime: item.startTime,
      url: item.url
    })));
    throw new Error(
      'Could not find a completed XML download in Chrome download history. Check the service worker console for “Recent Chrome downloads”. The file may have downloaded before the workflow timestamp, been moved, or not been recorded by Chrome.'
    );
  }
  try {
    const setResult = await setDownloadedFileOnSisnTab(tabId, download.filename);
    return {
      ok: true,
      filename: basename(download.filename),
      fullPath: download.filename,
      downloadId: download.id,
      setResult
    };
  } catch (error) {
    const message = error?.message || String(error);
    const isSetFileInputNotAllowed =
      /DOM\.setFileInputFiles/i.test(message) &&
      (
        /not allowed/i.test(message) ||
        /"message"\s*:\s*"Not allowed"/i.test(message) ||
        /"code"\s*:\s*-32000/i.test(message)
      );
    if (isSetFileInputNotAllowed) {
      try {
        chrome.downloads.show(download.id);
      } catch (_) {}
      throw new Error(
        'Chrome blocked automatic XML selection. Open chrome://extensions > Italy Portal Tool > Details, enable “Allow access to file URLs”, reload the extension, then retry. If needed, upload the XML manually from the Downloads folder.'
      );
    }
    throw error;
  }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  (async () => {
    if (message.type === 'MIR_HELPER_OPEN_SISN') {
      return await handleOpenSisn(message, sender);
    }
    if (message.type === 'MIR_HELPER_UPLOAD_LATEST_XML') {
      return await handleUploadLatestXml(sender);
    }
    if (message.type === 'MIR_HELPER_CLEAR_PENDING') {
      await storageRemove(PENDING_KEY);
      return { ok: true };
    }
    return { ok: false, error: `Unknown message type: ${message.type}` };
  })()
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error('[Italy MIR Helper] Service worker error:', error);
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
  return true;
});
