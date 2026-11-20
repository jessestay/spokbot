// One-shot smoke test: boot the embedded Hatchet sidecar through the SDK exactly
// as the engine does, report the handshake, stop cleanly. No engine, no Slack.
const path = require('path');
const { startEmbeddedSidecar } = require(path.join(__dirname, 'slack-agents', 'node_modules', '@hatchet-dev', 'typescript-sdk', 'v1', 'embedded'));
(async () => {
  const sc = await startEmbeddedSidecar({ version: 'v0.110.5' });
  console.log('SIDECAR_UP grpc=' + sc.grpcAddress + ' api=' + sc.apiUrl + ' tenant=' + sc.tenantId);
  await sc.stop();
  console.log('SIDECAR_STOPPED_CLEAN');
  process.exit(0);
})().catch((e) => { console.error('SMOKE_FAIL', e && e.message); process.exit(1); });
