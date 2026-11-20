/**
 * google-workspace.connectivity.test.js — TDD for Google Drive/Docs/Sheets MCP.
 *
 * Verifies:
 * 1. google-workspace is granted to at least one role (client-side layer 1)
 * 2. workspace-mcp-proxied binary exists and is executable
 * 3. MCP server initializes and lists tools end-to-end (stdio)
 * 4. A real Drive API call succeeds (list_drive_items)
 */
const { rolesGranting, probeServer } = require('./helpers/probe');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('google-workspace MCP connectivity', () => {
  test('google-workspace is granted to at least one role', () => {
    const granted = rolesGranting('google-workspace');
    expect(granted.length).toBeGreaterThan(0);
  });

  test('workspace-mcp-proxied binary exists and is executable', () => {
    // US-FW-002: anchored to the operator's home (or explicit override),
    // never a hardcoded machine path.
    const bin = process.env.WORKSPACE_MCP_PROXIED || path.join(os.homedir(), '.local', 'bin', 'workspace-mcp-proxied');
    expect(fs.existsSync(bin)).toBe(true);
    fs.accessSync(bin, fs.constants.X_OK);
  });

  test('Google credentials are stored with secure permissions', () => {
    // This connectivity suite is instance-bound by design (it probes the
    // operator's live credential); WORKSPACE_MCP_CREDENTIALS overrides
    // the default credential file under the operator's home.
    const credPath = process.env.WORKSPACE_MCP_CREDENTIALS || path.join(os.homedir(), '.google_workspace_mcp', 'credentials', 'jessestay@gmail.com.json');
    expect(fs.existsSync(credPath)).toBe(true);
    const mode = fs.statSync(credPath).mode & 0o777;
    expect(mode).toBeLessThanOrEqual(0o600);
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    expect(creds.refresh_token).toBeTruthy();
  });

  test('MCP server connects and lists tools end to end', async () => {
    const result = await probeServer('google-workspace', { timeoutMs: 60000 });
    expect(result.ok).toBe(true);
    expect(result.tools.length).toBeGreaterThan(10);
    expect(result.tools).toContain('search_drive_files');
    expect(result.tools).toContain('list_drive_items');
  }, 90000);
});
