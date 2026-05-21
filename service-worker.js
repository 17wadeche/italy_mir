'use strict';
const SISN_URL = 'https://sisn.salute.gov.it/app/dmirfe/#/';
const PENDING_KEY = 'mirHelperPendingSisnStart';
const MAX_DOWNLOAD_WAIT_MS = 30000;
const DOWNLOAD_POLL_MS = 1000;
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
  const startedAfter = new Date(Math.max(0, Number(sinceMs || 0) - 15000)).toISOString();
  const endTime = Date.now() + MAX_DOWNLOAD_WAIT_MS;
  while (Date.now() < endTime) {
    const items = await downloadsSearch({
      startedAfter,
      orderBy: ['-startTime'],
      limit: 100
    });
    const candidates = items
      .filter((item) => /\.xml$/i.test(basename(item.filename || '')))
      .filter((item) => item.state === 'complete')
      .filter((item) => item.exists !== false)
      .sort((a, b) => scoreDownload(a, expectedXmlName) - scoreDownload(b, expectedXmlName));
    if (candidates[0]) {
      console.info('[Italy MIR Helper] Found XML download:', {
        filename: candidates[0].filename,
        url: candidates[0].url,
        startTime: candidates[0].startTime,
        expectedXmlName
      });
      return candidates[0];
    }
    await sleep(DOWNLOAD_POLL_MS);
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
  await debuggerSendCommand(target, 'DOM.enable');
  await debuggerSendCommand(target, 'Runtime.enable');
  try {
    const { root } = await debuggerSendCommand(target, 'DOM.getDocument', {
      depth: -1,
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
  const evalResult = await debuggerSendCommand(target, 'Runtime.evaluate', {
    expression,
    objectGroup: 'mir-helper',
    includeCommandLineAPI: false
  });
  const objectId = evalResult?.result?.objectId;
  if (objectId) {
    const requestNode = await debuggerSendCommand(target, 'DOM.requestNode', { objectId });
    if (requestNode?.nodeId) {
      return { nodeId: requestNode.nodeId, selector: 'runtime deep input[type=file]', method: 'Runtime.evaluate deep traversal' };
    }
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
async function dispatchFileEventsInPage(target) {
  return await debuggerSendCommand(target, 'Runtime.evaluate', {
    expression: `(() => {
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
          return value;
        };
        return score(a) - score(b);
      });
      const input = inputs[0] || null;
      if (!input) return { ok: false, reason: 'no input', inputCount: inputs.length };
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
      const composedTarget = input.closest && input.closest('form, ds-input-upload, ds-input-upload-core, .form-field');
      if (composedTarget) {
        for (const eventName of ['input', 'change']) {
          composedTarget.dispatchEvent(new Event(eventName, eventInit));
        }
      }
      return {
        ok: true,
        inputCount: inputs.length,
        files: Array.from(input.files || []).map(f => f.name),
        accept: input.accept || '',
        name: input.name || '',
        id: input.id || '',
        hosts
      };
    })()`,
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
    const dispatchResult = await dispatchFileEventsInPage(target);
    console.info('[Italy MIR Helper] SISN file input event dispatch result:', dispatchResult?.result?.value || dispatchResult);
    return { ok: true, inputInfo, dispatchResult: dispatchResult?.result?.value || null };
  } finally {
    if (attached) await debuggerDetach(target);
  }
}
async function handleOpenSisn(message, sender) {
  const now = Date.now();
  const payload = {
    value: true,
    createdAt: now,
    sourceUrl: sender?.url || sender?.tab?.url || '',
    expectedXmlName: message?.xmlName || '',
    crmTabId: sender?.tab?.id || null
  };
  await storageSet({ [PENDING_KEY]: payload });
  const tab = await tabsCreate({ url: SISN_URL, active: true });
  return { ok: true, tabId: tab?.id || null };
}
async function handleUploadLatestXml(sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) throw new Error('Could not identify the SISN browser tab.');
  const result = await storageGet(PENDING_KEY);
  const pending = result?.[PENDING_KEY] || {};
  const sinceMs = Number(pending.createdAt || Date.now() - 60000);
  const expectedXmlName = pending.expectedXmlName || '';
  const download = await findLatestCompletedXmlDownload({ sinceMs, expectedXmlName });
  if (!download?.filename) {
    throw new Error('Could not find a completed XML download from this workflow. Make sure the SAP XML download finished, then try again.');
  }
  const setResult = await setDownloadedFileOnSisnTab(tabId, download.filename);
  return {
    ok: true,
    filename: basename(download.filename),
    fullPath: download.filename,
    downloadId: download.id,
    setResult
  };
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
