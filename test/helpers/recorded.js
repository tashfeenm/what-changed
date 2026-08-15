/**
 * Install a tiny recorded-response fetch stub for connector tests.
 *
 * Route keys may be an exact URL, an exact `METHOD URL`, or `*` as a
 * fallback. Values can be raw JSON fixtures, a real Response, a descriptor
 * (`{ body, json, status, headers, text }`), or a handler returning any of
 * those.
 */
export function stubFetch(routes) {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    const request = { method, url };
    requests.push(request);

    const route = findRoute(routes, method, url);
    if (route === undefined) {
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }
    const result = typeof route === 'function'
      ? await route({ ...request, input, init, requests })
      : route;
    return asResponse(result);
  };

  let disposed = false;
  return {
    requests,
    dispose() {
      if (disposed) return;
      disposed = true;
      globalThis.fetch = originalFetch;
    },
  };
}

function requestUrl(input) {
  if (input instanceof URL) return input.toString();
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url;
  return String(input);
}

function requestMethod(input, init) {
  return String(init?.method ?? input?.method ?? 'GET').toUpperCase();
}

function findRoute(routes, method, url) {
  const keys = [`${method} ${url}`, url, `${method} *`, '*'];
  if (routes instanceof Map) {
    for (const key of keys) {
      if (routes.has(key)) return routes.get(key);
    }
    return undefined;
  }
  for (const key of keys) {
    if (Object.hasOwn(routes, key)) return routes[key];
  }
  return undefined;
}

function asResponse(result) {
  if (result instanceof Response) return result;

  if (isDescriptor(result)) {
    const headers = new Headers(result.headers);
    const status = result.status ?? 200;
    if (Object.hasOwn(result, 'text')) {
      return new Response(result.text, { status, headers });
    }
    const body = Object.hasOwn(result, 'body') ? result.body : result.json;
    if (body == null || typeof body === 'string' || body instanceof Uint8Array) {
      return new Response(body ?? null, { status, headers });
    }
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(body), { status, headers });
  }

  if (result == null || typeof result === 'string' || result instanceof Uint8Array) {
    return new Response(result ?? null);
  }
  return new Response(JSON.stringify(result), {
    headers: { 'content-type': 'application/json' },
  });
}

function isDescriptor(result) {
  return result != null
    && typeof result === 'object'
    && !Array.isArray(result)
    && (Object.hasOwn(result, 'body')
      || Object.hasOwn(result, 'json')
      || Object.hasOwn(result, 'text')
      || Object.hasOwn(result, 'headers')
      || typeof result.status === 'number');
}
