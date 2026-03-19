const http = require('http');
const payload = JSON.stringify({
  resourceSpans: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'test' } }] },
    scopeSpans: [{
      scope: { name: 'test' },
      spans: [{
        traceId: 'a1b2c3d4e5f60000a1b2c3d4e5f60001',
        spanId: '1234567890abcdef',
        name: 'test-span',
        kind: 1,
        startTimeUnixNano: String(Date.now() * 1000000),
        endTimeUnixNano: String((Date.now() + 100) * 1000000),
        status: { code: 1 }
      }]
    }]
  }]
});

const req = http.request({
  hostname: 'otel-collector.agent-warden-system.svc.cluster.local',
  port: 4318,
  path: '/v1/traces',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
}, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => console.log('Status:', res.statusCode, d));
});
req.on('error', e => console.log('Error:', e.message));
req.write(payload);
req.end();
