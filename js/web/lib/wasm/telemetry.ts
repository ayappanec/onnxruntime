// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { env } from 'onnxruntime-common';

import type { OrtWasmModule } from './wasm-types';

const COLLECTOR_URL = 'https://mobile.events.data.microsoft.com/OneCollector/1.0?cors=true&content-type=application/x-json-stream';
const IKEY = atob('NWFkOTYzYmQ0YjNhNDExOGE0ODE0MDFjYzAyMTE4NzUtMGNiNDUxNTktNDZmNS00NDk1LWI0ZTUtZDA4OTAzNTVlOTY0LTY3OTc=');
const IKEY_PREFIX = `o:${IKEY.split('-')[0]}`;
const FLUSH_INTERVAL_MS = 30_000;
const MAX_QUEUE_SIZE = 500;
const MAX_RETRIES = 6;
const DEVICE_ID_KEY = 'ort_device_id';

let queue: string[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let deviceId: string | null = null;

const getDeviceId = (): string => {
  if (deviceId) return deviceId;
  try {
    deviceId = localStorage.getItem(DEVICE_ID_KEY);
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem(DEVICE_ID_KEY, deviceId);
    }
  } catch {
    deviceId = crypto.randomUUID();
  }
  return deviceId;
};

const getBrowserMetadata = (): Record<string, unknown> => {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const metadata: Record<string, unknown> = {};
  if (nav) {
    if (nav.hardwareConcurrency) metadata.cpuCount = nav.hardwareConcurrency;
    if ((nav as unknown as Record<string, unknown>).deviceMemory) {
      metadata.deviceMemoryGB = (nav as unknown as Record<string, unknown>).deviceMemory;
    }
    if (nav.language) metadata.locale = nav.language;
    if (nav.userAgent) metadata.userAgent = nav.userAgent;
    const uaData = (nav as unknown as Record<string, unknown>).userAgentData as
      | { platform?: string; architecture?: string; mobile?: boolean }
      | undefined;
    if (uaData) {
      if (uaData.platform) metadata.osPlatform = uaData.platform;
      if (uaData.architecture) metadata.architecture = uaData.architecture;
      if (uaData.mobile !== undefined) metadata.isMobile = uaData.mobile;
    }
  }
  return metadata;
};

const enqueue = (eventName: string, eventData: Record<string, unknown>): void => {
  if (queue.length >= MAX_QUEUE_SIZE) return;
  queue.push(
    JSON.stringify({
      name: eventName.toLowerCase(),
      time: new Date().toISOString(),
      ver: '4.0',
      iKey: IKEY_PREFIX,
      ext: {
        sdk: { ver: 'ORT-Web/1.0' },
        device: { localId: getDeviceId() },
      },
      data: eventData,
    }),
  );
};

const flush = (useBeacon = false): void => {
  if (queue.length === 0) return;
  const batch = queue.splice(0);
  const payload = batch.join('\n');
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-json-stream',
    'apikey': IKEY,
    'Client-Id': 'NO_AUTH',
    'upload-time': Date.now().toString(),
    'cache-control': 'no-cache, no-store',
  };

  if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    const blob = new Blob([payload], { type: 'application/x-json-stream' });
    if (navigator.sendBeacon(COLLECTOR_URL, blob)) return;
  }

  sendWithRetry(payload, headers);
};

const sendWithRetry = (payload: string, headers: Record<string, string>, attempt = 0): void => {
  fetch(COLLECTOR_URL, {
    method: 'POST',
    headers,
    body: payload,
    keepalive: true,
  }).then(
    (res) => {
      if (!res.ok && attempt < MAX_RETRIES && (res.status === 429 || res.status >= 500)) {
        const delay = 3000 * Math.pow(2, attempt) + Math.random() * 1000;
        setTimeout(() => sendWithRetry(payload, headers, attempt + 1), delay);
      }
    },
    () => {
      if (attempt < MAX_RETRIES) {
        const delay = 3000 * Math.pow(2, attempt) + Math.random() * 1000;
        setTimeout(() => sendWithRetry(payload, headers, attempt + 1), delay);
      }
    },
  );
};

const startFlushTimer = (): void => {
  if (flushTimer) return;
  flushTimer = setInterval(() => flush(), FLUSH_INTERVAL_MS);

  if (typeof globalThis !== 'undefined' && typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('beforeunload', () => flush(true));
    globalThis.addEventListener('pagehide', () => flush(true));
    globalThis.addEventListener('visibilitychange', () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        flush(true);
      }
    });
  }
};

export const initTelemetry = (module: OrtWasmModule): void => {
  if (BUILD_DEFS.DISABLE_TELEMETRY) {
    return;
  }

  startFlushTimer();
  const browserMetadata = getBrowserMetadata();

  (module as unknown as Record<string, unknown>)['__ortTelemetryCallback'] = (
    eventName: string,
    eventData: Record<string, unknown>,
  ) => {
    if (env.telemetry?.enabled === false) {
      return;
    }

    const enrichedData = eventName === 'ProcessInfo' ? { ...eventData, ...browserMetadata } : eventData;

    try {
      env.telemetry?.onEvent?.(eventName, enrichedData);
    } catch {
      // Observer errors must not disrupt the application.
    }

    try {
      enqueue(eventName, enrichedData);
    } catch {
      // Telemetry must not disrupt the application.
    }
  };
};
